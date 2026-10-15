import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isNull } from "drizzle-orm";
import {
  ImapBoundExceeded,
  type ChangeBatch, type FetchedPart, type ImapCapabilities, type ImapCursor, type MailboxAdapter,
  type NativeLocator, type SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, LeasePeekIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { mailboxes, messages } from "@trafficflow/db";
import { createLogger } from "@trafficflow/core/mail";
import { createSidecar, type AdapterDialContext, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 2 });

/**
 * A READ BOUND THAT BREACHES ON ONE MESSAGE, EVERY TIME (the set-aside walk, 2026-10-07). The
 * runtime re-dialled once, the re-dial's own connection was retired by the same breach inside its
 * gate, that death was swallowed and every later cycle failed in milliseconds over the retired
 * adapter until a restart. The doubles model the real adapter: a breach reports itself once through
 * `onConnectionError`, and every later call on that connection rethrows it.
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

/**
 * INBOX holds uid 1, whose fetch crosses `body_overrun` on every connection, and two ordinary
 * messages. `named` decides whether the breach names uid 1 (a per-message overrun) or no message
 * (the batch total), which is what separates the set-aside from the re-dial decision.
 */
function mailbox(named: boolean) {
  const meta = new MemoryMeta();
  /** `staleCalls`: any command asked of a connection a breach had already retired. */
  const counts = { logins: 0, overrunFetches: 0, staleCalls: 0 };
  const factory = (_cfg: unknown, ctx: AdapterDialContext): MailboxAdapter & { leaseIo(): LeaseIo; leasePeekIo(): LeasePeekIo } => {
    let retired: ImapBoundExceeded | null = null;
    const usable = (): void => { if (retired !== null) { counts.staleCalls++; throw retired; } };
    const io: LeaseIo = {
      ensureMetaFolder: async () => { usable(); },
      listClaims: async () => { usable(); return meta.listClaims(); },
      appendClaim: async (raw) => { usable(); await meta.appendClaim(raw); },
      removeClaims: async (refs) => { usable(); await meta.removeClaims(refs); },
      uidValidity: () => meta.uidValidity(),
      findOwnRecords: async (id) => { usable(); return meta.findOwnRecords(id); },
    };
    return {
      leaseIo: () => io,
      leasePeekIo: () => ({ listClaims: async () => { usable(); return meta.listClaims(); } }),
      async connect(): Promise<void> { counts.logins++; },
      async close(): Promise<void> {},
      async capabilities(): Promise<ImapCapabilities> {
        usable();
        return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
      },
      async ensureFolders(): Promise<void> { usable(); },
      async changesSince(c: ImapCursor): Promise<ChangeBatch> {
        usable();
        const known = new Set((c.folders.INBOX?.known ?? []).map((k) => k.uid));
        // The adapter's contract: a set-aside row at the live epoch is never fetched again.
        const aside = (c.setAside ?? []).some((a) => a.folder === "INBOX" && a.uidValidity === "4200" && a.uid === 1);
        if (!aside) {
          counts.overrunFetches++;
          const breach = new ImapBoundExceeded(
            "body_overrun", 1_048_576, 1_600_000, "INBOX", named ? { uidValidity: "4200", uid: 1 } : undefined,
          );
          retired = breach;
          ctx.onConnectionError(breach);
          // A breach naming its message stops the pass and returns; one naming none throws.
          if (!named) throw breach;
          return {
            creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} }, hasBacklog: true,
            overrun: { folder: "INBOX", uidValidity: "4200", uid: 1, breach },
          } as unknown as ChangeBatch;
        }
        const creates = [2, 3].filter((u) => !known.has(u)).map((u) => ({
          type: "create" as const, locator: { folder: "INBOX", ref: `4200:${u}` }, seen: false, raw: eml(`ordinary-${u}`),
        }));
        return {
          creates, moves: [], flagChanges: [], deletes: [],
          newCursor: { folders: { INBOX: { uidValidity: "4200", uidNext: 4, highestModseq: "0" } } },
        } as unknown as ChangeBatch;
      },
      async move(_l: NativeLocator, toFolder: string): Promise<NativeLocator> { usable(); return { folder: toFolder, ref: "4200:9" }; },
      async setFlags(): Promise<void> { usable(); },
      async scanSentRecipients(): Promise<string[]> { usable(); return []; },
      async watch(): Promise<() => Promise<void>> { usable(); return async () => {}; },
      async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart in this rig"); },
      async send(): Promise<SendResult> { throw new Error("no send in this rig"); },
    };
  };
  return { factory, counts };
}

describe("a read bound that breaches on one message, on the local engine", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); vi.restoreAllMocks(); });

  /** The ladder reads `Date.now()`; the clock is moved forward rather than waited out. */
  let skewMs = 0;
  const realNow = Date.now.bind(Date);

  async function boot(rig: ReturnType<typeof mailbox>) {
    skewMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skewMs);
    const dataDir = await freshDataDir("ohmail-bound-breach-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const events: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const s: Sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "pw" } },
      address: "owner@trafficflow.test",
      machineName: "the machine under test",
      // Every cycle below is one this test asked for; the timer never fires on its own.
      pollIntervalMs: 60 * 60 * 60_000,
      leaseStaleAfterMs: 60_000,
      keks: { 1: Buffer.alloc(32, 7) },
      adapterFactory: rig.factory,
      log: (event, detail) => { events.push({ event, detail: (detail ?? {}) as Record<string, unknown> }); },
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
    const cycle = async (): Promise<void> => { await s.syncMailbox(s.world.mailboxId).catch(() => undefined); };
    const connection = async (): Promise<{ reachable: boolean; setAside: number }> => {
      const res = await s.handle(new Request("http://local/local/mailboxes/connections", {
        method: "GET", headers: { authorization: `Bearer ${s.sessionToken}` },
      }));
      return ((await res.json()) as { items: Array<{ reachable: boolean; setAside: number }> }).items[0]!;
    };
    const count = (e: string): number => events.filter((x) => x.event === e).length;
    const seen = (e: string): Array<Record<string, unknown>> => events.filter((x) => x.event === e).map((x) => x.detail);
    const subjects = async (): Promise<string[]> =>
      (await s.db.select({ subject: messages.subject }).from(messages)).map((r) => r.subject ?? "").sort();
    return { s, cycle, connection, count, seen, subjects };
  }

  it("sets the message aside on the first breach, re-dials once, and syncs the rest", async () => {
    const rig = mailbox(true);
    const { cycle, connection, count, subjects } = await boot(rig);
    for (let i = 0; i < 4; i++) await cycle();
    // First, because it is the defect's signature: cycles failing at once over the retired adapter.
    expect(rig.counts.staleCalls, "a connection the breach had retired was asked again").toBe(0);
    expect(count("sync_message_skipped"), "the first breach set nothing aside").toBe(1);
    expect(rig.counts.overrunFetches, "the re-dial fetched the breaching message again").toBe(1);
    expect(rig.counts.logins, "one launch and one re-dial").toBe(2);
    expect(count("mailbox_reconnected")).toBe(1);
    expect(await subjects()).toEqual(["ordinary-2", "ordinary-3"]);
    expect(await connection()).toMatchObject({ reachable: true, setAside: 1 });
  });

  it("a re-dial whose own connection is retired in its gate is not a reconnect: it climbs the ladder and dials again", async () => {
    const rig = mailbox(false);
    const { cycle, connection, count, seen } = await boot(rig);
    await cycle();                                     // the re-dial; its gate breaches again
    const afterRedial = {
      logins: rig.counts.logins, reconnected: count("mailbox_reconnected"),
      failed: count("mailbox_reconnect_failed"), deaths: count("mailbox_connection_unavailable"),
    };
    await cycle();                                     // inside the ladder's wait: no dial, no drain
    const inWait = rig.counts.logins;
    skewMs += 20_000;                                  // past the first 15 s step and its jitter
    await cycle();
    const afterFirstStep = rig.counts.logins;
    skewMs += 20_000;                                  // inside the second, 30 s step (24-36 s)
    await cycle();
    const inSecondStep = rig.counts.logins;
    skewMs += 20_000;                                  // past it
    await cycle();
    expect(rig.counts.staleCalls, "a connection the breach had retired was asked again").toBe(0);
    expect(afterRedial).toEqual({ logins: 2, reconnected: 0, failed: 1, deaths: 2 });
    expect(inWait, "a cycle inside the ladder's wait dialled").toBe(2);
    expect(afterFirstStep, "the ladder never let the next re-dial through").toBe(3);
    expect(inSecondStep, "the ladder did not widen to its second step").toBe(3);
    expect(rig.counts.logins).toBe(4);
    expect(seen("mailbox_reconnect_failed").map((d) => d.attempt)).toEqual([1, 2, 3]);
    expect(count("mailbox_redial_deferred")).toBeGreaterThanOrEqual(3);
    expect((await connection()).reachable).toBe(false);
  });

  /* FIRST-PAGE-GATE-WAITS-OUT-A-CLOCK-STEP, the ladder's half: a wall clock stepped back 19 minutes
     inside the ladder's wait must not hold the next re-dial for the step. */
  it("a wall clock stepped back inside the ladder's wait delays the re-dial by at most its own step", async () => {
    const rig = mailbox(false);
    const { cycle } = await boot(rig);
    await cycle();                                     // the re-dial; its gate breaches; step 1 (12-18 s)
    expect(rig.counts.logins, "the case never reached the ladder").toBe(2);
    skewMs -= 19 * 60_000;
    await cycle();                                     // inside the wait, now 19 min behind it
    expect(rig.counts.logins, "a cycle inside the ladder's wait dialled").toBe(2);
    skewMs += 20_000;                                  // past the step, measured from the step back
    await cycle();
    expect(rig.counts.logins, "the re-dial waited out the clock step").toBe(3);
  });

  it("CONTROL: on a clock that only moves forward the ladder keeps its first step", async () => {
    const rig = mailbox(false);
    const { cycle } = await boot(rig);
    await cycle();
    skewMs += 10_000;                                  // inside the 12-18 s step
    await cycle();
    expect(rig.counts.logins, "the ladder let a re-dial through inside its first step").toBe(2);
    skewMs += 10_000;
    await cycle();
    expect(rig.counts.logins).toBe(3);
  });
});
