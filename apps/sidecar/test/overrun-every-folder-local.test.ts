import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isNull } from "drizzle-orm";
import {
  ImapAdapter, ImapBoundExceeded, isImapBoundExceeded,
  type FetchedPart, type MailboxAdapter, type NativeLocator, type SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, LeasePeekIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { mailboxes, messages } from "@trafficflow/db";
import { createLogger } from "@trafficflow/core/mail";
import { createSidecar, type AdapterDialContext, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 3 });

/**
 * THE DESKTOP ENGINE KEEPS SYNCING PAST AN OVERRUN IN A FOLDER OUTSIDE THE SIX (REVIEW-026 HIGH 1).
 * The real ImapAdapter over a scripted server at the client seam, the lease in memory: Archive's
 * liar declares RFC822.SIZE 10 and streams 2 MiB on the folder's first pass, then new INBOX mail
 * arrives. The message is set aside once and the mailbox is reachable again.
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

const FOLDERS = ["INBOX", "ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"];
const eml = (id: string): Buffer => Buffer.from([
  "From: Anna <anna@sender.test>", "To: owner@trafficflow.test", `Subject: ${id}`,
  "Date: Wed, 30 Sep 2026 12:00:00 +0000", `Message-ID: <${id}@lane.test>`, "", `Body of ${id}.`, "",
].join("\r\n"));

function server() {
  const overrun = Buffer.alloc(2 * 1024 * 1024, 0x61);
  type Msg = { id: string; raw: Buffer; declared: number };
  const ordinary = (id: string): Msg => ({ id, raw: eml(id), declared: eml(id).length });
  const folders = new Map<string, { uidValidity: bigint; msgs: Map<number, Msg> }>([
    ["INBOX", { uidValidity: 100n, msgs: new Map([[1, ordinary("inbox-1")]]) }],
    ["Archive", { uidValidity: 300n, msgs: new Map([[1, ordinary("archive-1")], [9, { id: "the-liar", raw: overrun, declared: 10 }]]) }],
  ]);
  const state = { overrunBodies: 0, folders };
  const client = () => {
    let path = "INBOX";
    const msgsOf = (p: string) => folders.get(p)?.msgs ?? new Map<number, Msg>();
    const parseSet = (range: unknown): number[] => {
      const all = [...msgsOf(path).keys()].sort((a, b) => a - b);
      if (Array.isArray(range)) return range.map(Number).filter((u) => msgsOf(path).has(u));
      if (typeof range !== "string") return all;
      const out = new Set<number>();
      for (const part of range.split(",")) {
        const [lo, hi] = part.split(":");
        const a = lo === "*" ? Number.MAX_SAFE_INTEGER : Number(lo);
        const b = hi === undefined ? a : hi === "*" ? Number.MAX_SAFE_INTEGER : Number(hi);
        for (const u of all) if (u >= Math.min(a, b) && u <= Math.max(a, b)) out.add(u);
      }
      return [...out].sort((x, y) => x - y);
    };
    const c = {
      usable: true,
      capabilities: new Map<string, boolean>([["MOVE", true], ["UIDPLUS", true], ["IDLE", true]]),
      mailbox: undefined as unknown,
      async list() { return [...FOLDERS, "Archive"].map((p) => ({ path: p, name: p.split("/").pop()!, delimiter: "/", flags: new Set<string>() })); },
      async mailboxCreate(p: string) { return { path: p }; },
      async getMailboxLock(p: string) {
        path = p;
        const f = folders.get(p);
        const keys = f ? [...f.msgs.keys()] : [];
        c.mailbox = { path: p, uidValidity: f?.uidValidity ?? 7n, uidNext: Math.max(0, ...keys) + 1, highestModseq: 0n, exists: keys.length };
        return { path: p, release() { /* nothing */ } };
      },
      async search() { return []; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async *fetch(range: any, query: any) {
        for (const uid of parseSet(range)) {
          const m = msgsOf(path).get(uid)!;
          if (query?.source) {
            if (m.id === "the-liar") state.overrunBodies++;
            yield { uid, flags: new Set<string>(), envelope: { messageId: `<${m.id}@lane.test>` }, source: m.raw, internalDate: new Date(Date.UTC(2026, 8, 30) + uid * 1000) };
          } else if (query?.size) yield { uid, size: m.declared };
          else if (query?.headers) yield { uid, headers: Buffer.from(`Message-ID: <${m.id}@lane.test>\r\n`) };
          else if (query?.internalDate) yield { uid, internalDate: new Date(Date.UTC(2026, 8, 30) + uid * 1000), envelope: {} };
          else if (query?.flags) yield { uid, flags: new Set<string>() };
          else yield { uid };
        }
      },
      async messageMove() { return { uidValidity: 100n, uidMap: new Map<number, number>() }; },
      async messageCopy() { return { uidValidity: 100n, uidMap: new Map<number, number>() }; },
      async messageDelete() { return true; },
      async logout() { /* nothing */ },
      close() { /* nothing */ },
      on() { /* no events */ },
    };
    return c;
  };
  return { state, client };
}

function rig(s: ReturnType<typeof server>) {
  const meta = new MemoryMeta();
  const counts = { logins: 0, staleCalls: 0 };
  const factory = (_cfg: unknown, ctx: AdapterDialContext): MailboxAdapter & { leaseIo(): LeaseIo; leasePeekIo(): LeasePeekIo } => {
    let retired: ImapBoundExceeded | null = null;
    const real = new ImapAdapter({ host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } }, {
      client: s.client() as never,
      onConnectionError: (e) => { if (isImapBoundExceeded(e)) retired = e; ctx.onConnectionError(e); },
    });
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
      async connect(): Promise<void> { counts.logins++; await real.connect(); },
      async close(): Promise<void> { await real.close(); },
      forceClose: () => real.forceClose(),
      capabilities: () => real.capabilities(),
      async ensureFolders(): Promise<void> { usable(); },
      changesSince: (c) => real.changesSince(c),
      fetchByUid: (f, u, o) => real.fetchByUid(f, u, o),
      async move(_l: NativeLocator, toFolder: string): Promise<NativeLocator> { usable(); return { folder: toFolder, ref: "200:9" }; },
      async setFlags(): Promise<void> { usable(); },
      async scanSentRecipients(): Promise<string[]> { usable(); return []; },
      async watch(): Promise<() => Promise<void>> { usable(); return async () => {}; },
      async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart in this rig"); },
      async send(): Promise<SendResult> { throw new Error("no send in this rig"); },
    } as MailboxAdapter & { leaseIo(): LeaseIo; leasePeekIo(): LeasePeekIo };
  };
  return { factory, counts };
}

describe("the local engine, an overrun in a folder outside the six", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); vi.restoreAllMocks(); });
  let skewMs = 0;
  const realNow = Date.now.bind(Date);

  async function boot(r: ReturnType<typeof rig>) {
    skewMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skewMs);
    const dataDir = await freshDataDir("ohmail-overrun-local-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const events: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const s: Sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "pw" } },
      address: "owner@trafficflow.test", machineName: "the machine under test",
      pollIntervalMs: 60 * 60 * 60_000, leaseStaleAfterMs: 60_000, keks: { 1: Buffer.alloc(32, 7) },
      adapterFactory: r.factory,
      log: (event, detail) => { events.push({ event, detail: (detail ?? {}) as Record<string, unknown> }); },
      logger: createLogger({ service: "sidecar", sink: (line) => {
        const l = JSON.parse(line) as { event: string };
        events.push({ event: l.event, detail: l as unknown as Record<string, unknown> });
      } }),
    });
    cleanups.push(async () => { await s.stop().catch(() => undefined); });
    await s.db.update(mailboxes).set({ organizeConsentedAt: new Date(), organizerRole: "organizer" }).where(isNull(mailboxes.organizeConsentedAt));
    await s.start().catch(() => undefined);
    const cycle = async (): Promise<void> => { await s.syncMailbox(s.world.mailboxId).catch(() => undefined); };
    const connection = async (): Promise<{ reachable: boolean; setAside: number }> => {
      const res = await s.handle(new Request("http://local/local/mailboxes/connections", { method: "GET", headers: { authorization: `Bearer ${s.sessionToken}` } }));
      return ((await res.json()) as { items: Array<{ reachable: boolean; setAside: number }> }).items[0]!;
    };
    const count = (e: string): number => events.filter((x) => x.event === e).length;
    const subjects = async (): Promise<string[]> => (await s.db.select({ subject: messages.subject }).from(messages)).map((x) => x.subject ?? "").sort();
    return { cycle, connection, count, subjects };
  }

  it("Archive: the liar on the folder's first pass is set aside once, and new INBOX mail arrives", async () => {
    const s = server();
    const r = rig(s);
    const { cycle, connection, count, subjects } = await boot(r);   // launch: breach in Archive
    s.state.folders.get("INBOX")!.msgs.set(2, { id: "inbox-new-mail", raw: eml("inbox-new-mail"), declared: eml("inbox-new-mail").length });
    for (let i = 0; i < 8; i++) { skewMs += 400_000; await cycle(); }  // past every ladder step
    const after = {
      overrun: s.state.overrunBodies, logins: r.counts.logins, reconnectFailed: count("mailbox_reconnect_failed"),
      reconnected: count("mailbox_reconnected"), deferred: count("mailbox_redial_deferred"),
      conn: await connection(), subjects: await subjects(),
    };
    expect(after.subjects).toContain("inbox-new-mail");
    expect(after.overrun, "the set-aside message was fetched again").toBe(1);
    expect(after.reconnected).toBe(1);
    expect(after.conn).toMatchObject({ reachable: true, setAside: 1 });
  });
});
