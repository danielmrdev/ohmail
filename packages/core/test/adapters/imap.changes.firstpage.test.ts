import { describe, it, expect } from "vitest";
import { ImapAdapter, parseRef, uidSetChunks } from "../../src/adapters/imap.js";
import type { ImapConfig, ImapCursor } from "../../src/adapters/imap-types.js";

/**
 * A large first import lands its newest page inside the first pass.
 *
 * The pass dates every candidate before it orders them. On a large mailbox that read was dozens of
 * commands, it ran the pass past `cycle_deadline`, and the cycle ended having committed
 * nothing. The read is now packed into ranges, newest UID first, and stops once a page's worth
 * is dated and its per-pass time is spent; the cache carries the rest into the next pass.
 */

/** Never dialled: every adapter here is handed its client. */
const CONFIG: ImapConfig = { host: "fixture.invalid", port: 993, secure: true, auth: { user: "u", pass: "p" } };

const FOLDERS = ["INBOX", "ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"];

function cold(): ImapCursor {
  const folders: ImapCursor["folders"] = {};
  for (const f of FOLDERS) folders[f] = { uidValidity: "0", uidNext: 0, highestModseq: "0", known: [] };
  folders["INBOX"] = { uidValidity: "100", uidNext: 1, highestModseq: "0", known: [] };
  return { folders };
}

/** Every UID an IMAP sequence set names; an array range is taken as it is. */
function expand(range: unknown): number[] {
  if (Array.isArray(range)) return range as number[];
  const out: number[] = [];
  for (const part of String(range).split(",")) {
    const [a, b] = part.split(":").map(Number);
    if (b === undefined) { out.push(a!); continue; }
    for (let u = Math.min(a!, b); u <= Math.max(a!, b); u++) out.push(u);
  }
  return out;
}

/**
 * A server whose every date command costs `dateCostMs` on the adapter's clock. Dates follow UID
 * order unless `dateOf` says otherwise.
 */
function slowServer(opts: { uids: number[]; dateCostMs: number; dateOf?: (uid: number) => number }) {
  const clock = { ms: Date.UTC(2026, 8, 27) };
  const dateCalls: unknown[] = [];
  const src = Buffer.from("Message-ID: <n@x>\r\nSubject: n\r\n\r\nbody");
  const dateOf = opts.dateOf ?? ((uid: number) => Date.UTC(2026, 0, 1) + uid * 60_000);
  const inbox = {
    path: "INBOX", uidValidity: 100n, uidNext: Math.max(...opts.uids) + 1,
    highestModseq: 0n, exists: opts.uids.length,
  };
  const client = {
    capabilities: new Map<string, boolean>([["MOVE", true]]),
    mailbox: inbox as typeof inbox,
    _path: "INBOX",
    async list() { return [{ path: "INBOX", name: "INBOX", delimiter: "/", flags: new Set<string>() }]; },
    async getMailboxLock(path: string) {
      this._path = path;
      this.mailbox = path === "INBOX" ? inbox : { ...inbox, path, exists: 0, uidNext: 1 };
      return { path, release() { /* noop */ } };
    },
    async logout() { /* noop */ },
    close() { /* noop */ },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *fetch(range: any, query: any, _options: any) {
      if (this._path !== "INBOX") return;
      if (query?.source) {
        for (const uid of expand(range)) {
          yield { uid, flags: new Set<string>(), envelope: { messageId: `<m${uid}@x>` }, source: src,
            internalDate: new Date(dateOf(uid)) };
        }
      } else if (query?.internalDate) {
        dateCalls.push(range);
        for (const uid of expand(range)) yield { uid, internalDate: new Date(dateOf(uid)) };
        clock.ms += opts.dateCostMs;
      } else if (query?.size) {
        for (const uid of expand(range)) yield { uid, size: src.length };
      } else {
        for (const uid of opts.uids) yield { uid };
      }
    },
  };
  return { client, clock, dateCalls };
}

const range = (lo: number, hi: number): number[] => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
const uidsOf = (batch: Awaited<ReturnType<ImapAdapter["changesSince"]>>): number[] =>
  batch.creates.map((c) => parseRef(c.locator.ref).uid);

describe("the first pass of a large folder", () => {
  it("dates the newest UIDs first in packed ranges, stops on its time, and lands the newest page", async () => {
    const server = slowServer({ uids: range(1, 45_000), dateCostMs: 12_000 });
    const adapter = new ImapAdapter(CONFIG, {
      client: server.client, capabilityOverrides: { condstore: false }, nowMs: () => server.clock.ms,
    });
    await adapter.connect();

    const b1 = await adapter.changesSince(cold());
    // Two commands of a full range each: the second starts at 12 s, the third would start at 24 s.
    expect(server.dateCalls).toEqual(["25001:45000", "5001:25000"]);
    expect(uidsOf(b1)).toHaveLength(200);
    expect(uidsOf(b1)[0]).toBe(45_000);
    expect(Math.min(...uidsOf(b1))).toBe(44_801);
    expect(b1.hasBacklog).toBe(true);

    // The next pass reads only what the first did not, from the cache's edge.
    server.dateCalls.length = 0;
    const cur = cold();
    cur.folders["INBOX"]!.known = uidsOf(b1).map((uid) => ({ uid, messageId: null }));
    const b2 = await adapter.changesSince(cur);
    expect(server.dateCalls).toEqual(["1:5000"]);
    expect(Math.max(...uidsOf(b2))).toBe(44_800);
    await adapter.close();
  });

  it("orders by date once every candidate is dated, whatever the UID order", async () => {
    // The newest mail sits at the LOWEST UIDs, as in a mailbox a migration tool copied.
    const server = slowServer({
      uids: range(1, 45_000), dateCostMs: 12_000,
      dateOf: (uid) => Date.UTC(2026, 0, 1) + (50_000 - uid) * 60_000,
    });
    const adapter = new ImapAdapter(CONFIG, {
      client: server.client, capabilityOverrides: { condstore: false }, nowMs: () => server.clock.ms,
    });
    await adapter.connect();
    const cur = cold();
    let b = await adapter.changesSince(cur);
    for (let pass = 0; pass < 3 && server.dateCalls.length < 3; pass++) {
      cur.folders["INBOX"]!.known.push(...uidsOf(b).map((uid) => ({ uid, messageId: null })));
      b = await adapter.changesSince(cur);
    }
    // After the third range is read, the page is the lowest UIDs: the newest by date.
    expect(server.dateCalls).toHaveLength(3);
    expect(Math.min(...uidsOf(b))).toBe(1);
    await adapter.close();
  });

  it("keeps reading past its time until a page's worth is dated", async () => {
    // Every other UID, so each command carries single-UID ranges only; the page wants more than one command's worth.
    const uids = range(1, 1_000).map((u) => u * 2);
    const server = slowServer({ uids, dateCostMs: 60_000 });
    const adapter = new ImapAdapter(CONFIG, {
      client: server.client, capabilityOverrides: { condstore: false }, nowMs: () => server.clock.ms,
      maxBatchMessages: 600,
    });
    await adapter.connect();
    const b = await adapter.changesSince(cold());
    expect(server.dateCalls).toHaveLength(2);
    expect(uidsOf(b)).toHaveLength(600);
    expect(uidsOf(b)[0]).toBe(2_000);
    await adapter.close();
  });

  it("a small folder is one date command over the whole set, as before", async () => {
    const server = slowServer({ uids: range(1, 200), dateCostMs: 60_000 });
    const adapter = new ImapAdapter(CONFIG, {
      client: server.client, capabilityOverrides: { condstore: false }, nowMs: () => server.clock.ms,
    });
    await adapter.connect();
    const b = await adapter.changesSince(cold());
    expect(server.dateCalls).toEqual(["1:200"]);
    expect(uidsOf(b)).toEqual(range(1, 200).reverse());
    expect(b.hasBacklog).toBe(false);
    await adapter.close();
  });
});

describe("uidSetChunks", () => {
  it("packs consecutive UIDs into ranges in either direction", () => {
    expect(uidSetChunks([5, 4, 3, 9, 1], 500, 10_000)).toEqual([{ set: "3:5,9,1", uids: [5, 4, 3, 9, 1] }]);
    expect(uidSetChunks([1, 2, 3, 7, 8], 500, 10_000)).toEqual([{ set: "1:3,7:8", uids: [1, 2, 3, 7, 8] }]);
    expect(uidSetChunks([], 500, 10_000)).toEqual([]);
  });

  it("caps each set by ranges and by UIDs", () => {
    expect(uidSetChunks([10, 8, 6, 4], 2, 10_000).map((c) => c.set)).toEqual(["10,8", "6,4"]);
    expect(uidSetChunks(range(1, 5).reverse(), 500, 2).map((c) => c.set)).toEqual(["4:5", "2:3", "1"]);
  });
});
