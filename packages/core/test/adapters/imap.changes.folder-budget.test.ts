import { describe, it, expect, afterEach } from "vitest";
import { ImapAdapter, parseRef } from "../../src/adapters/imap.js";
import type { ImapCursor } from "../../src/adapters/imap-types.js";
import { WATCHED_FOLDERS } from "../../src/adapters/imap-types.js";
import { greenmailConfig } from "./_imapenv.js";

/**
 * THE PASS BUDGET BOUNDS EVERY FOLDER'S ADMISSION, NOT JUST THE LOOP.
 *
 * `fetchCapped`'s anti-stall rule always admitted a folder's FIRST message past the byte budget,
 * so one large mail cannot plug a drain. The budget is shared by every folder of the pass, so
 * that arm fired again in each remaining folder AFTER the budget was gone: many folders
 * holding one large message each retained all of it. The peak below is the bytes the server has
 * handed over and the pass still holds, read at the moment each body is yielded — never the size
 * the pass settles on.
 */

/**
 * Many customer folders, each holding exactly one message of `bodyBytes`, and an INBOX holding
 * `inbox` of them — the arm that decides whether a stopped folder is ever reached again.
 */
function fakeManyFolders(opts: { folders: number; bodyBytes: number; inbox?: number }) {
  const names = Array.from({ length: opts.folders }, (_, i) => `cust/${String(i + 1).padStart(3, "0")}`);
  const all = [...WATCHED_FOLDERS, ...names];
  const inboxCount = opts.inbox ?? 0;
  const countFor = (path: string): number =>
    path === "INBOX" ? inboxCount : (names.includes(path) ? 1 : 0);
  /** Bytes yielded and still held by the pass in flight, and the highest that ever stood. */
  const meter = { held: 0, peak: 0, reset() { this.held = 0; this.peak = 0; } };
  /** Every uid the fake was asked for a BODY, in order — what actually crossed the wire. */
  const sourced: string[] = [];
  const body = (folder: string, uid: number): Buffer => {
    const head = Buffer.from(`Message-ID: <${folder}-${uid}@x>\r\nSubject: ${folder}\r\n\r\n`);
    return Buffer.concat([head, Buffer.alloc(Math.max(0, opts.bodyBytes - head.length), 0x61)]);
  };
  const mailboxFor = (path: string) => ({
    path, uidValidity: 100n, uidNext: countFor(path) + 1, highestModseq: 0n,
    exists: countFor(path),
  });
  return {
    meter, sourced, names,
    client: {
      // LIST-STATUS, because without it the passive inventory is capped at
      // `PASSIVE_FOLDERS_MAX_NO_STATUS` (32) and a mailbox of many folders is never posed. Both
      // production providers advertise it, and it is what lets `unchangedPassive` skip a folder
      // this fixture has already synced.
      capabilities: new Map<string, boolean>([["MOVE", true], ["LIST-STATUS", true]]),
      mailbox: mailboxFor("INBOX"),
      _path: "INBOX",
      async list() {
        return all.map((path) => ({
          path, name: path, delimiter: "/", flags: new Set<string>(),
          status: {
            messages: countFor(path), uidNext: countFor(path) + 1,
            highestModseq: 0n, uidValidity: 100n,
          },
        }));
      },
      async getMailboxLock(path: string) {
        this._path = path;
        this.mailbox = mailboxFor(path);
        return { path, release() { /* noop */ } };
      },
      async logout() { /* noop */ },
      close() { /* noop */ },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async *fetch(range: any, query: any, _options: any) {
        const folder = this._path;
        const here = countFor(folder);
        if (here === 0) return;
        const all = Array.from({ length: here }, (_, i) => i + 1);
        const asked: number[] = Array.isArray(range) ? range.filter((u) => all.includes(u)) : all;
        for (const uid of asked) {
          if (query?.source) {
            const raw = body(folder, uid);
            sourced.push(`${folder}#${uid}`);
            meter.held += raw.length;
            if (meter.held > meter.peak) meter.peak = meter.held;
            yield {
              uid, flags: new Set<string>(), envelope: { messageId: `<${folder}-${uid}@x>` },
              source: raw, internalDate: new Date(Date.UTC(2026, 0, 1) + uid * 1000),
            };
          } else if (query?.size) {
            yield { uid, size: opts.bodyBytes };
          } else if (query?.internalDate) {
            yield { uid, internalDate: new Date(Date.UTC(2026, 0, 1) + uid * 1000) };
          } else {
            yield { uid };
          }
        }
      },
    },
  };
}

function coldCursor(): ImapCursor {
  const folders: ImapCursor["folders"] = {};
  for (const f of WATCHED_FOLDERS) folders[f] = { uidValidity: "0", uidNext: 0, highestModseq: "0", known: [] };
  return { folders };
}

/** The cursor the next pass is handed: what this pass published, plus what it already holds. */
function carry(cursor: ImapCursor, batch: {
  newCursor: { folders: Record<string, { uidValidity: string; uidNext: number; highestModseq: string }> };
  creates: Array<{ locator: { folder: string; ref: string } }>;
  budgetStop?: { folder: string; uidValidity: string; uid: number };
}): ImapCursor {
  const next: ImapCursor["folders"] = {};
  for (const [f, c] of Object.entries(cursor.folders)) next[f] = { ...c, known: [...c.known] };
  for (const [f, c] of Object.entries(batch.newCursor.folders)) {
    next[f] = { ...c, known: next[f]?.known ?? [] };
  }
  for (const c of batch.creates) {
    const f = c.locator.folder;
    next[f] ??= { uidValidity: "100", uidNext: 0, highestModseq: "0", known: [] };
    next[f].known.push({ uid: parseRef(c.locator.ref).uid, messageId: null });
  }
  // Absent means the pass reached the end, so the stop is dropped rather than carried.
  return { folders: next, ...(batch.budgetStop ? { budgetStop: batch.budgetStop } : {}) };
}

const MiB = 1024 * 1024;

describe("the initial sync's byte budget bounds every folder's admission", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("many folders holding one large message each peak under the budget plus one message", async () => {
    const budgetBytes = 200 * MiB;
    const bodyBytes = 25 * MiB;
    const fake = fakeManyFolders({ folders: 100, bodyBytes });
    adapter = new ImapAdapter(greenmailConfig(), {
      client: fake.client, capabilityOverrides: { condstore: false }, maxBatchBytes: budgetBytes,
    });
    await adapter.connect();

    fake.meter.reset();
    const batch = await adapter.changesSince(coldCursor());

    // THE MEASUREMENT. Without the admission's budget ask this reads a large body per folder:
    // every remaining folder's first message admitted after the budget was already gone.
    expect(fake.meter.peak).toBeLessThanOrEqual(budgetBytes + bodyBytes);
    // …and the bound is not met by fetching nothing: the pass spends what it was given.
    expect(fake.meter.peak).toBeGreaterThan(budgetBytes - bodyBytes);
    // The pass stops with what it has and says another is owed.
    expect(batch.hasBacklog).toBe(true);
    // Folders past the stop were not asked for a body at all.
    expect(fake.sourced.length).toBe(batch.creates.length);
    expect(fake.sourced.length).toBeLessThan(100);
  });

  it("the folders the first pass did not reach are reached by later passes, each message once", async () => {
    const bodyBytes = 1 * MiB;
    const fake = fakeManyFolders({ folders: 100, bodyBytes });
    adapter = new ImapAdapter(greenmailConfig(), {
      client: fake.client, capabilityOverrides: { condstore: false }, maxBatchBytes: 4 * MiB,
    });
    await adapter.connect();

    let cursor = coldCursor();
    const arrived: string[] = [];
    let passes = 0;
    for (;;) {
      fake.meter.reset();
      const batch = await adapter.changesSince(cursor);
      passes++;
      // EVERY pass is bounded, not only the first.
      expect(fake.meter.peak).toBeLessThanOrEqual(4 * MiB + bodyBytes);
      for (const c of batch.creates) arrived.push(c.locator.folder);
      cursor = carry(cursor, batch);
      // Progress, every pass: a pass that took nothing while work remained would spin for ever.
      expect(batch.creates.length).toBeGreaterThan(0);
      if (!batch.hasBacklog) break;
      expect(passes).toBeLessThan(120);
    }
    expect(arrived.length).toBe(100);
    expect(new Set(arrived).size).toBe(100);
    expect([...arrived].sort()).toEqual([...fake.names].sort());
  });

  it("the pass says which folder it stopped at, and the next one leads there", async () => {
    // INBOX owes more than the budget, so without a lead it retakes the whole budget every pass
    // and the folder the last one stopped at is never reached.
    const fake = fakeManyFolders({ folders: 100, bodyBytes: 1 * MiB, inbox: 20 });
    adapter = new ImapAdapter(greenmailConfig(), {
      client: fake.client, capabilityOverrides: { condstore: false }, maxBatchBytes: 4 * MiB,
    });
    await adapter.connect();

    const first = await adapter.changesSince(coldCursor());
    expect(first.creates.map((c) => c.locator.folder)).toEqual(Array(4).fill("INBOX"));
    // The folder it did not take from, the epoch the server stated for it, and the lowest UID
    // that folder still owes.
    expect(first.budgetStop).toEqual({ folder: "cust/001", uidValidity: "100", uid: 1 });
    expect(first.hasBacklog).toBe(true);

    const second = await adapter.changesSince(carry(coldCursor(), first));
    // Leads with the stop. Without it this reads four more INBOX creates and cust/001 waits.
    expect(second.creates[0]?.locator.folder).toBe("cust/001");
    expect(second.budgetStop?.folder).toBe("cust/002");
  });

  it("a caller that hands the stop back resumes there on a fresh adapter", async () => {
    const fake = fakeManyFolders({ folders: 100, bodyBytes: 1 * MiB, inbox: 20 });
    adapter = new ImapAdapter(greenmailConfig(), {
      client: fake.client, capabilityOverrides: { condstore: false }, maxBatchBytes: 4 * MiB,
    });
    await adapter.connect();
    const first = await adapter.changesSince(coldCursor());
    const carried = carry(coldCursor(), first);
    await adapter.close();
    adapter = undefined;

    // A NEW adapter remembers nothing; the cursor is the only thing that crossed the restart.
    const restarted = new ImapAdapter(greenmailConfig(), {
      client: fakeManyFolders({ folders: 100, bodyBytes: 1 * MiB, inbox: 20 }).client,
      capabilityOverrides: { condstore: false }, maxBatchBytes: 4 * MiB,
    });
    try {
      await restarted.connect();
      const after = await restarted.changesSince(carried);
      expect(after.creates[0]?.locator.folder).toBe("cust/001");
    } finally {
      await restarted.close();
    }
  });

  it("an ordinary mailbox under the budget syncs in one pass", async () => {
    const fake = fakeManyFolders({ folders: 6, bodyBytes: 64 * 1024 });
    adapter = new ImapAdapter(greenmailConfig(), {
      client: fake.client, capabilityOverrides: { condstore: false }, maxBatchBytes: 32 * MiB,
    });
    await adapter.connect();

    fake.meter.reset();
    const batch = await adapter.changesSince(coldCursor());
    expect(batch.creates.length).toBe(6);
    expect(batch.hasBacklog).toBeFalsy();
    // Nothing stopped, so nothing to resume from — and the scan order is untouched.
    expect(batch.budgetStop).toBeUndefined();
    expect(fake.meter.peak).toBe(6 * 64 * 1024);
  });
});
