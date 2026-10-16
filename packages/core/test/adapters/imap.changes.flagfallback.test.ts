import { describe, it, expect } from "vitest";
import { ImapAdapter } from "../../src/adapters/imap.js";
import type { ImapCursor } from "../../src/adapters/imap-types.js";

/**
 * FLAG CHANGES WITHOUT CONDSTORE — the Exchange read-state mirror.
 *
 * Office 365's IMAP endpoint advertises no CONDSTORE (measured live:
 * `IMAP4 IMAP4rev1 AUTH=PLAIN AUTH=XOAUTH2 SASL-IR UIDPLUS MOVE ID UNSELECT CHILDREN IDLE
 * NAMESPACE LITERAL+`), so `canFastPath` is false on every cycle and the fast path's
 * `changedSince` fetch never runs. Until the fallback below existed, that meant NO flag change
 * was ever derived for such a mailbox — the line read "Flag changes are not derivable without
 * prior flags on the fallback path (documented limitation)" — and mail read in Outlook stayed
 * bold in ohmail for ever. The persisted cursors of a real Office 365 mailbox showed
 * `highestModseq = 0` on all seven folders while every CONDSTORE mailbox beside it carried real
 * modseqs, and its `flag_state` held not one `external` row.
 *
 * The known-set now carries the seen state the database last observed
 * (`flag_state.observed_seen`, or the ingest-time `!unread` before any flag row exists), which
 * IS the prior flags that comment said were missing. The fallback fetches FLAGS for the known
 * range — no `changedSince` — and emits a change only where the server disagrees with that
 * baseline, so a clean folder emits nothing however large it is.
 *
 * The user-wins decision stays in `applyExternalFlag`: the adapter's diff is a COST filter, not
 * an authority. A baseline the repo could not state (`seen: null` — e.g. a dead-lettered UID)
 * is never diffed.
 */

interface Msg { uid: number; seen: boolean }

const SRC = Buffer.from("Message-ID: <u@x>\r\nSubject: n\r\n\r\nbody");

/**
 * A server WITHOUT CONDSTORE. `fetch` distinguishes the adapter's three reads the same way the
 * real server does: enumeration (`{uid}` only), capped creates (`size`/`source` over a UID
 * list), and the fallback flags read (`{uid, flags}` with no `changedSince`). A `changedSince`
 * option THROWS — issuing one against a server that never advertised CONDSTORE is a protocol
 * error, and a fake that tolerated it would let the fast path masquerade as the fallback.
 */
function makeFakeClient(msgs: Msg[], unknown: number[] = []) {
  const inbox = { path: "INBOX", uidValidity: 100n, uidNext: 9999, highestModseq: 0n, exists: msgs.length + unknown.length };
  const empty = (path: string) => ({ path, uidValidity: 100n, uidNext: 1, highestModseq: 0n, exists: 0 });
  /** Every flags-read range the adapter issued — the ranges prove resumption. */
  const flagRanges: string[] = [];
  const client = {
    capabilities: new Map<string, boolean>([["MOVE", true], ["UIDPLUS", true], ["IDLE", true]]),
    mailbox: inbox as { path: string; uidValidity: bigint; uidNext: number; highestModseq: bigint; exists: number },
    inbox,
    flagRanges,
    _path: "INBOX",
    async list() { return [{ path: "INBOX", name: "INBOX", delimiter: "/", flags: new Set<string>() }]; },
    async getMailboxLock(path: string) {
      this._path = path;
      this.mailbox = path === "INBOX" ? inbox : empty(path);
      return { path, release() { /* no lock in the fake */ } };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *fetch(range: any, query: any, options: any) {
      if (options?.changedSince !== undefined) {
        throw new Error("changedSince issued against a server without CONDSTORE");
      }
      if (this._path !== "INBOX") return;
      if (query?.size) {
        for (const uid of range as number[]) yield { uid, size: SRC.length };
        return;
      }
      if (query?.source) {
        for (const uid of range as number[]) {
          yield { uid, flags: new Set<string>(), envelope: { messageId: `<u${uid}@x>` }, source: SRC };
        }
        return;
      }
      if (query?.flags) {
        // The fallback flags read. Honour the resume range: a fake that ignores it would pass
        // against an implementation that re-reads from 1 for ever.
        flagRanges.push(String(range));
        const from = Number(String(range).split(":")[0] ?? 1);
        for (const m of msgs) {
          if (m.uid < from) continue;
          yield { uid: m.uid, flags: new Set(m.seen ? ["\\Seen"] : []) };
        }
        for (const uid of unknown) {
          if (uid < from) continue;
          yield { uid, flags: new Set<string>() };
        }
        return;
      }
      // uid-only enumeration.
      for (const m of msgs) yield { uid: m.uid };
      for (const uid of unknown) yield { uid };
    },
  };
  return client;
}

/** A cursor whose known-set carries the database's seen baseline for every UID. */
function cursorFor(known: Array<{ uid: number; seen: boolean | null }>): ImapCursor {
  const cursor: ImapCursor = { folders: {} };
  cursor.folders["INBOX"] = {
    uidValidity: "100", uidNext: 9999, highestModseq: "0",
    known: known.map((k) => ({ uid: k.uid, messageId: `u${k.uid}@x`, seen: k.seen })),
  };
  for (const f of ["ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"]) {
    cursor.folders[f] = { uidValidity: "0", uidNext: 0, highestModseq: "0", known: [] };
  }
  return cursor;
}

function makeAdapter(fake: ReturnType<typeof makeFakeClient>, maxBatchFlags?: number) {
  return new ImapAdapter(
    { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } },
    { client: fake, ...(maxBatchFlags !== undefined ? { maxBatchFlags } : {}) },
  );
}

describe("ImapAdapter.changesSince — flag changes without CONDSTORE", () => {
  it("derives a flag change from the seen baseline: read in Outlook, adopted here", async () => {
    // Three known messages, all unread in the database. The server now reports uid 2 \Seen —
    // someone read it in Outlook. Exactly that one difference must come back.
    const fake = makeFakeClient([
      { uid: 1, seen: false },
      { uid: 2, seen: true },
      { uid: 3, seen: false },
    ]);
    const adapter = makeAdapter(fake);
    await adapter.connect();

    const batch = await adapter.changesSince(cursorFor([
      { uid: 1, seen: false }, { uid: 2, seen: false }, { uid: 3, seen: false },
    ]));

    expect(batch.flagChanges).toEqual([
      { type: "flag", locator: { folder: "INBOX", ref: "100:2" }, seen: true },
    ]);
    expect(batch.hasBacklog).toBe(false);
  });

  it("derives the reverse direction too: marked unread in Outlook", async () => {
    const fake = makeFakeClient([{ uid: 7, seen: false }]);
    const adapter = makeAdapter(fake);
    await adapter.connect();

    const batch = await adapter.changesSince(cursorFor([{ uid: 7, seen: true }]));

    expect(batch.flagChanges).toEqual([
      { type: "flag", locator: { folder: "INBOX", ref: "100:7" }, seen: false },
    ]);
  });

  it("emits NOTHING for a folder that agrees with the baseline", async () => {
    // The property that makes a full scan affordable: agreement is free. A fallback that
    // re-emitted the whole folder would put every message through applyExternalFlag on every
    // cycle.
    const fake = makeFakeClient([{ uid: 1, seen: true }, { uid: 2, seen: false }]);
    const adapter = makeAdapter(fake);
    await adapter.connect();

    const batch = await adapter.changesSince(cursorFor([{ uid: 1, seen: true }, { uid: 2, seen: false }]));

    expect(batch.flagChanges).toEqual([]);
    expect(batch.hasBacklog).toBe(false);
  });

  it("never diffs a baseline the repo could not state (seen: null)", async () => {
    const fake = makeFakeClient([{ uid: 4, seen: true }]);
    const adapter = makeAdapter(fake);
    await adapter.connect();

    const batch = await adapter.changesSince(cursorFor([{ uid: 4, seen: null }]));

    expect(batch.flagChanges).toEqual([]);
  });

  it("skips unknown UIDs — they are creates, and their \\Seen arrives with their body", async () => {
    const fake = makeFakeClient([{ uid: 1, seen: true }], [50]);
    const adapter = makeAdapter(fake);
    await adapter.connect();

    const batch = await adapter.changesSince(cursorFor([{ uid: 1, seen: false }]));

    // uid 50 is a create (it carries its own flags); only the known uid 1 produces a flag change.
    expect(batch.flagChanges).toEqual([
      { type: "flag", locator: { folder: "INBOX", ref: "100:1" }, seen: true },
    ]);
    expect(batch.creates.map((c) => c.locator.ref)).toEqual(["100:50"]);
  });

  it("caps one call at the flag budget and RESUMES by UID, losing nothing", async () => {
    // 25 divergences, budget 10: three passes drain the backlog exactly once each, and the
    // ranges prove the adapter moved rather than re-reading uids 1-10 for ever.
    const msgs = Array.from({ length: 25 }, (_, i) => ({ uid: i + 1, seen: true }));
    const fake = makeFakeClient(msgs);
    const adapter = makeAdapter(fake, 10);
    await adapter.connect();
    const cursor = cursorFor(msgs.map((m) => ({ uid: m.uid, seen: false })));

    const seen: number[] = [];
    let last = await adapter.changesSince(cursor);
    expect(last.hasBacklog, "a truncated fallback pass owes another cycle").toBe(true);
    for (let pass = 0; pass < 3; pass++) {
      for (const c of last.flagChanges) seen.push(Number(c.locator.ref.split(":")[1]));
      if (!last.hasBacklog) break;
      last = await adapter.changesSince(cursor);
    }

    expect(seen).toEqual(msgs.map((m) => m.uid));
    expect(new Set(seen).size).toBe(msgs.length);
    expect(fake.flagRanges).toEqual(["1:*", "11:*", "21:*"]);
  });

  it("leaves the Sent folder alone: forced-read outbox rows have no honest baseline", async () => {
    // `pipeline.ts` ingests own-sent mail `seen: true` REGARDLESS of what the server reported,
    // because a client that appends to Sent without `\Seen` would otherwise put the user's own
    // outbox into the unread count. That policy means an unflagged Sent row's database state is
    // not an observation of the server, so a diff against it would "adopt" a divergence nobody
    // created — flipping the user's own sent mail unread. The fallback therefore never scans
    // the Sent folder.
    const inbox = { path: "INBOX", uidValidity: 100n, uidNext: 9999, highestModseq: 0n, exists: 1 };
    const sent = { path: "Sent", uidValidity: 200n, uidNext: 9999, highestModseq: 0n, exists: 1 };
    const empty = (path: string) => ({ path, uidValidity: 100n, uidNext: 1, highestModseq: 0n, exists: 0 });
    const flagReads: string[] = [];
    const fake = {
      capabilities: new Map<string, boolean>([["MOVE", true]]),
      mailbox: inbox as { path: string; uidValidity: bigint; uidNext: number; highestModseq: bigint; exists: number },
      _path: "INBOX",
      async list() {
        return [
          { path: "INBOX", name: "INBOX", delimiter: "/", flags: new Set<string>() },
          { path: "Sent", name: "Sent", delimiter: "/", flags: new Set<string>(["\\Sent"]) },
        ];
      },
      async getMailboxLock(path: string) {
        this._path = path;
        this.mailbox = path === "INBOX" ? inbox : path === "Sent" ? sent : empty(path);
        return { path, release() { /* no lock in the fake */ } };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async *fetch(_range: any, query: any, options: any) {
        if (options?.changedSince !== undefined) {
          throw new Error("changedSince issued against a server without CONDSTORE");
        }
        if (query?.flags && !query?.size && !query?.source) flagReads.push(this._path);
        // One message everywhere: the server says unseen, the baseline says seen.
        yield { uid: 1, flags: new Set<string>() };
      },
    };
    const adapter = makeAdapter(fake as unknown as ReturnType<typeof makeFakeClient>);
    await adapter.connect();

    const cursor: ImapCursor = { folders: {} };
    cursor.folders["INBOX"] = {
      uidValidity: "100", uidNext: 9999, highestModseq: "0",
      known: [{ uid: 1, messageId: "a@x", seen: true }],
    };
    cursor.folders["Sent"] = {
      uidValidity: "200", uidNext: 9999, highestModseq: "0",
      known: [{ uid: 1, messageId: "b@x", seen: true }],
    };
    for (const f of ["ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"]) {
      cursor.folders[f] = { uidValidity: "0", uidNext: 0, highestModseq: "0", known: [] };
    }
    const batch = await adapter.changesSince(cursor);

    expect(flagReads).toContain("INBOX");
    expect(flagReads).not.toContain("Sent");
    expect(batch.flagChanges).toEqual([
      { type: "flag", locator: { folder: "INBOX", ref: "100:1" }, seen: false },
    ]);
  });
});
