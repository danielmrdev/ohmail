import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isNull } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapCursor, MailboxAdapter, NativeLocator, SendResult,
  TargetedFetch,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, LeasePeekIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { createLogger } from "@trafficflow/core/mail";
import { mailboxes, messageFailures, messages } from "@trafficflow/db";
import { createSidecar, engineBuildLabel, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 3 });

/**
 * THE LOCAL DOORS' LEDGER, AS THE SHELL RUNS IT. (L1) Twelve messages refused on every attempt are
 * written off one cycle's cap at most and then held, and the mailbox list says "storage" rather than
 * reading healthy. (L2) A message the device could not store, written off under one build, is read
 * again by the next build — the engine's own build identity is the loop's version label.
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
  uidValidity(): number | bigint | null { return 4_300; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(installId)).map((c) => ({ ...c }));
  }
}

const eml = (id: string): Buffer => Buffer.from([
  "From: Anna <anna@sender.test>", "To: owner@trafficflow.test", `Subject: ${id}`,
  "Date: Wed, 30 Sep 2026 12:00:00 +0000", `Message-ID: <${id}@lane.test>`, "", `Body of ${id}.`, "",
].join("\r\n"));

/** INBOX holds `count` messages, uids 1..count; `refuse(uid)` answers the throw its bytes raise. */
function mailbox(count: number, refuse: (uid: number) => unknown) {
  const meta = new MemoryMeta();
  const create = (uid: number) => {
    const c = { type: "create" as const, locator: { folder: "INBOX", ref: `4300:${uid}` }, seen: false };
    Object.defineProperty(c, "raw", {
      enumerable: true,
      get: () => { const err = refuse(uid); if (err !== null) throw err; return eml(`message-${uid}`); },
    });
    return c;
  };
  return (): MailboxAdapter & { leaseIo(): LeaseIo; leasePeekIo(): LeasePeekIo } => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: async () => meta.listClaims() }),
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(c: ImapCursor): Promise<ChangeBatch> {
      const known = new Set((c.folders.INBOX?.known ?? []).map((k) => k.uid));
      const creates = Array.from({ length: count }, (_, i) => i + 1).filter((u) => !known.has(u)).map(create);
      return {
        creates, moves: [], flagChanges: [], deletes: [],
        newCursor: { folders: { INBOX: { uidValidity: "4300", uidNext: count + 1, highestModseq: "0" } } },
      } as unknown as ChangeBatch;
    },
    async fetchByUid(_folder: string, uids: readonly number[]): Promise<TargetedFetch> {
      return { uidValidity: "4300", creates: uids.map(create) as unknown as TargetedFetch["creates"], absent: [], oversize: [] };
    },
    async move(_l: NativeLocator, toFolder: string): Promise<NativeLocator> { return { folder: toFolder, ref: "4300:99" }; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart in this rig"); },
    async send(): Promise<SendResult> { throw new Error("no send in this rig"); },
  });
}

describe("the local doors' write-offs", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  async function boot(dataDir: string, adapterFactory: ReturnType<typeof mailbox>, buildCommit?: string) {
    const events: string[] = [];
    const s: Sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "pw" } },
      address: "owner@trafficflow.test", machineName: "the machine under test",
      pollIntervalMs: 40, leaseStaleAfterMs: 60_000, keks: { 1: Buffer.alloc(32, 9) },
      adapterFactory,
      ...(buildCommit !== undefined ? { buildCommit } : {}),
      log: (event) => { events.push(event); },
      logger: createLogger({ service: "sidecar", sink: (line) => { events.push((JSON.parse(line) as { event: string }).event); } }),
    });
    await s.db.update(mailboxes).set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
      .where(isNull(mailboxes.organizeConsentedAt));
    await s.start().catch(() => undefined);
    const count = (e: string) => events.filter((x) => x === e).length;
    return { s, count };
  }
  const fresh = async () => {
    const dir = await freshDataDir("ohmail-write-off-backstop-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  it("(L1) twelve messages refused every attempt: one cycle's cap is written off, then held, and the list says storage", async () => {
    const { s, count } = await boot(await fresh(), mailbox(12, () => new Error("a pipeline defect refuses every message")));
    cleanups.push(async () => { await s.stop().catch(() => undefined); });
    await vi.waitFor(() => { expect(count("sync_write_offs_held")).toBe(1); }, { timeout: 30_000, interval: 25 });
    await vi.waitFor(() => { expect(count("sync_message_deferred")).toBeGreaterThan(20); }, { timeout: 30_000, interval: 25 });
    expect(count("sync_message_skipped")).toBe(5);
    expect((await s.db.select({ uid: messageFailures.uid }).from(messageFailures)).length).toBe(5);
    const auth = { authorization: `Bearer ${s.sessionToken}` };
    const conn = await (await s.handle(new Request("http://local/local/mailboxes/connections", { headers: auth }))).json() as
      { items: Array<{ reachable: boolean }> };
    expect(conn.items[0]!.reachable).toBe(true);
    const rows = await (await s.handle(new Request("http://local/mailboxes", { headers: auth }))).json() as
      { items: Array<{ status: string; errorCode: string | null }> };
    expect(rows.items.map((r) => [r.status, r.errorCode])).toEqual([["error", "storage"]]);
    expect(s.connectionStates()[Object.keys(s.connectionStates())[0]!]!.writeOffsHeldSince).toBeInstanceOf(Date);
  });

  it("(L1) the hold lives in the store: a relaunch of the same build is held at once and writes nothing more off", async () => {
    const dir = await fresh();
    const refuseAll = () => new Error("a pipeline defect refuses every message");
    const first = await boot(dir, mailbox(12, refuseAll), "build-1");
    await vi.waitFor(() => { expect(first.count("sync_write_offs_held")).toBe(1); }, { timeout: 30_000, interval: 25 });
    await first.s.stop();

    const again = await boot(dir, mailbox(12, refuseAll), "build-1");
    cleanups.push(async () => { await again.s.stop().catch(() => undefined); });
    await vi.waitFor(() => { expect(again.count("sync_message_deferred")).toBeGreaterThan(12); }, { timeout: 30_000, interval: 25 });
    const id = Object.keys(again.s.connectionStates())[0]!;
    expect(again.s.connectionStates()[id]!.writeOffsHeldSince).toBeInstanceOf(Date);
    expect(again.count("sync_message_skipped")).toBe(0);
    expect((await again.s.db.select({ uid: messageFailures.uid }).from(messageFailures)).length).toBe(5);
  });

  it("(L1) a new build lifts the hold, and a fixed one stores the mail it had set aside", async () => {
    const dir = await fresh();
    const first = await boot(dir, mailbox(12, () => new Error("a pipeline defect refuses every message")), "build-1");
    await vi.waitFor(() => { expect(first.count("sync_write_offs_held")).toBe(1); }, { timeout: 30_000, interval: 25 });
    await first.s.stop();
    const fixed = await boot(dir, mailbox(12, () => null), "build-2");
    cleanups.push(async () => { await fixed.s.stop().catch(() => undefined); });
    await vi.waitFor(async () => {
      expect((await fixed.s.db.select({ subject: messages.subject }).from(messages)).length).toBe(12);
    }, { timeout: 30_000, interval: 50 });
    const id = Object.keys(fixed.s.connectionStates())[0]!;
    expect(fixed.s.connectionStates()[id]!.writeOffsHeldSince ?? null).toBeNull();
  });

  it("(L2) a message the device could not store is read again by the next build, and healed", async () => {
    const dir = await fresh();
    const mismatch = () => Object.assign(new Error("Call to function 'NativeStatement.runAsync' has been rejected.\n→ Caused by: Error code \u0014: datatype mismatch"), { code: "ERR_INTERNAL_SQLITE_ERROR" });
    const first = await boot(dir, mailbox(2, (uid) => (uid === 1 ? mismatch() : null)), "build-1");
    await vi.waitFor(() => { expect(first.count("sync_message_skipped")).toBe(1); }, { timeout: 30_000, interval: 25 });
    const written = await first.s.db.select({ v: messageFailures.attemptedVersion, code: messageFailures.code }).from(messageFailures);
    expect(written).toEqual([{ v: "build-1", code: "data_exception" }]);
    await first.s.stop();

    const second = await boot(dir, mailbox(2, () => null), "build-2");
    cleanups.push(async () => { await second.s.stop().catch(() => undefined); });
    await vi.waitFor(async () => {
      const subjects = (await second.s.db.select({ subject: messages.subject }).from(messages)).map((r) => r.subject).sort();
      expect(subjects).toEqual(["message-1", "message-2"]);
    }, { timeout: 30_000, interval: 50 });
    const [row] = await second.s.db.select({ resolvedAt: messageFailures.resolvedAt }).from(messageFailures);
    expect(row!.resolvedAt).toBeInstanceOf(Date);
  });

  it("(L2) CONTROL: the same build label on the relaunch does not read it again", async () => {
    const dir = await fresh();
    const mismatch = () => Object.assign(new Error("Error code 20: datatype mismatch"), { code: "ERR_INTERNAL_SQLITE_ERROR" });
    const first = await boot(dir, mailbox(2, (uid) => (uid === 1 ? mismatch() : null)), "build-1");
    await vi.waitFor(() => { expect(first.count("sync_message_skipped")).toBe(1); }, { timeout: 30_000, interval: 25 });
    await first.s.stop();
    const second = await boot(dir, mailbox(2, () => null), "build-1");
    cleanups.push(async () => { await second.s.stop().catch(() => undefined); });
    await vi.waitFor(() => { expect(second.count("sync_drain")).toBeGreaterThan(2); }, { timeout: 30_000, interval: 25 });
    const subjects = (await second.s.db.select({ subject: messages.subject }).from(messages)).map((r) => r.subject);
    expect(subjects).toEqual(["message-2"]);
  });

  it("the label: the commit, else the app version the bundle carries, never `dev`, `unknown` or blank", () => {
    expect([engineBuildLabel("abc123", "0.25.10"), engineBuildLabel(" ", "0.25.10"), engineBuildLabel(undefined, "0.25.10"),
      engineBuildLabel("unknown", "0.25.10"), engineBuildLabel("dev", "0.25.10")])
      .toEqual(["abc123", "0.25.10", "0.25.10", "0.25.10", "0.25.10"]);
    /* Unbundled (a dev run from source) there is no version either: no label, the loop's own `dev`. */
    expect([engineBuildLabel(undefined, undefined), engineBuildLabel("unknown", " ")]).toEqual([null, null]);
  });
});
