import { describe, it, expect, afterEach } from "vitest";
import { ImapAdapter, parseRef } from "../../src/adapters/imap.js";
import type { ImapCursor } from "../../src/adapters/imap-types.js";
import { greenmailConfig } from "./_imapenv.js";

/**
 * TWO THINGS THE PERSISTED CURSOR DECIDES, AND BOTH WERE WRONG.
 *
 *  · a truncated page held the folder's UIDVALIDITY at its previous
 *    value along with the two cursors. UIDVALIDITY is not a progress cursor: it names WHICH
 *    numbering the other two live in, so holding it back across a reset made the next cycle see
 *    the change again, empty the known-set again and re-emit every prior UID as a delete again —
 *    the same slice for ever. And `uidNext` must go cold WITH it: those UIDs no longer exist, and
 *    the Sent watermark reads that field, so carrying it into a new epoch strands everything
 *    below it.
 *  · `FIX-SEAM-2-CHANGESSINCE-PERSISTED-CURSOR-CRASH` — `(p?.known.length ?? 0)` guarded the
 *    wrong dereference: for a stored row that EXISTS without the array it throws, which core's
 *    src-only tsconfig cannot see. The cursor is validated at read now and an unreadable folder
 *    is scanned from cold, with its name reported on the batch.
 */
const FOLDERS = ["INBOX", "ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"];

function emptyCursor(): ImapCursor {
  const folders: ImapCursor["folders"] = {};
  for (const f of FOLDERS) folders[f] = { uidValidity: "0", uidNext: 0, highestModseq: "0", known: [] };
  return { folders };
}

/** The byte-budget harness's client, with the folder's epoch as an argument. */
function fakeClient(opts: { uids: number[]; sizes: Record<number, number>; epoch: bigint }) {
  const inbox = {
    path: "INBOX", uidValidity: opts.epoch, uidNext: Math.max(...opts.uids) + 1,
    highestModseq: 0n, exists: opts.uids.length,
  };
  const bodyFor = (uid: number): Buffer =>
    Buffer.from(`Message-ID: <m${uid}@x>\r\nSubject: s${uid}\r\n\r\nbody-${uid}`);
  return {
    inbox,
    client: {
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
        const asked: number[] = Array.isArray(range) ? range : opts.uids;
        if (query?.source) {
          for (const uid of asked) {
            yield {
              uid, flags: new Set<string>(), envelope: { messageId: `<m${uid}@x>` },
              source: bodyFor(uid), internalDate: new Date(Date.UTC(2026, 0, 1) + uid * 1000),
            };
          }
        } else if (query?.size) {
          for (const uid of asked) yield { uid, size: opts.sizes[uid] ?? 0 };
        } else if (query?.internalDate) {
          for (const uid of asked) yield { uid, internalDate: new Date(Date.UTC(2026, 0, 1) + uid * 1000) };
        } else {
          for (const uid of opts.uids) yield { uid };
        }
      },
    },
  };
}

const createdUids = (b: { creates: Array<{ locator: { ref: string } }> }): number[] =>
  b.creates.map((c) => parseRef(c.locator.ref).uid);

describe("the persisted folder cursor across a UIDVALIDITY change", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("a TRUNCATED page under a NEW epoch publishes the new epoch and a cold uidNext", async () => {
    // Four messages, a byte budget that fits two: two are admitted and the page truncates. The stored
    // cursor names epoch 100 and the server now reports 200 — every remembered UID is meaningless.
    const fake = fakeClient({ uids: [1, 2, 3, 4], sizes: { 4: 600, 3: 600, 2: 300, 1: 300 }, epoch: 200n });
    adapter = new ImapAdapter(greenmailConfig(), {
      client: fake.client, capabilityOverrides: { condstore: false }, maxBatchBytes: 1000,
    });
    await adapter.connect();

    const cur = emptyCursor();
    cur.folders["INBOX"] = {
      uidValidity: "100", uidNext: 4_000, highestModseq: "0",
      known: [{ uid: 1, messageId: null }, { uid: 2, messageId: null }],
    };
    const b = await adapter.changesSince(cur);

    expect(b.hasBacklog).toBe(true);                       // the page really did truncate
    expect(createdUids(b)).toEqual([4, 2]);                // …and the known-set was voided
    // THE CLAIM. Before the fix this read "100": the reset was never recorded, so the next cycle
    // repeated the whole reset, for ever.
    expect(b.newCursor.folders["INBOX"]!.uidValidity).toBe("200");
    // And the epoch-scoped watermark goes cold with it. Held at 4000 it would sit above every UID
    // in the new numbering, and the Sent enumeration reads exactly this field.
    expect(b.newCursor.folders["INBOX"]!.uidNext).toBe(0);
  });

  it("POSITIVE CONTROL — a truncated page under the SAME epoch still holds both cursors", async () => {
    // The rule that must not be broken by the one above: within an epoch, a cursor that advances
    // past unread work loses mail.
    const fake = fakeClient({ uids: [1, 2, 3, 4], sizes: { 4: 600, 3: 600, 2: 300, 1: 300 }, epoch: 100n });
    adapter = new ImapAdapter(greenmailConfig(), {
      client: fake.client, capabilityOverrides: { condstore: false }, maxBatchBytes: 1000,
    });
    await adapter.connect();

    const cur = emptyCursor();
    cur.folders["INBOX"] = { uidValidity: "100", uidNext: 1, highestModseq: "0", known: [] };
    const b = await adapter.changesSince(cur);

    expect(b.hasBacklog).toBe(true);
    expect(b.newCursor.folders["INBOX"]!.uidValidity).toBe("100");
    expect(b.newCursor.folders["INBOX"]!.uidNext).toBe(1);
  });

  it("a stored cursor with NO `known` array does not throw — the folder is re-bootstrapped", async () => {
    const fake = fakeClient({ uids: [1, 2], sizes: { 1: 10, 2: 10 }, epoch: 100n });
    adapter = new ImapAdapter(greenmailConfig(), {
      client: fake.client, capabilityOverrides: { condstore: false },
    });
    await adapter.connect();

    const cur = emptyCursor();
    // The persisted shape: a row that exists, written without the array. `(p?.known.length ?? 0)`
    // threw a TypeError here — the reader's adoption of a person's drag landed a cycle late, and
    // the type says this cannot happen.
    cur.folders["INBOX"] = { uidValidity: "100", uidNext: 3, highestModseq: "0" } as ImapCursor["folders"][string];
    const b = await adapter.changesSince(cur);

    expect(b.rebootstrapped).toEqual(["INBOX"]);
    // Cold means cold: both UIDs are unknown, so both are ingested.
    expect(createdUids(b).sort()).toEqual([1, 2]);
    expect(b.newCursor.folders["INBOX"]!.uidValidity).toBe("100");
  });

  it("…and a cursor whose fields are the RIGHT shape is left alone", async () => {
    const fake = fakeClient({ uids: [1, 2], sizes: { 1: 10, 2: 10 }, epoch: 100n });
    adapter = new ImapAdapter(greenmailConfig(), {
      client: fake.client, capabilityOverrides: { condstore: false },
    });
    await adapter.connect();

    const cur = emptyCursor();
    cur.folders["INBOX"] = {
      uidValidity: "100", uidNext: 3, highestModseq: "0", known: [{ uid: 1, messageId: null }],
    };
    const b = await adapter.changesSince(cur);

    expect(b.rebootstrapped).toBeUndefined();
    expect(createdUids(b)).toEqual([2]);   // uid 1 was known and was not re-fetched
  });
});
