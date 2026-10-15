import { describe, it, expect, afterEach } from "vitest";
import { ImapAdapter, parseRef } from "../../src/adapters/imap.js";
import type { ImapCursor } from "../../src/adapters/imap-types.js";
import { greenmailConfig } from "./_imapenv.js";

/**
 * THE BYTE WALK SKIPS, IT DOES NOT BREAK — the WORKER-BACKFILL-LOOP stall.
 *
 * ── WHAT WAS MEASURED ──────────────────────────────────────────────────────────────────────────
 *
 * A production Sent folder held a message larger than the byte budget THIRD in newest-first order, behind two messages
 * whose creates dedup'd to an existing row (byte-twin copies — the pipeline's second-copy rule
 * owns that half). `fetchCapped`'s byte walk `break`-ed the moment the oversized message did not fit,
 * so every message ordered behind it was never fetched at all: a first scan that could not
 * finish, a cursor pinned at the 0 sentinel, and `hasBacklog` re-kicking the whole worker cycle
 * every few minutes for the life of the process.
 *
 * The rule these tests pin: a message that does not fit the REMAINING byte budget is SKIPPED
 * (owed, `truncated`, cursor held) while everything smaller behind it still commits this cycle —
 * so the unknown set strictly shrinks, and the skipped message is admitted by the anti-stall rule
 * ("the first candidate is always taken") the moment it reaches the front of the order.
 *
 * Restore the `break` in `fetchCapped`'s byte walk and the first assertion goes red exactly as
 * production reproduced.
 */

const FOLDERS = ["INBOX", "ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"];

function emptyCursor(): ImapCursor {
  const folders: ImapCursor["folders"] = {};
  for (const f of FOLDERS) folders[f] = { uidValidity: "0", uidNext: 0, highestModseq: "0", known: [] };
  return { folders };
}

/**
 * A fake ImapFlow with PER-UID SIZES — the datecache test's harness with one more query arm.
 * Newest-first order is by internalDate, constructed so the HIGHEST uid is the newest.
 */
function fakeClient(opts: { uids: number[]; sizes: Record<number, number> }) {
  const inbox = {
    path: "INBOX", uidValidity: 100n, uidNext: Math.max(...opts.uids) + 1,
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
          // Newest = highest uid, so newest-first order is descending uid — deterministic.
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

describe("fetchCapped — the byte budget skips what does not fit instead of plugging the queue", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("a too-large message mid-order is skipped and everything smaller behind it still commits", async () => {
    // Newest-first: [4, 3, 2, 1] against the byte budget below. 4 (600) is admitted, 3 (600) does not fit
    // after it, 2 (300) does, 1 (300) does not. The pass is truncated — 3 and 1 are owed.
    const fake = fakeClient({ uids: [1, 2, 3, 4], sizes: { 4: 600, 3: 600, 2: 300, 1: 300 } });
    adapter = new ImapAdapter(greenmailConfig(), {
      client: fake.client, capabilityOverrides: { condstore: false }, maxBatchBytes: 1000,
    });
    await adapter.connect();

    const cur = emptyCursor();
    cur.folders["INBOX"] = { uidValidity: "100", uidNext: 1, highestModseq: "0", known: [] };
    const b1 = await adapter.changesSince(cur);

    // With the old `break`, this reads [4]: uid 3 plugged the walk and 2 starved behind it.
    expect(createdUids(b1)).toEqual([4, 2]);
    expect(b1.hasBacklog).toBe(true);
    // Skipped-for-size is OWED backlog, not a refusal: no failure record of either kind.
    expect(b1.unanswered ?? []).toEqual([]);
    expect(b1.oversize ?? []).toEqual([]);
    // …and the cursor is HELD: the skipped messages are not yet committed.
    /* `serverExists` — the server's own EXISTS for the folder, added to the published cursor by
     * a later change and named here because this is an exact-shape check: a field the adapter
     * publishes and no test names is a field nothing guards. It is deliberately NOT held back
     * under truncation the way the three cursors beside it are (a count is what the folder holds
     * right now; a cursor that advanced past unread work would lose mail), so it reads 4 on this
     * truncated pass while `uidNext` and `highestModseq` stay pinned — which is exactly the
     * distinction this assertion exists to make.
     *
     * This expectation predates the field — the file landed on 2026-08-30, the field on 09-02 —
     * and the two later sweeps that amended the sibling exact-shape checks
     * each touched only their own file and neither reached this one. So the SHAPE
     * here went stale while the byte-walk rule the file is about stayed correct, which is why
     * the red named a cursor and not the skip: the three assertions above it all passed. */
    expect(b1.newCursor.folders["INBOX"])
      .toEqual({ uidValidity: "100", uidNext: 1, highestModseq: "0", serverExists: 4 });
  });

  it("the skipped message is admitted by the anti-stall rule once it reaches the front, and the pass then drains", async () => {
    const fake = fakeClient({ uids: [1, 2, 3, 4], sizes: { 4: 600, 3: 600, 2: 300, 1: 300 } });
    adapter = new ImapAdapter(greenmailConfig(), {
      client: fake.client, capabilityOverrides: { condstore: false }, maxBatchBytes: 1000,
    });
    await adapter.connect();

    // Pass 2 of the scenario above: 4 and 2 are known now. The skipped 3 is first in order —
    // the anti-stall rule takes it whatever its size — and 1 fits behind it.
    const cur = emptyCursor();
    cur.folders["INBOX"] = {
      uidValidity: "100", uidNext: 1, highestModseq: "0",
      known: [{ uid: 4, messageId: null }, { uid: 2, messageId: null }],
    };
    const b2 = await adapter.changesSince(cur);

    expect(createdUids(b2)).toEqual([3, 1]);
    expect(b2.hasBacklog).toBe(false);
    // The folder genuinely drained, so the cursor is allowed to advance past it.
    expect(b2.newCursor.folders["INBOX"].uidNext).toBe(5);
  });
});
