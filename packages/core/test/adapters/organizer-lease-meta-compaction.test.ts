import { describe, expect, it } from "vitest";

import { memoryImapServer, type MemoryImapServer } from "./_metaworld.js";
import {
  CLAIM_PROTOCOL,
  LeaseUnavailableError,
  META_RECORDS_MAX_PER_FETCH,
  formatClaim,
  makeLeaseIo,
  makeRequestOrganizerIo,
  runLeaseGate,
  type LeaseSelf,
} from "../../src/adapters/organizer-lease.js";
import { resetMetaMemos, writeMemo } from "../../src/adapters/meta-memo.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A MAILBOX ORGANIZED BY NOBODY, BECAUSE THE FOLDER'S UID SPACE OUTGREW THE WALK
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The claim read walks `ohmail/_meta` in descending UID windows of a fixed width,
 * twenty windows, and no further below the top. A walk that stops above uid 1
 * is not an answer — something may lie beneath it — so the read refuses, and every gate after it
 * refuses with it.
 *
 * Nothing about that is rare. A local install renews several times a minute and
 * every renewal APPENDS, so the folder's uid space passes the walk's reach in about two days, while the
 * folder itself holds a handful of records. From that moment the walk can never reach the bottom,
 * the read refuses for ever, and the person's mail stops being organized with no manual way out.
 *
 * The gap read cannot save it: that read narrows the stretch between OUR OWN record and where the
 * walk stopped, and our record is the newest thing in the folder — far ABOVE the floor. And the
 * fix is not to start the walk at our own uid: a live foreign claim appended before our last
 * renewal sits BELOW it and would go unseen, which is a second organizer — the invariant this
 * module exists to hold, broken from the other side.
 *
 * So the folder is read WHOLE when it is small enough to answer whole, whatever its uid space has
 * done, and the folder that is deep AND populous is the one the organizer compacts.
 */

const NOW = new Date("2026-09-14T12:00:00.000Z");
const META = "INBOX.ohmail._meta";
const toServerPath = (canonical: string): string => canonical.replace(/\//g, ".");
const TEST_META_ID = { installId: "us", mailboxId: "test-mailbox" };

function self(installId = "us"): LeaseSelf {
  return { installId, kind: "cloud", displayName: "Cloud", lastNonce: null };
}

/**
 * PLACE THE FOLDER'S UID SPACE. GreenMail cannot be told which uid to mint, and the defect is
 * ABOUT the uid a folder reaches after two days of renewals — so the arms that need a uid that high are
 * driven here, where the next uid is a number a test may state.
 */
function placeNextUid(server: MemoryImapServer, serverPath: string, nextUid: number): void {
  const folder = server.tree.get(serverPath) as unknown as { nextUid: number } | undefined;
  if (folder === undefined) throw new Error(`the fixture has no folder ${serverPath}`);
  folder.nextUid = nextUid;
}

function liveClaimBy(installId: string, nonce: string, agoMs = 5_000): string {
  return formatClaim({
    installId,
    kind: "local",
    displayName: "The Kitchen Mac",
    claimedAt: new Date(NOW.getTime() - 600_000),
    heartbeat: new Date(NOW.getTime() - agoMs),
    nonce,
    authorizedAt: new Date(NOW.getTime() - 600_000),
    capabilities: ["requests"],
    protocol: CLAIM_PROTOCOL,
  });
}

/** An ack: a record that is neither a claim nor ours, and that fills the folder the way real ones do. */
function ackRecord(n: number): string {
  return `X-Ohmail-Ack: 1\r\nX-Ohmail-Request-Id: r-${n}\r\nSubject: ohmail ack\r\n\r\nhandled\r\n`;
}

describe("the lease folder's uid span", () => {
  it("THE STALL: a `_meta` past uid 10 000 that one read cannot take refuses every gate", async () => {
    resetMetaMemos();
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    /* BOTH HALVES, because either alone is harmless and the defect is their meeting. Over the
     * read's ceiling the window is truncated and the election falls back to the claim SEARCH;
     * past the walk's reach that search can never reach the bottom of the folder. A local
     * install renews several times a minute, so the second half arrives on its
     * own in about two days and the first is one busy reader. */
    placeNextUid(server, META, 30_000);
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH; i++) server.seed(META, ackRecord(i));
    server.seed(META, liveClaimBy("their-install", "their-nonce"));

    const io = makeLeaseIo(server, toServerPath, TEST_META_ID);
    const verdict = await runLeaseGate({ capabilities: [], io, self: self(), now: NOW })
      .then((r) => r.verdict.verdict)
      .catch((err: unknown) => (err instanceof LeaseUnavailableError ? `refused: ${err.message}` : err));

    expect(verdict,
      "the gate cannot read the folder, so this mailbox is organized by nobody and nothing says why")
      .toBe("stand_down");
  });

  it("THE UNSOUND FIX, REFUSED: a live foreign claim BELOW our own record is still seen", async () => {
    resetMetaMemos();
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    placeNextUid(server, META, 10_001);
    /* A full window of records, the reader's permitted headroom, and the foreign claim sits beneath
     * the newest of them — which is where a bound taken at our own uid would hide it. */
    for (let i = 0; i < 480; i++) server.seed(META, ackRecord(i));
    server.seed(META, liveClaimBy("their-install", "their-nonce"));
    for (let i = 0; i < 19; i++) server.seed(META, ackRecord(1_000 + i));
    /* Our own record, appended last and therefore ABOVE theirs. */
    const ourUid = server.seed(META, liveClaimBy("us", "our-old-nonce", 400_000));
    /* AND THIS INSTALL REMEMBERS WHERE ITS OWN CLAIM LANDED, which is the state every renewing
       install is in: the uid came back on the APPEND. It is the anchor the gap read narrows with,
       and it is exactly what a walk must NOT be started from — everything appended before our last
       renewal, including a live rival's claim, is beneath it. */
    const generation = (server.tree.get(META) as unknown as { uidValidity: number }).uidValidity;
    writeMemo(TEST_META_ID, generation, { claimUid: ourUid });

    const io = makeLeaseIo(server, toServerPath, TEST_META_ID);
    const res = await runLeaseGate({ capabilities: [], io, self: self(), now: NOW });

    expect(res.verdict.verdict,
      "the live foreign claim below our own record was not seen, so two installs organize one mailbox")
      .toBe("stand_down");
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE COMPACTION: THE ORGANIZER MOVES ITS OWN FOLDER BACK INSIDE THE WALK
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The walk reaching the folder's own bottom is what makes the stall VISIBLE; it does not make a
 * folder whose records really do lie past the walk's reach readable. Only moving them does, and
 * only its organizer may: the records are the customer's, the folder is shared, and an install
 * that has lost the mailbox has no business renumbering what the winner is reading.
 */
describe("the compaction", () => {
  /** A folder whose records sit far below the top of its uid space, as two days of renewals leave it. */
  function deepFolder(opts: Parameters<typeof memoryImapServer>[0] = {}): MemoryImapServer {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], ...opts });
    server.seed(META, ackRecord(1));
    server.seed(META, ackRecord(2));
    /* Our own live claim, the thing the compaction's lease check reads, seeded at the bottom with
     * the rest — this is a folder whose WHOLE population is out of reach. */
    server.seed(META, liveClaimBy("us", "our-nonce"));
    /* The renewals that spent the uid space and left nothing behind. */
    placeNextUid(server, META, 40_000);
    return server;
  }

  it("moves the folder's records back inside the walk, and the gate then reads it", async () => {
    resetMetaMemos();
    const server = deepFolder();
    const before = await makeRequestOrganizerIo(server, toServerPath, TEST_META_ID)
      .compactMeta?.(NOW);

    expect(before, "the three records below the walk were not moved").toBe(3);

    /* The folder still holds exactly what it held — moved, not dropped. */
    const kept = server.tree.get(META) as unknown as { messages: Array<{ uid: number }> };
    expect(kept.messages.length, "a record was lost in the move").toBe(3);
    expect(Math.min(...kept.messages.map((m) => m.uid)),
      "the records are still below the walk after a compaction").toBeGreaterThan(30_000);
  });

  it("CONTROL 5 (positive): a folder already inside the walk is left alone", async () => {
    resetMetaMemos();
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, liveClaimBy("us", "our-nonce"));
    server.seed(META, ackRecord(1));
    const io = makeRequestOrganizerIo(server, toServerPath, TEST_META_ID);

    const moved = await io.compactMeta?.(NOW);

    expect(moved, "an ordinary folder was compacted, which costs every drain a copy").toBe(0);
    expect(server.log.filter((l) => l.startsWith("copy ")),
      "an ordinary folder's records were copied").toEqual([]);
    expect(server.log.filter((l) => l.startsWith("delete ")),
      "an ordinary folder's records were expunged").toEqual([]);
  });

  it("CONTROL 3: a copy the server will not locate expunges nothing", async () => {
    resetMetaMemos();
    const server = deepFolder({ copyWithoutUidMap: true });

    await expect(makeRequestOrganizerIo(server, toServerPath, TEST_META_ID).compactMeta?.(NOW),
      "records were expunged on a copy the server never said landed")
      .rejects.toThrow(/without saying where they landed/);

    const kept = server.tree.get(META) as unknown as { messages: Array<{ uid: number }> };
    expect(kept.messages.filter((m) => m.uid < 1_000).length,
      "the originals were removed although nothing read them back").toBe(3);
  });

  it("CONTROL 4: a folder renumbered mid-compaction is left exactly as it is", async () => {
    resetMetaMemos();
    const server = deepFolder();
    /* The generation moves between the copy and the expunge — a folder deleted and recreated under
     * the same name, which every uid in hand then describes wrongly. */
    /* DELEGATED, NOT SPREAD. `mailbox` is a getter that reports the SELECTED folder's generation
       live, and a spread evaluates it once — the wrapper would have frozen the answer at the value
       it had before this test moved it, and the guard could not have fired at all. */
    const renumbering = Object.assign(Object.create(server) as MemoryImapServer, {
      async messageCopy(range: number[], destination: string, options?: { uid?: boolean }) {
        const out = await (server as unknown as {
          messageCopy(r: number[], d: string, o?: { uid?: boolean }): Promise<unknown>;
        }).messageCopy(range, destination, options);
        const folder = server.tree.get(META) as unknown as { uidValidity: number };
        folder.uidValidity += 1;
        return out;
      },
    });

    await expect(makeRequestOrganizerIo(renumbering, toServerPath, TEST_META_ID).compactMeta?.(NOW),
      "uids from the old numbering were expunged out of the new folder")
      .rejects.toThrow(/renumbered while its records were being moved/);

    expect(server.log.filter((l) => l.startsWith("delete ")),
      "something was expunged after the folder was renumbered").toEqual([]);
  });

  it("refuses without a live claim of this install's, and leaves the folder alone", async () => {
    resetMetaMemos();
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, ackRecord(1));
    /* Somebody else's live claim, and none of ours: this install is a reader here. */
    server.seed(META, liveClaimBy("their-install", "their-nonce"));
    placeNextUid(server, META, 40_000);

    await expect(makeRequestOrganizerIo(server, toServerPath, TEST_META_ID).compactMeta?.(NOW),
      "an install holding no claim renumbered a folder another organizer is reading")
      .rejects.toThrow(/this install is not organizing this mailbox/);

    expect(server.log.filter((l) => l.startsWith("copy ") || l.startsWith("delete ")),
      "a reader wrote to the folder").toEqual([]);
  });

  it("refuses when the connection cannot copy, rather than removing anything", async () => {
    resetMetaMemos();
    const server = deepFolder();
    const noCopy = Object.assign(Object.create(server) as MemoryImapServer,
      { messageCopy: undefined });

    await expect(makeRequestOrganizerIo(noCopy, toServerPath, TEST_META_ID).compactMeta?.(NOW),
      "a connection that cannot move records did something else to them")
      .rejects.toThrow(/cannot copy messages/);
  });

  /**
   * CONTROL 2, AFTER FIX-026: a folder over the window AND deeper than the old walk no longer
   * stalls the gate — the lease reads it whole by sequence, so uid depth decides nothing — and the
   * compaction still moves the records old builds need inside the walk. (Was: "the stall clears
   * once the organizer has compacted, and not before"; the stall went with the SEARCH walk.)
   */
  it("CONTROL 2: the gate organizes a deep, full folder before compaction, and compaction still moves it", async () => {
    resetMetaMemos();
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH; i++) server.seed(META, ackRecord(i));
    server.seed(META, liveClaimBy("us", "our-nonce"));
    placeNextUid(server, META, 40_000);

    const before = await runLeaseGate({
      capabilities: [], io: makeLeaseIo(server, toServerPath, TEST_META_ID),
      self: self(), now: NOW,
    });
    expect(before.verdict.verdict, "a deep folder still stalled the gate").toBe("organize");

    const moved = await makeRequestOrganizerIo(server, toServerPath, TEST_META_ID).compactMeta?.(NOW);
    expect(moved, "the compaction moved nothing").toBeGreaterThan(0);

    resetMetaMemos();
    // The same process's next gate, carrying the nonce it wrote, as every host does.
    const after = await runLeaseGate({
      capabilities: [], io: makeLeaseIo(server, toServerPath, TEST_META_ID),
      self: { ...self(), lastNonce: before.nonce }, now: NOW,
    });
    expect(after.verdict.verdict, "the gate could not read the folder after it was compacted").toBe("organize");
  });
});
