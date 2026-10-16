import { describe, it, expect } from "vitest";
import { ImapAdapter, parseRef, messageIdFromRaw } from "../../src/adapters/imap.js";
import { WATCHED_FOLDERS, type ImapCursor } from "../../src/adapters/imap-types.js";

/**
 * A SERVER THAT LISTS A MESSAGE AND THEN WILL NOT HAND IT OVER.
 *
 * ── THE MEASUREMENT ────────────────────────────────────────────────────────────────────────────
 *
 * On a live iCloud mailbox, a nested personal folder held two messages and had imported ZERO of
 * them, while its cursor row read `uidnext = 3` with the server's own `highestmodseq` — a folder
 * describing itself as fully drained over mail that had never been fetched. `initial_import_
 * completed_at` was stamped on that mailbox, because the stamp is written on a cycle that ends
 * with no backlog and no backlog was ever reported.
 *
 * What the server actually does, verified command by command against iCloud on 2026-08-14:
 *
 *   UID SEARCH ALL              → 1, 2          (the messages exist)
 *   FETCH (FLAGS RFC822.SIZE)   → 1, 2          (both sizes)
 *   FETCH (BODY.PEEK[])         → 1, 2          (the full source, both)
 *   FETCH (INTERNALDATE)        → 1, 2
 *   FETCH (ENVELOPE)            → **nothing**   (no error, no NO, no per-UID signal)
 *
 * The trigger is a header the SENDER chose: a `Message-ID` that is a quoted string, which RFC 5322
 * §3.6.4 permits — `<"2019-03-04T09:41:25.418273+00:00.55134-mail"@shop.example>`. iCloud cannot
 * serialize an ENVELOPE for it and silently omits the row instead of failing the command. Three
 * more messages elsewhere in the same mailbox had the same shape and the same fate.
 *
 * `fetchCapped` asked for ENVELOPE together with the body, so it received nothing for those UIDs
 * and computed `truncated` from the count and byte caps alone — neither of which had bitten. The
 * result was a create-less, backlog-less, ledger-less pass whose cursor published `mb.uidNext`.
 *
 * ── WHAT THIS FILE PINS ────────────────────────────────────────────────────────────────────────
 *
 *   • the message is RECOVERED, by re-asking without the field the server cannot produce, with its
 *     Message-ID read from the raw headers instead of the envelope;
 *   • a UID that survives even that is REPORTED on `ChangeBatch.unanswered` — never crossed in
 *     silence;
 *   • `fetchByUid` does not call such a UID `absent`, because `sync.ts` closes an absent UID as
 *     `gone_from_server` and deletes its failure row.
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

/** The raw source of a message whose Message-ID is a quoted string, as a web shop sends it. */
const quotedIdSource = (uid: number): Buffer => Buffer.from([
  "Content-type: multipart/mixed; boundary=\"===============369==\"",
  "MIME-version: 1.0",
  "Subject: Your order at shop.example",
  "From: Shop Orders <mail@shop.example>",
  "To: Mila Brunner <mila@example.com>",
  "Date: Mon, 04 Mar 2019 08:41:27 +0000",
  `Message-id: <"2019-03-04T09:41:2${uid}.418273+00:00.5513${uid}-mail"@shop.example>`,
  "",
  "body",
].join("\r\n"));

/**
 * A CONDSTORE server that withholds `withheld` UIDs from any fetch requesting ENVELOPE.
 *
 * `alsoWithholdSource` is the harsher server: it withholds them from the envelope-free retry too,
 * which is the only case that may legitimately reach `unanswered`.
 */
function makeFakeClient(folders: Record<string, FakeFolder>, opts: {
  withheld?: number[];
  alsoWithholdSource?: boolean;
} = {}) {
  const withheld = new Set(opts.withheld ?? []);
  const envelopeFetches: number[][] = [];
  const sourceFetches: number[][] = [];
  const client = {
    capabilities: new Map<string, boolean>([["CONDSTORE", true], ["MOVE", true], ["UIDPLUS", true]]),
    mailbox: {} as { path: string; uidValidity: bigint; uidNext: number; highestModseq: bigint; exists: number },
    folders, envelopeFetches, sourceFetches,
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
      // A UID the folder does not hold is answered by NOTHING, on every command — that is what a
      // real server does with an expunged UID, and it is what makes the `absent` case meaningful.
      const asked: number[] = (Array.isArray(range) ? range : []).filter((u: number) => live.has(u));
      if (options?.changedSince !== undefined) return;
      // THE BODY FETCH. `envelope` present ⇒ the withheld UIDs produce no row at all — this is the
      // measured iCloud behaviour and the whole point of the fake.
      if (query?.source) {
        (query.envelope ? envelopeFetches : sourceFetches).push([...asked]);
        for (const uid of asked) {
          if (query.envelope && withheld.has(uid)) continue;
          if (!query.envelope && opts.alsoWithholdSource && withheld.has(uid)) continue;
          yield {
            uid,
            flags: new Set<string>(["\\Seen"]),
            // The envelope-free retry must not receive one, or the test would pass for the
            // wrong reason: it has to prove the id came out of the RAW HEADERS.
            ...(query.envelope ? { envelope: { messageId: `<${this._path}-${uid}@x>` } } : {}),
            source: quotedIdSource(uid),
            internalDate: new Date("2019-03-04T09:41:34Z"),
            size: 200,
          };
        }
        return;
      }
      if (query?.size && !query.envelope) {
        for (const uid of asked) yield { uid, size: 200 };
        return;
      }
      if (query?.internalDate || query?.envelope) {
        for (const uid of asked) {
          yield { uid, internalDate: new Date("2019-03-04T09:41:34Z"), envelope: { date: new Date("2019-03-04T09:41:34Z") } };
        }
        return;
      }
      for (const uid of f.uids) yield { uid };
    },
    async logout() { /* the adapter closes the client it was handed */ },
    close() { /* … and falls back to this when logout throws */ },
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

// ══════════════════════════════════════════════════════════════════════════════════════════════
describe("messageIdFromRaw — the identity the envelope could not carry", () => {
  it("reads a quoted-string Message-ID out of the header block", () => {
    expect(messageIdFromRaw(quotedIdSource(1)))
      .toBe("\"2019-03-04T09:41:21.418273+00:00.55131-mail\"@shop.example");
  });

  it("unfolds a wrapped header rather than truncating it", () => {
    const raw = Buffer.from("Subject: s\r\nMessage-ID:\r\n <wrapped@example.com>\r\n\r\nbody");
    expect(messageIdFromRaw(raw)).toBe("wrapped@example.com");
  });

  it("reads the header block ONLY, never a Message-ID quoted inside the body", () => {
    // A forwarded message carries its own headers in the BODY. Matching there would hand
    // `correlateMoves` the wrong identity and let it report a move that never happened.
    const raw = Buffer.from([
      "Message-ID: <outer@example.com>",
      "Subject: Fwd",
      "",
      "---------- Forwarded message ----------",
      "Message-ID: <inner@example.com>",
    ].join("\r\n"));
    expect(messageIdFromRaw(raw)).toBe("outer@example.com");
  });

  it("accepts a bare-LF header block and a message with no Message-ID at all", () => {
    expect(messageIdFromRaw(Buffer.from("Message-ID: <lf@example.com>\n\nbody"))).toBe("lf@example.com");
    expect(messageIdFromRaw(Buffer.from("Subject: none\r\n\r\nbody"))).toBeNull();
    expect(messageIdFromRaw(Buffer.alloc(0))).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
describe("ImapAdapter.changesSince — a UID the server withholds from an ENVELOPE fetch", () => {
  it("recovers the message by re-asking without the envelope, and takes its id from the raw", async () => {
    const folders = { ...emptyWatched(), INBOX: folder({ uids: [1, 2, 3] }) };
    const client = makeFakeClient(folders, { withheld: [1, 2] });
    const adapter = makeAdapter(client);
    await adapter.connect();

    const batch = await adapter.changesSince(emptyCursor());

    // ALL THREE arrive. Before the recovery fetch existed this was one create, and the two
    // withheld messages were never seen again.
    expect(batch.creates.map((c) => parseRef(c.locator.ref).uid).sort((a, z) => a - z)).toEqual([1, 2, 3]);
    expect(batch.unanswered ?? []).toEqual([]);

    // The second fetch asked for EXACTLY the shortfall — not the whole folder again.
    expect(client.envelopeFetches).toEqual([[3, 2, 1]]);
    expect(client.sourceFetches).toEqual([[2, 1]]);

    // Recovered messages carry the id from their raw headers. The fake deliberately serves no
    // envelope on that fetch, so this value can only have come from the source bytes.
    const recovered = batch.creates.find((c) => parseRef(c.locator.ref).uid === 1)!;
    expect(recovered.raw?.length).toBeGreaterThan(0);
    await adapter.close();
  });

  it("reports a UID no fetch will answer, instead of crossing it in silence", async () => {
    const folders = { ...emptyWatched(), INBOX: folder({ uids: [1, 2, 3] }) };
    const client = makeFakeClient(folders, { withheld: [2], alsoWithholdSource: true });
    const adapter = makeAdapter(client);
    await adapter.connect();

    const batch = await adapter.changesSince(emptyCursor());

    expect(batch.creates.map((c) => parseRef(c.locator.ref).uid).sort((a, z) => a - z)).toEqual([1, 3]);
    // THE GUARD. Silence here is what stamped a mailbox complete over mail it never imported.
    expect(batch.unanswered).toEqual([{ folder: "INBOX", uidValidity: "100", uid: 2 }]);
    await adapter.close();
  });

  it("says nothing on an ordinary pass, so the caller's ledger stays empty", async () => {
    const folders = { ...emptyWatched(), INBOX: folder({ uids: [1, 2, 3] }) };
    const adapter = makeAdapter(makeFakeClient(folders));
    await adapter.connect();
    const batch = await adapter.changesSince(emptyCursor());
    expect(batch.creates).toHaveLength(3);
    expect(batch.unanswered ?? []).toEqual([]);
    await adapter.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
describe("ImapAdapter.fetchByUid — the targeted retry must not call a withheld UID absent", () => {
  it("recovers a withheld UID rather than reporting it gone from the server", async () => {
    const folders = { ...emptyWatched(), INBOX: folder({ uids: [1, 2, 3] }) };
    const adapter = makeAdapter(makeFakeClient(folders, { withheld: [2] }));
    await adapter.connect();

    const found = await adapter.fetchByUid("INBOX", [2]);

    // `sync.ts` closes an `absent` UID as `gone_from_server` and DELETES its failure row. A
    // message still sitting on the server would stop being owed by anything at all.
    expect(found.absent).toEqual([]);
    expect(found.creates.map((c) => parseRef(c.locator.ref).uid)).toEqual([2]);
    await adapter.close();
  });

  it("still reports a genuinely expunged UID as absent", async () => {
    const folders = { ...emptyWatched(), INBOX: folder({ uids: [1, 3] }) };
    const adapter = makeAdapter(makeFakeClient(folders));
    await adapter.connect();
    const found = await adapter.fetchByUid("INBOX", [2]);
    expect(found.absent).toEqual([2]);
    expect(found.creates).toEqual([]);
    await adapter.close();
  });
});
