import { describe, it, expect } from "vitest";
import { ImapAdapter, parseRef } from "../../src/adapters/imap.js";
import { WATCHED_FOLDERS, type ImapCursor } from "../../src/adapters/imap-types.js";

/**
 * WATCHING THE SENT FOLDER — slice the adapter half.
 *
 * Three properties, and each one is a cost question rather than a correctness question, which
 * is the axis the incident said every guard here had been missing:
 *
 *  1. **Tagging.** Creates out of the resolved Sent folder carry `ownAuthored`; creates out of
 *     every other folder do not. That flag is what turns the whole routing pipeline off for
 *     outbound mail, so a leak into INBOX would silently stop screening the user's inbound mail.
 *  2. **The history bound.** A first scan reads the newest N by sequence number and no more, so
 *     a fifteen-year Sent folder cannot be copied into the database.
 *  3. **The watermark.** After the first drain the folder is read from its persisted `uidNext`
 *     forward, with an explicit `uid >= watermark` filter. Both halves are load-bearing and
 *     both are mutation-tested below: without the watermark, `own_copy`'s deliberate
 *     write-nothing means every self-CC'd message's BODY is re-fetched on every cycle for
 *     ever; without the filter, IMAP's reversed-range rule re-serves the newest sent message
 *     on every poll of every idle mailbox.
 *
 * A fake client rather than GreenMail on purpose: these are claims about which IMAP RANGES are
 * issued and how often, and only a recording fake can answer "exactly once across two cycles".
 * The GreenMail half — send → APPEND → ingest → threaded — is
 * `apps/worker/test/sent-ingest.pg.test.ts`.
 */

interface FakeBox { path: string; uidValidity: bigint; uidNext: number; highestModseq: bigint; exists: number; }

interface Options { sent?: boolean; sentUids?: number[]; inboxUids?: number[] }

/**
 * A client with an INBOX and (optionally) a name-matched `Sent` folder. GreenMail does not
 * advertise SPECIAL-USE either, so the name fallback is the path production actually takes on
 * a large share of servers.
 */
function makeFakeClient(o: Options = {}) {
  const src = Buffer.from("Message-ID: <s@x>\r\nSubject: s\r\n\r\nbody");
  const sentUids = o.sentUids ?? [];
  const inboxUids = o.inboxUids ?? [];
  /** Every `fetch` this client served: the range, the query and the folder it was on. */
  const calls: Array<{ path: string; range: unknown; query: unknown; options: unknown }> = [];
  /** UIDs whose FULL BODY was pulled, in order — the thing the budget exists to bound. */
  const bodyFetches: Array<{ path: string; uid: number }> = [];
  const lists: number[] = [];

  const box = (path: string, uids: number[]): FakeBox => ({
    path,
    uidValidity: 100n,
    uidNext: uids.length ? Math.max(...uids) + 1 : 1,
    highestModseq: 0n,
    exists: uids.length,
  });

  const client = {
    capabilities: new Map<string, boolean>([["MOVE", true], ["UIDPLUS", true], ["IDLE", true]]),
    mailbox: box("INBOX", inboxUids) as FakeBox,
    calls,
    bodyFetches,
    lists,
    _path: "INBOX",
    async list() {
      lists.push(1);
      const rows = [{ path: "INBOX", name: "INBOX", delimiter: "/", flags: new Set<string>() }];
      if (o.sent !== false) rows.push({ path: "Sent", name: "Sent", delimiter: "/", flags: new Set<string>() });
      return rows;
    },
    async getMailboxLock(path: string) {
      this._path = path;
      this.mailbox = path === "INBOX" ? box("INBOX", inboxUids)
        : path === "Sent" ? box("Sent", sentUids)
        : box(path, []);
      return { path, release() {} };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *fetch(range: any, query: any, options: any) {
      const path = this._path;
      calls.push({ path, range, query, options });
      const uids = path === "INBOX" ? inboxUids : path === "Sent" ? sentUids : [];
      if (uids.length === 0) return;

      if (query?.source) {
        for (const uid of range as number[]) {
          bodyFetches.push({ path, uid });
          yield { uid, flags: new Set<string>(), envelope: { messageId: `<u${uid}@x>` }, source: src };
        }
        return;
      }
      if (query?.size) {
        for (const uid of range as number[]) yield { uid, size: src.length };
        return;
      }
      // UID-only enumeration. `options.uid` ⇒ the range is a UID range; otherwise sequence.
      const text = String(range);
      const [rawStart] = text.split(":");
      const start = Number(rawStart);
      const selected = options?.uid
        // A UID range. IMAP reverses a range whose start exceeds its end, so `9999:*` yields
        // the HIGHEST uid — reproduced faithfully, because the adapter's `uid >= from` filter
        // exists precisely for it.
        ? (uids.some((u) => u >= start) ? uids.filter((u) => u >= start) : [Math.max(...uids)])
        // A SEQUENCE range: 1-based position into the folder.
        : uids.slice(Math.max(0, start - 1));
      for (const uid of selected) yield { uid };
    },
  };
  return client;
}

function emptyCursor(): ImapCursor {
  const folders: ImapCursor["folders"] = {};
  for (const f of WATCHED_FOLDERS) folders[f] = { uidValidity: "0", uidNext: 0, highestModseq: "0", known: [] };
  return { folders };
}

function adapterFor(client: unknown, sentHistoryMessages?: number) {
  return new ImapAdapter(
    { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } },
    { client, ...(sentHistoryMessages !== undefined ? { sentHistoryMessages } : {}) },
  );
}

describe("ImapAdapter.changesSince — the Sent folder (fake client)", () => {
  it("tags Sent creates ownAuthored and leaves INBOX creates untagged", async () => {
    const fake = makeFakeClient({ inboxUids: [10], sentUids: [40] });
    const adapter = adapterFor(fake);
    await adapter.connect();

    const batch = await adapter.changesSince(emptyCursor());

    const byFolder = new Map(batch.creates.map((c) => [c.locator.folder, c]));
    expect(byFolder.get("INBOX")!.ownAuthored).toBeUndefined();
    // Drop the tagging clause in `changesSince` and this reads `undefined`, which routes the
    // user's own sent mail through the Screener.
    expect(byFolder.get("Sent")!.ownAuthored).toBe(true);
    expect(batch.newCursor.folders["Sent"]).toBeDefined();
  });

  it("a server with no Sent folder behaves exactly as before — no extra folder, no tag", async () => {
    const fake = makeFakeClient({ sent: false, inboxUids: [10] });
    const adapter = adapterFor(fake);
    await adapter.connect();

    const batch = await adapter.changesSince(emptyCursor());

    expect(Object.keys(batch.newCursor.folders).sort()).toEqual([...WATCHED_FOLDERS].sort());
    expect(batch.creates.every((c) => c.ownAuthored === undefined)).toBe(true);
    expect(fake.calls.some((c) => c.path === "Sent")).toBe(false);
  });

  it("the FIRST scan reads only the newest N of Sent, by sequence number", async () => {
    // 12 messages in Sent, a history depth of 3: only uids 60,70,80 are eligible, and the
    // enumeration itself must be the bounded one (`10:*`, not `1:*`) — the per-cycle cost, not
    // just the ingest, is what `DEFAULT_SENT_HISTORY_MESSAGES` bounds.
    const sentUids = [5, 6, 7, 8, 9, 20, 21, 22, 30, 60, 70, 80];
    const fake = makeFakeClient({ sentUids });
    const adapter = adapterFor(fake, 3);
    await adapter.connect();

    const batch = await adapter.changesSince(emptyCursor());

    const sentCreates = batch.creates.filter((c) => c.locator.folder === "Sent").map((c) => parseRef(c.locator.ref).uid);
    expect(sentCreates.sort((a, b) => a - b)).toEqual([60, 70, 80]);
    const enumerate = fake.calls.find((c) => c.path === "Sent" && !(c.query as { source?: boolean; size?: boolean }).source && !(c.query as { size?: boolean }).size);
    expect(enumerate!.range).toBe("10:*");   // exists(12) - 3 + 1
    expect(fake.bodyFetches.filter((b) => b.path === "Sent").map((b) => b.uid).sort((a, b) => a - b)).toEqual([60, 70, 80]);
  });

  it("the watermark makes a Sent UID that produced NO row cost exactly one body fetch, ever", async () => {
    // The `own_copy` shape: this Sent UID is the twin of a message already stored in INBOX, so
    // `commitChange` deliberately writes nothing for it and it NEVER joins the known-set. Under
    // a plain known-set diff it would be "unknown" on every cycle for the life of the account.
    const fake = makeFakeClient({ sentUids: [80] });
    const adapter = adapterFor(fake);
    await adapter.connect();

    const first = await adapter.changesSince(emptyCursor());
    expect(fake.bodyFetches.filter((b) => b.path === "Sent")).toHaveLength(1);

    // Cycle two, with the cursor the worker persisted and an EMPTY known-set for Sent — exactly
    // what `buildCursor` rebuilds when the ingest stored no row.
    const next = emptyCursor();
    const c = first.newCursor.folders["Sent"]!;
    next.folders["Sent"] = { ...c, known: [] };
    await adapter.changesSince(next);

    // Mutation: delete the `enumerateUidsFrom` branch (fall back to the known-set diff) and
    // this reads 2 — and 3 on the next cycle, and so on for ever. Observed:
    //   AssertionError: expected [ { path: 'Sent', uid: 80 }, { path: 'Sent', uid: 80 } ]
    //   to have a length of 1 but got 2
    expect(fake.bodyFetches.filter((b) => b.path === "Sent")).toHaveLength(1);
  });

  it("filters `uid >= watermark`, because IMAP reverses a range whose start is past the end", async () => {
    const fake = makeFakeClient({ sentUids: [80] });
    const adapter = adapterFor(fake);
    await adapter.connect();

    const first = await adapter.changesSince(emptyCursor());
    const c = first.newCursor.folders["Sent"]!;
    expect(c.uidNext).toBe(81);

    const next = emptyCursor();
    next.folders["Sent"] = { ...c, known: [] };
    const second = await adapter.changesSince(next);

    // The fake serves `81:*` the way a real server does — by returning uid 80. Remove the
    // `if (m.uid >= fromUid)` filter in `enumerateUidsFrom` and this reads 1. Observed:
    //   AssertionError: expected 1 to be +0
    expect(second.creates.filter((x) => x.locator.folder === "Sent")).toHaveLength(0);
  });

  it("does not report a Sent message as DELETED merely because this pass did not enumerate it", async () => {
    // A first scan that has not published a watermark reads the newest N only. A remembered UID
    // below that window was not asked about, so its absence is silence, not an expunge.
    // Mutation: drop the `uid < enumFloorUid` guard in the deletes loop and this reports 100:5,
    // a message the server still holds.
    const fake = makeFakeClient({ sentUids: [5, 6, 7, 8] });
    const adapter = adapterFor(fake, 2);
    await adapter.connect();

    const cursor = emptyCursor();
    cursor.folders["Sent"] = { uidValidity: "100", uidNext: 0, highestModseq: "0", known: [{ uid: 5, messageId: "u5@x" }] };
    const batch = await adapter.changesSince(cursor);

    expect(batch.deletes.filter((d) => d.locator.folder === "Sent")).toEqual([]);
  });

  it("reports a Sent message deleted on the server even though its UID is behind the watermark", async () => {
    // A reply deleted from Sent in another mail app stayed in History and Search.
    // The watermark only bounds what is FETCHED; the known Sent UIDs are asked for too, so an
    // absent one is an expunge. Mutation: enumerate Sent from the watermark again and this is [].
    const fake = makeFakeClient({ sentUids: [90] });
    const adapter = adapterFor(fake);
    await adapter.connect();

    const cursor = emptyCursor();
    cursor.folders["Sent"] = { uidValidity: "100", uidNext: 91, highestModseq: "0", known: [{ uid: 80, messageId: "u80@x" }] };
    const batch = await adapter.changesSince(cursor);

    expect(batch.deletes.filter((d) => d.locator.folder === "Sent").map((d) => d.locator.ref)).toEqual(["100:80"]);
    // One enumeration, from the oldest remembered Sent UID — not the whole folder.
    const enumerate = fake.calls.filter((c) => c.path === "Sent"
      && !(c.query as { source?: boolean }).source && !(c.query as { size?: boolean }).size);
    expect(enumerate.map((c) => c.range)).toEqual(["80:*"]);
  });

  it("an unknown Sent UID behind the watermark is never fetched: the delete scan is not a create scan", async () => {
    // 85 sits between the oldest known UID and the watermark and produced no row (the history
    // bound or a skip already recorded elsewhere). Widening the enumeration for deletes must not
    // make it a create, or its body is fetched on every cycle. Mutation: drop the create floor.
    const fake = makeFakeClient({ sentUids: [80, 85, 90] });
    const adapter = adapterFor(fake);
    await adapter.connect();

    const cursor = emptyCursor();
    cursor.folders["Sent"] = { uidValidity: "100", uidNext: 91, highestModseq: "0", known: [{ uid: 80, messageId: "u80@x" }] };
    const batch = await adapter.changesSince(cursor);

    expect(batch.creates.filter((c) => c.locator.folder === "Sent")).toEqual([]);
    expect(fake.bodyFetches.filter((b) => b.path === "Sent")).toEqual([]);
    expect(batch.deletes.filter((d) => d.locator.folder === "Sent")).toEqual([]);
    expect(batch.newCursor.folders["Sent"]!.uidNext).toBe(91);
  });

  it("positive control: an INBOX message deleted on the server is reported, as before", async () => {
    const fake = makeFakeClient({ inboxUids: [11], sentUids: [90] });
    const adapter = adapterFor(fake);
    await adapter.connect();

    const cursor = emptyCursor();
    cursor.folders["INBOX"] = { uidValidity: "100", uidNext: 12, highestModseq: "0", known: [{ uid: 10, messageId: "u10@x" }, { uid: 11, messageId: "u11@x" }] };
    const batch = await adapter.changesSince(cursor);

    expect(batch.deletes.filter((d) => d.locator.folder === "INBOX").map((d) => d.locator.ref)).toEqual(["100:10"]);
  });

  it("resolves the Sent path once and does not LIST per cycle", async () => {
    const fake = makeFakeClient({ sentUids: [80] });
    const adapter = adapterFor(fake);
    await adapter.connect();
    const afterConnect = fake.lists.length;

    await adapter.changesSince(emptyCursor());
    await adapter.changesSince(emptyCursor());

    // One resolution for the whole adapter lifetime, made by connect's own LIST: Sent's name is
    // decided there now (`folder-roles.ts`), so no cycle LISTs at all. A per-cycle LIST is one
    // more command on every connection in the fleet, every poll, for an answer that does not change.
    expect(fake.lists.length).toBe(afterConnect);
  });

  it("re-asks for a Sent folder that does not exist yet, so a mailbox can grow one", async () => {
    const fake = makeFakeClient({ sent: false, inboxUids: [10] });
    const adapter = adapterFor(fake);
    await adapter.connect();
    const afterConnect = fake.lists.length;

    await adapter.changesSince(emptyCursor());
    await adapter.changesSince(emptyCursor());

    // A NEGATIVE answer is not memoised: caching it would mean a mailbox whose Sent folder
    // appears later is unwatched until the worker restarts.
    expect(fake.lists.length).toBe(afterConnect + 2);
  });
});
