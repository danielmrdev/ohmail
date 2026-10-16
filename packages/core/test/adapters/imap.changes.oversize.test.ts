import { describe, it, expect } from "vitest";
import { ImapAdapter, parseRef } from "../../src/adapters/imap.js";
import { WATCHED_FOLDERS, type ImapCursor } from "../../src/adapters/imap-types.js";
import { MAX_RAW_MESSAGE_BYTES } from "../../src/mime.js";

/**
 * A MESSAGE WHOSE SIZE ALREADY SAYS IT CANNOT BE STORED IS NEVER DOWNLOADED.
 *
 * `fetchCapped`'s anti-stall rule admits the FIRST candidate past the batch byte budget so one
 * large mail cannot wedge the drain — and before the pre-fetch ceiling existed, "however large"
 * included messages past `MAX_RAW_MESSAGE_BYTES`, whose only possible outcome (`normalizeMime`
 * refuses above the ceiling, deterministically) was already known from the RFC822.SIZE the
 * metadata fetch had in hand. The full source was pulled into one Buffer anyway — a transfer that
 * can monopolize the connection or take the process past its memory budget BEFORE the failure
 * ledger ever hears about the message (2026-08-26 review, Critical).
 *
 * What this file pins:
 *
 *  • a candidate past the ceiling is REPORTED on `ChangeBatch.oversize` and its UID never appears
 *    in any body fetch — the refusal is decided from size alone;
 *  • it is NOT `hasBacklog`: its outcome is decided, and marking it backlog would re-kick the
 *    mailbox for ever over a message no cycle will ever admit;
 *  • mail beside it in the same folder still arrives — the refusal costs nobody else anything;
 *  • a large-but-storable message (over the batch budget, under the ceiling) keeps the anti-stall
 *    admission it always had.
 */

interface FakeFolder {
  uidValidity: bigint;
  uidNext: number;
  serverModseq: bigint;
  uids: number[];
}

const folder = (over: Partial<FakeFolder> & { uids: number[] }): FakeFolder => ({
  uidValidity: 100n, uidNext: Math.max(0, ...over.uids) + 1, serverModseq: 60n, ...over,
});

const sourceOf = (uid: number): Buffer => Buffer.from([
  "Subject: hello",
  "From: anna@x.example",
  "To: owner@example.com",
  "Date: Mon, 12 Jan 2015 19:15:35 +0000",
  `Message-id: <m-${uid}@x.example>`,
  "",
  "body",
].join("\r\n"));

/** A CONDSTORE server whose RFC822.SIZE answers come from `sizes`; bodies from `sourceOf`. */
function makeFakeClient(folders: Record<string, FakeFolder>, sizes: Map<number, number>) {
  /** Every UID any body (`source`) fetch asked for — the transfer the ceiling must prevent. */
  const bodyFetched: number[] = [];
  const client = {
    capabilities: new Map<string, boolean>([["CONDSTORE", true], ["MOVE", true], ["UIDPLUS", true]]),
    mailbox: {} as { path: string; uidValidity: bigint; uidNext: number; highestModseq: bigint; exists: number },
    bodyFetched,
    _path: "INBOX",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async list(options?: any) {
      return Object.entries(folders).map(([path, f]) => ({
        path, name: path.split("/").pop()!, delimiter: "/", flags: new Set<string>(),
        ...(options?.statusQuery
          ? { status: { path, messages: f.uids.length, uidNext: f.uidNext, highestModseq: f.serverModseq } }
          : {}),
      }));
    },
    async getMailboxLock(path: string) {
      const f = folders[path];
      if (!f) throw new Error(`no such mailbox ${path}`);
      this._path = path;
      this.mailbox = {
        path, uidValidity: f.uidValidity, uidNext: f.uidNext,
        highestModseq: f.serverModseq, exists: f.uids.length,
      };
      return { path, release() { /* no lock in the fake */ } };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *fetch(range: any, query: any, options: any) {
      const f = folders[this._path]!;
      const live = new Set(f.uids);
      const asked: number[] = (Array.isArray(range) ? range : []).filter((u: number) => live.has(u));
      if (options?.changedSince !== undefined) return;
      if (query?.source) {
        bodyFetched.push(...asked);
        for (const uid of asked) {
          yield {
            uid, flags: new Set<string>(),
            ...(query.envelope ? { envelope: { messageId: `<m-${uid}@x.example>` } } : {}),
            source: sourceOf(uid),
            internalDate: new Date("2015-01-12T20:15:42Z"),
            size: sizes.get(uid) ?? 200,
          };
        }
        return;
      }
      if (query?.size && !query.envelope) {
        for (const uid of asked) yield { uid, size: sizes.get(uid) ?? 200 };
        return;
      }
      if (query?.internalDate || query?.envelope) {
        for (const uid of asked) {
          yield { uid, internalDate: new Date("2015-01-12T20:15:42Z"), envelope: { date: new Date("2015-01-12T20:15:42Z") } };
        }
        return;
      }
      for (const uid of f.uids) yield { uid };
    },
    async logout() { /* the adapter closes the client it was handed */ },
    close() { /* … */ },
  };
  return client;
}

const emptyWatched = (): Record<string, FakeFolder> => {
  const out: Record<string, FakeFolder> = {};
  for (const f of WATCHED_FOLDERS) out[f] = folder({ uids: [] });
  return out;
};

const emptyCursor = (): ImapCursor => {
  const folders: ImapCursor["folders"] = {};
  for (const f of WATCHED_FOLDERS) folders[f] = { uidValidity: "0", uidNext: 0, highestModseq: "0", known: [] };
  return { folders };
};

function makeAdapter(client: unknown) {
  return new ImapAdapter(
    { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } },
    { client },
  );
}

describe("ImapAdapter.changesSince — the pre-fetch size ceiling", () => {
  it("refuses a message past the MIME ceiling from RFC822.SIZE alone — no body fetch, no backlog", async () => {
    const folders = { ...emptyWatched(), INBOX: folder({ uids: [1, 2] }) };
    const sizes = new Map<number, number>([[1, MAX_RAW_MESSAGE_BYTES + 1], [2, 200]]);
    const client = makeFakeClient(folders, sizes);
    const adapter = makeAdapter(client);
    await adapter.connect();

    const batch = await adapter.changesSince(emptyCursor());

    // The storable message arrives; the refused one is reported with its evidence.
    expect(batch.creates.map((c) => parseRef(c.locator.ref).uid)).toEqual([2]);
    expect(batch.oversize).toEqual([
      { folder: "INBOX", uidValidity: "100", uid: 1, size: MAX_RAW_MESSAGE_BYTES + 1 },
    ]);
    // The transfer the ceiling exists to prevent: UID 1's body was never asked for. Mutation
    // evidence: dropping the `size > MAX_RAW_MESSAGE_BYTES` gate from `fetchCapped` puts 1 into
    // this list (the anti-stall rule admits it first) and turns this red — watched fail on
    // 2026-08-26 when the gate landed.
    expect(client.bodyFetched).not.toContain(1);
    // Decided, not deferred: no backlog re-kick over a message no cycle will ever admit.
    expect(batch.hasBacklog ?? false).toBe(false);
    await adapter.close();
  });

  it("keeps the anti-stall admission for a large-but-storable first message", async () => {
    // Over the BATCH byte budget, under the hard ceiling: the drain must not wedge on it, so it
    // is admitted exactly as before the gate existed.
    const folders = { ...emptyWatched(), INBOX: folder({ uids: [7] }) };
    const sizes = new Map<number, number>([[7, MAX_RAW_MESSAGE_BYTES - 1]]);
    const client = makeFakeClient(folders, sizes);
    const adapter = makeAdapter(client);
    await adapter.connect();

    const batch = await adapter.changesSince(emptyCursor());
    expect(batch.creates.map((c) => parseRef(c.locator.ref).uid)).toEqual([7]);
    expect(batch.oversize ?? []).toEqual([]);
    await adapter.close();
  });

  it("a folder of ONLY refused messages drains clean — reported once, then crossable", async () => {
    const folders = { ...emptyWatched(), INBOX: folder({ uids: [4, 5] }) };
    const sizes = new Map<number, number>([
      [4, MAX_RAW_MESSAGE_BYTES + 500], [5, MAX_RAW_MESSAGE_BYTES * 2],
    ]);
    const client = makeFakeClient(folders, sizes);
    const adapter = makeAdapter(client);
    await adapter.connect();

    const batch = await adapter.changesSince(emptyCursor());
    expect(batch.creates).toEqual([]);
    expect((batch.oversize ?? []).map((o) => o.uid).sort((a, z) => a - z)).toEqual([4, 5]);
    expect(client.bodyFetched).toEqual([]);
    expect(batch.hasBacklog ?? false).toBe(false);
    await adapter.close();
  });
});
