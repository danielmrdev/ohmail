import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isNull } from "drizzle-orm";
import {
  ImapConnectionClosedError,
  type ChangeBatch, type FetchedPart, type ImapCapabilities, type ImapCursor, type MailboxAdapter,
  type NativeLocator, type SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, LeasePeekIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { mailboxes, messages } from "@trafficflow/db";
import { createLogger } from "@trafficflow/core/mail";
import { createSidecar, drainFailureKeepsTheLogin, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 2 });

/**
 * ONE MESSAGE THAT KEEPS FAILING NEVER STOPS THE LOCAL ENGINE'S MAILBOX. The desktop's and the
 * phone's engine fed the loop no failure ledger, so a failing message was on its first attempt every
 * cycle and held its folder; and the launch called the first drain's failure a dead connection,
 * closed the login and showed "Couldn't reconnect" over a server that answered. Here a message
 * whose bytes throw when read is written off by the second drain, over the ONE login the launch
 * opened, with no outage recorded — and a dead socket at the same point is still an outage.
 */
class MemoryMeta implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
  }
  uidValidity(): number | bigint | null { return 4_200; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(installId)).map((c) => ({ ...c }));
  }
}

const eml = (id: string): Buffer => Buffer.from([
  "From: Anna <anna@sender.test>", "To: owner@trafficflow.test", `Subject: ${id}`,
  "Date: Wed, 30 Sep 2026 12:00:00 +0000", `Message-ID: <${id}@lane.test>`, "", `Body of ${id}.`, "",
].join("\r\n"));

/** INBOX holds a message whose bytes throw on every read (uid 1) and an ordinary one (uid 2). */
function mailbox(opts: { deadSocket?: boolean } = {}) {
  const meta = new MemoryMeta();
  const counts = { logins: 0, offeredVictim: 0 };
  const factory = (): MailboxAdapter & { leaseIo(): LeaseIo; leasePeekIo(): LeasePeekIo } => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: async () => meta.listClaims() }),
    async connect(): Promise<void> { counts.logins++; },
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(c: ImapCursor): Promise<ChangeBatch> {
      if (opts.deadSocket) throw new ImapConnectionClosedError();
      const known = new Set((c.folders.INBOX?.known ?? []).map((k) => k.uid));
      const creates = [];
      if (!known.has(1)) {
        counts.offeredVictim++;
        const victim = { type: "create" as const, locator: { folder: "INBOX", ref: "4200:1" }, seen: false };
        Object.defineProperty(victim, "raw", { enumerable: true, get: () => { throw new Error("the bytes of this message could not be read"); } });
        creates.push(victim);
      }
      if (!known.has(2)) creates.push({ type: "create" as const, locator: { folder: "INBOX", ref: "4200:2" }, seen: false, raw: eml("ordinary") });
      return {
        creates, moves: [], flagChanges: [], deletes: [],
        newCursor: { folders: { INBOX: { uidValidity: "4200", uidNext: 3, highestModseq: "0" } } },
      } as unknown as ChangeBatch;
    },
    async move(_l: NativeLocator, toFolder: string): Promise<NativeLocator> { return { folder: toFolder, ref: "4200:9" }; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart in this rig"); },
    async send(): Promise<SendResult> { throw new Error("no send in this rig"); },
  });
  return { factory, counts };
}

describe("one message that keeps failing, on the local engine", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  async function boot(rig: ReturnType<typeof mailbox>) {
    const dataDir = await freshDataDir("ohmail-one-message-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const events: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const s: Sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "pw" } },
      address: "owner@trafficflow.test",
      machineName: "the machine under test",
      pollIntervalMs: 40,
      leaseStaleAfterMs: 60_000,
      keks: { 1: Buffer.alloc(32, 7) },
      adapterFactory: rig.factory,
      log: (event, detail) => { events.push({ event, detail: (detail ?? {}) as Record<string, unknown> }); },
      // The sync loop's own lines (deferred, skipped) go to the logger, as they do on a device.
      logger: createLogger({ service: "sidecar", sink: (line) => {
        const l = JSON.parse(line) as { event: string };
        events.push({ event: l.event, detail: l as unknown as Record<string, unknown> });
      } }),
    });
    cleanups.push(async () => { await s.stop().catch(() => undefined); });
    await s.db.update(mailboxes)
      .set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
      .where(isNull(mailboxes.organizeConsentedAt));
    await s.start().catch(() => undefined);
    const connection = async (): Promise<{ reachable: boolean; unreachableSince: string | null }> => {
      const res = await s.handle(new Request("http://local/local/mailboxes/connections", {
        method: "GET", headers: { authorization: `Bearer ${s.sessionToken}` },
      }));
      return ((await res.json()) as { items: Array<{ reachable: boolean; unreachableSince: string | null }> }).items[0]!;
    };
    return { s, events, connection, has: (e: string) => events.some((x) => x.event === e) };
  }

  it("is written off by the second drain over the launch's one login, and nothing calls it an outage", async () => {
    const rig = mailbox();
    const { s, events, connection, has } = await boot(rig);
    await vi.waitFor(() => { expect(has("sync_message_skipped")).toBe(true); }, { timeout: 20_000, interval: 20 });
    expect(has("mailbox_start_failed"), "the launch still reports its failed first drain").toBe(true);
    expect(has("mailbox_connection_unavailable")).toBe(false);
    expect(rig.counts.logins).toBe(1);
    expect(await connection()).toMatchObject({ reachable: true, unreachableSince: null });
    const offered = rig.counts.offeredVictim;
    await vi.waitFor(() => { expect(events.filter((e) => e.event === "sync_drain").length).toBeGreaterThan(2); }, { timeout: 20_000, interval: 20 });
    expect(rig.counts.offeredVictim, "a written-off message is not re-offered every cycle").toBe(offered);
    const rows = await s.db.select({ subject: messages.subject }).from(messages);
    expect(rows.map((r) => r.subject)).toEqual(["ordinary"]);
  });

  it("CONTROL: a socket that dies in the first drain is still an outage, and its login is closed", async () => {
    const rig = mailbox({ deadSocket: true });
    const { connection, has } = await boot(rig);
    await vi.waitFor(() => { expect(has("mailbox_connection_unavailable")).toBe(true); }, { timeout: 20_000, interval: 20 });
    expect((await connection()).reachable).toBe(false);
  });

  it("the split's classes: our own refusals and a gone mailbox close the login, a store fault keeps it", () => {
    const sqlite = Object.assign(new Error("Error code \u0013: CHECK constraint failed: x"), { code: "ERR_INTERNAL_SQLITE_ERROR" });
    const removed = Object.assign(new Error("gone"), { name: "MailboxRemovedError" });
    expect([sqlite, new Error("a bug"), removed, new ImapConnectionClosedError()].map(drainFailureKeepsTheLogin))
      .toEqual([true, true, false, false]);
  });
});
