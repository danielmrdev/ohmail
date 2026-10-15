import { describe, it, expect } from "vitest";
import { ImapAdapter } from "../../src/adapters/imap.js";
import {
  WATCHED_FOLDERS, DEFAULT_PASSIVE_FOLDERS_MAX, PASSIVE_FOLDERS_MAX_NO_STATUS,
  passiveFolderExclusion, isOrganizedFolder,
  type ImapCursor,
} from "../../src/adapters/imap-types.js";

/**
 * THE CUSTOMER'S OWN FOLDERS, ENUMERATED — and the two production stalls that came with looking.
 *
 * ── WHAT WAS INVISIBLE ─────────────────────────────────────────────────────────────────────────
 *
 * `changesSince` read `WATCHED_FOLDERS` plus the resolved Sent folder and nothing else, so a message
 * the customer had filed themselves was in no `messages` row, no thread and no search result.
 * Measured on a real iCloud mailbox: **most of the folders on the server were never read.** The mail that
 * produced this slice was in a folder the person made, filed years ago in Apple Mail.
 *
 * ── AND THE STALL THAT LOOKING EXPOSED ─────────────────────────────────────────────────────────
 *
 * The same mailbox had `initial_import_completed_at` NULL for nine days with nothing wrong with it:
 * every cursor exact, every UID known, no folder owing anything. `hasBacklog` was pinned true by the
 * flag pass, because **iCloud's CONDSTORE `CHANGEDSINCE` is inert** — it returns every message in the
 * folder even when the modseq passed is the folder's own reported `HIGHESTMODSEQ`, which by RFC 7162
 * can have nothing above it. Every row a cycle against the flag budget, for ever. That server is
 * the fake in `describe("a server whose CHANGEDSINCE is inert")` below:
 * its shape, not its sizes.
 */

interface FakeFolder {
  uidValidity: bigint;
  uidNext: number;
  serverModseq: bigint;
  uids: number[];
  /** LIST flags, e.g. `\Noselect`. */
  flags?: string[];
  /** imapflow's resolved special-use, e.g. `\Junk`. */
  specialUse?: string;
}

const folder = (over: Partial<FakeFolder> & { uids: number[] }): FakeFolder => ({
  uidValidity: 100n, uidNext: Math.max(0, ...over.uids) + 1, serverModseq: 60n, ...over,
});

/**
 * A CONDSTORE server whose folder set is whatever the test names.
 *
 * `changedSinceIsInert` reproduces iCloud: the `changedSince` option is accepted and ignored.
 */
function makeFakeClient(folders: Record<string, FakeFolder>, opts: {
  changedSinceIsInert?: boolean; listStatus?: boolean; seenFlag?: boolean;
  /** A server that answers LIST-STATUS and states no UIDVALIDITY — the fail-closed arm. */
  listStatusHidesUidValidity?: boolean;
} = {}) {
  const lists: Array<{ statusQuery: boolean }> = [];
  const selected: string[] = [];
  const enumerated: string[] = [];
  const caps = new Map<string, boolean>([
    ["CONDSTORE", true], ["MOVE", true], ["UIDPLUS", true], ["IDLE", true],
  ]);
  if (opts.listStatus) caps.set("LIST-STATUS", true);
  const client = {
    capabilities: caps,
    mailbox: {} as { path: string; uidValidity: bigint; uidNext: number; highestModseq: bigint; exists: number },
    lists, selected, enumerated, folders,
    _path: "INBOX",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async list(options?: any) {
      lists.push({ statusQuery: !!options?.statusQuery });
      return Object.entries(folders).map(([path, f]) => ({
        path, name: path.split("/").pop()!, delimiter: "/",
        flags: new Set(f.flags ?? []),
        ...(f.specialUse ? { specialUse: f.specialUse } : {}),
        ...(options?.statusQuery
          ? {
            status: {
              path, messages: f.uids.length, uidNext: f.uidNext, highestModseq: f.serverModseq,
              // UIDVALIDITY is a STATUS item every server answers, and the fake has to volunteer
              // it or the epoch case below could never be posed: a fixture that never states an
              // epoch cannot show one changing.
              ...(opts.listStatusHidesUidValidity ? {} : { uidValidity: f.uidValidity }),
            },
          }
          : {}),
      }));
    },
    async getMailboxLock(path: string) {
      const f = folders[path];
      if (!f) throw new Error(`no such mailbox ${path}`);
      selected.push(path);
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
      if (options?.changedSince !== undefined) {
        const from = Number(String(range).split(":")[0] ?? 1);
        for (const uid of f.uids) {
          if (uid < from) continue;
          // A CORRECT server filters on the message's own modseq; the inert one does not. Every
          // message here carries the folder's modseq, so a correct server reports nothing once the
          // cursor has caught up — which is exactly the state the measured mailbox was in.
          if (!opts.changedSinceIsInert && f.serverModseq <= (options.changedSince as bigint)) continue;
          yield { uid, flags: new Set(opts.seenFlag === false ? [] : ["\\Seen"]), modseq: f.serverModseq };
        }
        return;
      }
      if (query?.source) {
        for (const uid of Array.isArray(range) ? range : []) {
          yield {
            uid, flags: new Set<string>(),
            envelope: { messageId: `<${this._path}-${uid}@x>` },
            source: Buffer.from([
              `Message-ID: <${this._path}-${uid}@x>`,
              "From: editor@example.com",
              "To: owner@example.com",
              "Subject: Weekly Notes",
              "",
              "body",
            ].join("\r\n")),
            internalDate: new Date("2019-04-01T10:00:00Z"),
            size: 200,
          };
          }
        return;
      }
      if (query?.size) {
        for (const uid of Array.isArray(range) ? range : []) yield { uid, size: 200 };
        return;
      }
      if (query?.internalDate || query?.envelope) {
        for (const uid of Array.isArray(range) ? range : []) {
          yield { uid, internalDate: new Date("2019-04-01T10:00:00Z"), envelope: { date: new Date("2019-04-01T10:00:00Z") } };
        }
        return;
      }
      enumerated.push(this._path);
      for (const uid of f.uids) yield { uid };
    },
  };
  return client;
}

/** A cursor that knows every UID of every WATCHED folder, with a `seen` baseline of true. */
function cursorFor(folders: Record<string, FakeFolder>, opts: { known?: string[] } = {}): ImapCursor {
  const cursor: ImapCursor = { folders: {} };
  for (const name of opts.known ?? WATCHED_FOLDERS) {
    const f = folders[name];
    if (!f) continue;
    cursor.folders[name] = {
      uidValidity: String(f.uidValidity),
      uidNext: f.uidNext,
      highestModseq: String(f.serverModseq),
      known: f.uids.map((uid) => ({ uid, messageId: `<${name}-${uid}@x>`, seen: true })),
    };
  }
  return cursor;
}

const emptyWatched = (): Record<string, FakeFolder> => {
  const out: Record<string, FakeFolder> = {};
  for (const f of WATCHED_FOLDERS) out[f] = folder({ uids: [] });
  return out;
};

function makeAdapter(client: unknown, over: { maxBatchMessages?: number; maxBatchFlags?: number } = {}) {
  return new ImapAdapter(
    { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } },
    { client, ...over },
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
describe("passiveFolderExclusion — which folders are the customer's own", () => {
  const admit = (path: string, over: Parameters<typeof passiveFolderExclusion>[0] = { path }) =>
    passiveFolderExclusion({ ...over, path }, "Sent Messages");

  it("admits the customer's own folders at any depth", () => {
    for (const path of [
      "Archive", "Private/Editor", "_archive/Studios/Kiln Log/Invoices",
      "News", "Mila Studio/Papers", "Trips/Ticino/Itinerary",
    ]) {
      expect(admit(path), `${path} is the customer's own filing`).toBeNull();
    }
  });

  it("declines the Imbox, the six organized folders and the whole ohmail namespace", () => {
    expect(admit("INBOX")).toMatch(/Imbox/);
    for (const f of WATCHED_FOLDERS) expect(admit(f)).not.toBeNull();
    // `ohmail/_meta` is the organizer LEASE. A watched `_meta` ingests its own bookkeeping as mail.
    expect(admit("ohmail/_meta")).toMatch(/ohmail namespace/);
    // …and the namespace-prefixed form a `.`-delimited server reports, canonicalized. Measured on a
    // live dovecot deployment as `INBOX.ohmail._meta`.
    expect(admit("INBOX/ohmail/_meta")).toMatch(/ohmail namespace/);
    expect(admit("INBOX/ohmail/News")).toMatch(/ohmail namespace/);
  });

  it("declines the Sent folder it was given, however that path was resolved", () => {
    expect(admit("Sent Messages")).toMatch(/Sent folder/);
    // A server whose Sent folder is only resolvable BY NAME still excludes it, because the caller
    // passes the resolved path rather than a special-use flag.
    expect(passiveFolderExclusion({ path: "INBOX/Sent" }, "INBOX/Sent")).toMatch(/Sent folder/);
  });

  it("declines the special-use classes, by flag and by name", () => {
    for (const [path, special] of [
      ["Drafts", "\\Drafts"], ["Junk", "\\Junk"], ["Deleted Messages", "\\Trash"],
      ["[Gmail]/All Mail", "\\All"], ["[Gmail]/Starred", "\\Flagged"],
    ] as const) {
      expect(admit(path, { path, specialUse: special }), `${special} must be excluded`).not.toBeNull();
    }
    // THE BELT, and it is not theoretical: a live dovecot deployment reports `INBOX.Trash` WITH the
    // `\Trash` flag and, beside it, `INBOX.Deleted Messages` and `INBOX.Junk` with no special-use at
    // all — two former specials a migration left behind, both holding mail.
    expect(admit("INBOX/Deleted Messages")).toMatch(/excluded classes/);
    expect(admit("INBOX/Junk")).toMatch(/excluded classes/);
    expect(admit("Papierkorb")).toMatch(/excluded classes/);
    expect(admit("Entwürfe")).toMatch(/excluded classes/);
  });

  it("declines a folder the server says cannot be selected", () => {
    expect(admit("[Gmail]", { path: "[Gmail]", flags: new Set(["\\Noselect"]) }))
      .toMatch(/not selectable/);
    expect(admit("INBOX/ohmail", { path: "INBOX/ohmail", flags: new Set(["\\NonExistent"]) }))
      .not.toBeNull();
  });

  it("isOrganizedFolder is the ORGANIZE half and answers false for everything read-only", () => {
    // The predicate every writing path asks. Sent and the customer's own folders are READ; the set
    // ohmail FILES INTO is strictly smaller, and conflating the two is how a passive folder acquires
    // a mover.
    for (const f of WATCHED_FOLDERS) expect(isOrganizedFolder(f)).toBe(true);
    for (const f of ["Sent Messages", "INBOX/Sent", "Archive", "Private/Editor", "ohmail/_meta"]) {
      expect(isOrganizedFolder(f), `${f} is read, never organized`).toBe(false);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
describe("ImapAdapter.changesSince — the customer's own folders", () => {
  it("discovers a user folder and ingests it, stamped `passive`", async () => {
    // Mutation watched: drop `...passive` from `foldersToScan`'s return (`folders: [...WATCHED,
    // sent]`) and this reports `creates: 0` — `expected +0 to be 3`.
    const folders = {
      ...emptyWatched(),
      "Private/Editor": folder({ uids: [1, 2, 3] }),
      Archive: folder({ uids: [] }),
    };
    const fake = makeFakeClient(folders);
    const adapter = makeAdapter(fake);
    await adapter.connect();

    const batch = await adapter.changesSince(cursorFor(folders));

    const fromArchive = batch.creates.filter((c) => c.locator.folder === "Private/Editor");
    expect(fromArchive).toHaveLength(3);
    // STAMPED, because the pipeline cannot derive it: "is this the customer's own folder" is a fact
    // about the server's folder inventory and this class is the only thing that has LISTed it.
    for (const c of fromArchive) expect(c.passive).toBe(true);
    // …and a cursor row is published for it, which is what makes `buildCursor` keep reading it.
    expect(batch.newCursor.folders["Private/Editor"]).toBeDefined();
  });

  it("never stamps `passive` on a watched folder or on Sent", async () => {
    const folders = {
      ...emptyWatched(),
      INBOX: folder({ uids: [7] }),
      "Sent Messages": folder({ uids: [9], specialUse: "\\Sent" }),
      Archive: folder({ uids: [4] }),
    };
    const fake = makeFakeClient(folders);
    const adapter = makeAdapter(fake);
    await adapter.connect();

    const batch = await adapter.changesSince(cursorFor(folders));

    const at = (f: string) => batch.creates.find((c) => c.locator.folder === f);
    expect(at("INBOX")?.passive).toBeUndefined();
    // The Sent folder is `ownAuthored`, never `passive` — it is watched on its own watermark. If both
    // flags were set the pipeline would take whichever branch came first and the customer's own sent
    // mail would stop being marked read.
    expect(at("Sent Messages")?.ownAuthored).toBe(true);
    expect(at("Sent Messages")?.passive).toBeUndefined();
    expect(at("Archive")?.passive).toBe(true);
  });

  it("spends the SHARED per-cycle budget, and spends it on the Imbox FIRST", async () => {
    // The cost answer for reading a decades-deep folder tree: ONE budget, passive folders last, so
    // fifteen years of archive cannot delay this cycle's inbound mail by one message. Mutation
    // watched: put the passive list BEFORE `WATCHED_FOLDERS` in `foldersToScan` and the INBOX create
    // disappears from this batch — `expected +0 to be 1`.
    const folders = {
      ...emptyWatched(),
      INBOX: folder({ uids: [] }),
      "_archive/Clients": folder({ uids: [1, 2, 3, 4, 5, 6] }),
    };
    const fake = makeFakeClient(folders);
    const adapter = makeAdapter(fake, { maxBatchMessages: 3 });
    await adapter.connect();
    // The cursor is built BEFORE the arrival, so uid 500 is genuinely unknown — the Imbox has one
    // message to fetch and the archive has six, against a budget of three.
    const cursor = cursorFor(folders);
    folders["INBOX"]!.uids = [500];
    folders["INBOX"]!.uidNext = 501;

    const batch = await adapter.changesSince(cursor);

    expect(batch.creates.filter((c) => c.locator.folder === "INBOX")).toHaveLength(1);
    // Three total: the Imbox took its one, the archive took the two that were left.
    expect(batch.creates).toHaveLength(3);
    // …and the pass says it owes another, so the worker re-kicks rather than waiting out a poll.
    expect(batch.hasBacklog).toBe(true);
    // The archive's cursor is HELD while it owes, so nothing is acknowledged past unfetched mail.
    expect(batch.newCursor.folders["_archive/Clients"]!.uidNext).toBe(0);
  });

  it("caps how many of the customer's folders one mailbox may have read", async () => {
    // The HIGH ceiling, because this server answers LIST-STATUS: a settled folder then costs nothing
    // per cycle, so what the ceiling bounds is SELECTs and not folders. See
    // `DEFAULT_PASSIVE_FOLDERS_MAX` for why the conservative number is not the safe default — on the
    // mailbox that produced this slice a ceiling of 64 admitted `Private/Editor` and cut
    // `Private/<a person's name>`, hundreds of messages, on an alphabetical cut-line.
    const folders = emptyWatched();
    for (let i = 0; i < DEFAULT_PASSIVE_FOLDERS_MAX + 5; i++) {
      folders[`Folder ${String(i).padStart(3, "0")}`] = folder({ uids: [] });
    }
    const fake = makeFakeClient(folders, { listStatus: true });
    const adapter = makeAdapter(fake);
    await adapter.connect();

    const report = adapter.passiveFolderReport();
    expect(report.read).toHaveLength(DEFAULT_PASSIVE_FOLDERS_MAX);
    // The overflow is REPORTED rather than silently dropped: a bounded, nameable gap, which is the
    // whole difference between this and an unbounded first cycle.
    expect(report.overflow).toHaveLength(5);
    // …and every declined folder carries the SENTENCE, not a boolean — for an operator answering
    // "why is this customer's folder not in search".
    expect(report.excluded.get("ohmail/Screener")).toMatch(/ohmail namespace/);
    expect(report.excluded.get("INBOX")).toMatch(/Imbox/);
  });

  it("applies the LOW ceiling to a server that must be asked folder by folder", async () => {
    // No LIST-STATUS ⇒ every folder in the scan is a SELECT on every cycle, and THAT is the cost the
    // ceiling exists to bound. Mutation watched: use `DEFAULT_PASSIVE_FOLDERS_MAX` unconditionally in
    // `learnPassiveFolders` and this reads 40 — 40 SELECTs per cycle on the worker's serial queue.
    const folders = emptyWatched();
    for (let i = 0; i < PASSIVE_FOLDERS_MAX_NO_STATUS + 8; i++) {
      folders[`Folder ${String(i).padStart(3, "0")}`] = folder({ uids: [] });
    }
    const fake = makeFakeClient(folders);
    const adapter = makeAdapter(fake);
    await adapter.connect();

    const report = adapter.passiveFolderReport();
    expect(report.read).toHaveLength(PASSIVE_FOLDERS_MAX_NO_STATUS);
    expect(report.overflow).toHaveLength(8);
  });

  it("skips a provably-unchanged passive folder without a SELECT", async () => {
    // One LIST-STATUS command replaces a SELECT per folder. On the mailbox that produced this slice
    // that is 1 command instead of ~110, every cycle, to learn that nothing happened.
    //
    // Mutation watched: delete the `unchangedPassive` early `continue` in `changesSince` and
    // `selected` carries the archive on the second cycle — `expected [ 'Archive' ] to have a
    // length of +0`.
    const folders = { ...emptyWatched(), Archive: folder({ uids: [1, 2] }) };
    const fake = makeFakeClient(folders, { listStatus: true });
    const adapter = makeAdapter(fake);
    await adapter.connect();

    // A cursor that has never seen this folder — nothing is provable, so it is READ.
    const fresh = cursorFor(folders);
    await adapter.changesSince(fresh);
    expect(fake.selected, "an unknown passive folder is always selected").toContain("Archive");

    // …and once the cursor states the folder AND the three equalities hold, it is not touched.
    const settled = cursorFor(folders, { known: [...WATCHED_FOLDERS, "Archive"] });
    fake.selected.length = 0;
    await adapter.changesSince(settled);
    expect(fake.selected.filter((p) => p === "Archive")).toHaveLength(0);
    // …and the watched folders are still selected every cycle: the skip is passive-only, because the
    // hot path is where the product happens.
    expect(fake.selected).toContain("INBOX");
  });

  it("does NOT skip a passive folder whose message count moved — the expunge CONDSTORE hides", async () => {
    // CONDSTORE does not raise HIGHESTMODSEQ for an EXPUNGE (that is what QRESYNC's VANISHED exists
    // for), so `messages` is the only one of the three equalities that can see a deletion. Mutation
    // watched: drop the `status.messages` term from `unchangedPassive` and this folder is skipped
    // for ever with a row pointing at a UID the server does not hold.
    const folders = { ...emptyWatched(), Archive: folder({ uids: [1, 2] }) };
    const fake = makeFakeClient(folders, { listStatus: true });
    const adapter = makeAdapter(fake);
    await adapter.connect();
    const cursor = cursorFor(folders, { known: [...WATCHED_FOLDERS, "Archive"] });
    await adapter.changesSince(cursor);

    // The customer deletes one message from their own archive. UIDNEXT and HIGHESTMODSEQ are both
    // untouched — the only thing that moved is EXISTS.
    folders["Archive"]!.uids = [1];
    fake.selected.length = 0;
    const batch = await adapter.changesSince(cursor);

    expect(fake.selected).toContain("Archive");
    expect(batch.deletes.map((d) => d.locator.folder)).toContain("Archive");
  });

  /**
   * ═══ A COUNTER IS MEANINGFUL ONLY INSIDE ITS EPOCH ══════════════════════════════════════
   *
   * The three equalities are all satisfiable by a folder that was DELETED AND RECREATED: a
   * customer who empties `Archive` and refiles it, a migration tool, a server-side restore. The
   * numbers then agree and name nothing in common, so the skip serves the old contents for ever
   * — every later cycle takes the same shortcut — and the replacement mail is on the server and
   * not in ohmail. The counters are set deliberately equal here so the case cannot pass by
   * accident.
   */
  it("does NOT skip a passive folder that was recreated under a new UIDVALIDITY", async () => {
    const folders = { ...emptyWatched(), Archive: folder({ uids: [1, 2] }) };
    const fake = makeFakeClient(folders, { listStatus: true });
    const adapter = makeAdapter(fake);
    await adapter.connect();
    const cursor = cursorFor(folders, { known: [...WATCHED_FOLDERS, "Archive"] });
    await adapter.changesSince(cursor);

    // The folder is replaced. Two messages again, so EXISTS matches; uids re-issued from 1, so
    // UIDNEXT matches; the modseq restarts at the same place, so HIGHESTMODSEQ matches. Only the
    // epoch moved, and the two messages are DIFFERENT mail.
    folders["Archive"]!.uidValidity = 200n;
    folders["Archive"]!.uids = [1, 2];
    folders["Archive"]!.uidNext = 3;
    folders["Archive"]!.serverModseq = 60n;
    fake.selected.length = 0;
    const batch = await adapter.changesSince(cursor);

    expect(fake.selected, "a recreated folder kept serving its old contents").toContain("Archive");
    // …and the replacement mail arrives: every uid under the new epoch is a create.
    expect(batch.creates.filter((c) => c.locator.folder === "Archive")).toHaveLength(2);
    // …and the published cursor names the epoch the folder is actually at.
    expect(batch.newCursor.folders["Archive"]!.uidValidity).toBe("200");
  });

  /**
   * THE FAIL-CLOSED ARM. A server that answers LIST-STATUS without a UIDVALIDITY item proves
   * nothing about the epoch, and the shortcut's whole licence is a proof — its fallback is one
   * SELECT, which is cheap, while being wrong costs somebody's mail. (The cleanups in
   * `ohmail/_meta` take the opposite policy over the same comparison, and for the opposite
   * reason: refusing there would strand a mailbox permanently.)
   */
  it("does NOT skip when the server states no UIDVALIDITY in its STATUS", async () => {
    const folders = { ...emptyWatched(), Archive: folder({ uids: [1, 2] }) };
    const fake = makeFakeClient(folders, { listStatus: true, listStatusHidesUidValidity: true });
    const adapter = makeAdapter(fake);
    await adapter.connect();
    const cursor = cursorFor(folders, { known: [...WATCHED_FOLDERS, "Archive"] });
    await adapter.changesSince(cursor);
    fake.selected.length = 0;

    await adapter.changesSince(cursor);
    expect(fake.selected.filter((p) => p === "Archive"),
      "an unprovable epoch licensed the skip").toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
describe("a server whose CHANGEDSINCE is inert (iCloud, measured 2026-08-13)", () => {
  /**
   * The reproduction of the nine-day stall, at a scale a test can run.
   *
   * The mailbox's cursors are EXACT — every folder's `highestModseq` equals what the server reports,
   * every UID is known, nothing is owed — and the server answers `CHANGEDSINCE <its own
   * HIGHESTMODSEQ>` with every message in the folder anyway. The real server answered far more rows a
   * cycle than the flag budget; these keep that shape at a test's size.
   */
  const inertFolders = () => {
    const out = emptyWatched();
    out["INBOX"] = folder({ uids: Array.from({ length: 200 }, (_, i) => i + 1) });
    out["ohmail/News"] = folder({ uids: Array.from({ length: 500 }, (_, i) => i + 1) });
    out["ohmail/Screener"] = folder({ uids: Array.from({ length: 500 }, (_, i) => i + 1) });
    return out;
  };

  it("reaches hasBacklog === false — the one gate the initial-import stamp sits behind", async () => {
    // Mutation watched: restore `if (!canFastPath && (known.seen == null || known.seen === seen))`
    // in `changesSince` and this runs all 40 cycles with `hasBacklog` true on every one —
    // `expected -1 to be greater than 0`. That is the production defect, exactly: a mailbox fully
    // drained, motionless, and still described as importing.
    const folders = inertFolders();
    const fake = makeFakeClient(folders, { changedSinceIsInert: true });
    const adapter = makeAdapter(fake, { maxBatchFlags: 50 });
    await adapter.connect();
    const cursor = cursorFor(folders);

    let drainedAfter = -1;
    for (let cycle = 1; cycle <= 40; cycle++) {
      const batch = await adapter.changesSince(cursor);
      if (!batch.hasBacklog) { drainedAfter = cycle; break; }
    }

    expect(drainedAfter, "a caught-up mailbox must end a cycle owing nothing").toBeGreaterThan(0);
    // ON THE FIRST CYCLE, and that matters: the suppressed rows cost no budget at all, so this is
    // not "it drains eventually" but "there was never anything to drain".
    expect(drainedAfter).toBe(1);
  });

  it("reports NO flag change when the server's answer agrees with the baseline", async () => {
    const folders = inertFolders();
    const fake = makeFakeClient(folders, { changedSinceIsInert: true });
    const adapter = makeAdapter(fake, { maxBatchFlags: 50 });
    await adapter.connect();

    const batch = await adapter.changesSince(cursorFor(folders));

    // Every row arrived; not one of them is a change, because every one says what the database
    // already recorded. Suppressing exactly the applications that would have been no-ops.
    expect(batch.flagChanges).toEqual([]);
    // …and the cursor ADVANCES, which is what a held `highestModseq` never did.
    expect(batch.newCursor.folders["ohmail/News"]!.highestModseq).toBe("60");
  });

  it("still reports a REAL flag change from the same inert server", async () => {
    // The filter must not be a mute button. Same server, same inert CHANGEDSINCE, but now the server
    // holds `\Seen` false where the database recorded true — a genuine divergence, and the whole
    // point of mirroring read state inbound.
    const folders = inertFolders();
    const fake = makeFakeClient(folders, { changedSinceIsInert: true, seenFlag: false });
    const adapter = makeAdapter(fake, { maxBatchFlags: 50 });
    await adapter.connect();

    const batch = await adapter.changesSince(cursorFor(folders));

    expect(batch.flagChanges.length).toBeGreaterThan(0);
    expect(batch.flagChanges.every((c) => c.seen === false)).toBe(true);
    // …and it is BOUNDED by the budget, so a real "mark all read" still drains across cycles.
    expect(batch.flagChanges).toHaveLength(50);
    expect(batch.hasBacklog).toBe(true);
  });
});
