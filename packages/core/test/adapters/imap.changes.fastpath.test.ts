import { describe, it, expect } from "vitest";
import { ImapFlow } from "imapflow";
import { randomUUID } from "node:crypto";
import { ImapAdapter, parseRef } from "../../src/adapters/imap.js";
import type { ImapConfig, ImapCursor } from "../../src/adapters/imap-types.js";
import { CONDSTORE_HOST, CONDSTORE_PORT, probeCondstore } from "./_imapenv.js";
import { FIXTURE_DOOR } from "./_door.js";

interface FakeBox { path: string; uidValidity: bigint; uidNext: number; highestModseq: bigint; exists: number; }

/** Minimal fake covering exactly what changesSince's fast path calls. Only INBOX holds messages. */
function makeFakeClient() {
  const src = Buffer.from("Message-ID: <new@x>\r\nSubject: n\r\n\r\nbody");
  const calls: Array<{ range: unknown; query: unknown; options: unknown }> = [];
  const inbox: FakeBox = { path: "INBOX", uidValidity: 100n, uidNext: 12, highestModseq: 50n, exists: 2 };
  const empty = (path: string): FakeBox => ({ path, uidValidity: 100n, uidNext: 1, highestModseq: 0n, exists: 0 });
  const client = {
    capabilities: new Map<string, boolean>([["CONDSTORE", true], ["MOVE", true], ["UIDPLUS", true], ["IDLE", true]]),
    mailbox: inbox as FakeBox,
    calls,
    _path: "INBOX",
    async list() { return [{ path: "INBOX", name: "INBOX", delimiter: "/", flags: new Set<string>() }]; },
    async getMailboxLock(path: string) {
      this._path = path;
      this.mailbox = path === "INBOX" ? inbox : empty(path);
      return { path, release() {} };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *fetch(range: any, query: any, options: any) {
      calls.push({ range, query, options });
      if (this._path !== "INBOX") return;
      if (options?.changedSince) {
        // Everything touched since the cursor: uid 11 is new, uid 5 is a flag-change on a
        // known message. `changesSince` now takes creates from the capped unknown-UID path
        // and uses this fetch for FLAGS ONLY, so it no longer requests bodies here.
        yield { uid: 11, flags: new Set(["\\Seen"]), modseq: 51n };
        yield { uid: 5, flags: new Set<string>(), modseq: 51n };
      } else if (query?.source) {
        // The capped body fetch, for the explicit UID list it was given.
        for (const uid of range as number[]) {
          yield { uid, flags: new Set<string>(), envelope: { messageId: `<u${uid}@x>` }, source: src };
        }
      } else if (query?.size) {
        // The RFC822.SIZE pre-fetch that enforces the byte budget.
        for (const uid of range as number[]) yield { uid, size: src.length };
      } else {
        // uid-only enumeration → current UID set {5, 11}
        yield { uid: 5 }; yield { uid: 11 };
      }
    },
  };
  return client;
}

describe("ImapAdapter.changesSince — CONDSTORE fast path (fake)", () => {
  it("uses changedSince and partitions creates vs flag-changes", async () => {
    const fake = makeFakeClient();
    const adapter = new ImapAdapter(
      { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } },
      { client: fake },
    );
    await adapter.connect();

    const cursor: ImapCursor = { folders: {} };
    cursor.folders["INBOX"] = { uidValidity: "100", uidNext: 10, highestModseq: "50", known: [{ uid: 5, messageId: "old@x" }] };
    for (const f of ["ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"]) {
      cursor.folders[f] = { uidValidity: "0", uidNext: 0, highestModseq: "0", known: [] };
    }

    const batch = await adapter.changesSince(cursor);

    // changedSince was passed for the INBOX fetch
    const usedChangedSince = fake.calls.some((c) => (c.options as { changedSince?: bigint } | undefined)?.changedSince === 50n);
    expect(usedChangedSince).toBe(true);

    expect(batch.creates).toHaveLength(1);
    expect(parseRef(batch.creates[0].locator.ref).uid).toBe(11);
    expect(batch.flagChanges).toHaveLength(1);
    expect(parseRef(batch.flagChanges[0].locator.ref).uid).toBe(5);
    expect(batch.flagChanges[0].seen).toBe(false);
    expect(batch.newCursor.folders["INBOX"].highestModseq).toBe("50");
  });
});

/**
 * ── THE REAL SERVER, AND WHY THE FAKE ABOVE IS NOT ENOUGH ──────────────────────────
 *
 * GreenMail — the server every other IMAP test in this repo uses — advertises no CONDSTORE
 * (`* CAPABILITY IMAP4rev1 LITERAL+ UIDPLUS SORT IDLE MOVE QUOTA`), so all of them exercise the
 * FALLBACK branch. Production advertises `ENABLE, CONDSTORE, QRESYNC` and takes the branch
 * below for every real mailbox's read-state. Until 2026-08-04 this describe could not run at
 * all: `test/dovecot/dovecot.conf` had two defects that stopped the container from starting.
 *
 * Both are fixed, and the first thing that ran here asserted only
 * `capabilities().condstore === true` — which pins the CAPABILITY and says nothing about the
 * BEHAVIOUR. `changedSince`, the split of creates from flag changes, and the modseq advance
 * were still covered only by the fake, and a mutation of the fast path failed in the FAKE
 * describe, i.e. the real-server test was not what carried the guard.
 *
 * The case below is the sequence run by hand on the hosted service, turned into a test.
 *
 * WHAT MAKES IT A TEST OF THE CONDSTORE BRANCH SPECIFICALLY, rather than of syncing in
 * general: `flagChanges` is produced in exactly one place in `changesSince`, inside
 * `if (canFastPath)`, and the fallback path documents that it cannot derive flag changes at
 * all. So a non-empty `flagChanges` from a real server IS the CONDSTORE branch having run —
 * there is no other producer — and `caps.condstore` is one of its four conjuncts.
 */
/* THE PORT USED TO COME FROM `IMAP_PORT`, WHICH CI SETS TO 3143 — GREENMAIL. Nothing caught it
 * because the suite below was gated on `IMAP_CONDSTORE`, which nothing sets, so this line had
 * never chosen a port in anger. It is now the same variable `organizer-peek.imap.test.ts` reads,
 * resolved once in `_imapenv.ts`; the two files disagreed about where Dovecot lives. */

/** A fresh Dovecot user per test — the static passdb accepts any name with this password. */
function dovecotConfig(): ImapConfig {
  return {
    host: CONDSTORE_HOST, port: CONDSTORE_PORT, secure: false,
    auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: "testpass-password" },
  };
}

/** A second, INDEPENDENT connection: the "other mail client" whose writes we must observe. */
async function otherClient(cfg: ImapConfig): Promise<ImapFlow> {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  return c;
}

/* DETECTED, NOT DECLARED — see `probeCondstore`. The env var stays a force-on override. */
const CONDSTORE = await probeCondstore();
const CONDSTORE_WHY = CONDSTORE.ok ? "" : CONDSTORE.why;

/* A SKIP NOBODY CAN SEE IS HOW THESE SEVEN TESTS WENT A DAY WITHOUT RUNNING while their server
 * was up. When the probe finds nothing, the suite still reports a test — named with the port it
 * could not reach and what to start — so the absence is visible in the run rather than inferred
 * from a count. */
if (!CONDSTORE.ok) {
  /* PRINTED, because a skipped test's NAME is not shown by any reporter this repo runs — checked
   * with `--reporter=verbose`, which lists passes and failures and omits skips entirely. The name
   * below is still there for JSON/CI consumers; this line is what a person sees. */
  console.warn(`\n[condstore] SKIPPING the CONDSTORE fast path — ${CONDSTORE_WHY}\n`);
  describe("ImapAdapter.changesSince — CONDSTORE fast path (Dovecot)", () => {
    it.skip(`NOT RUN — ${CONDSTORE_WHY}`, () => { /* the name is the report */ });
  });
}

describe.skipIf(!CONDSTORE.ok)("ImapAdapter.changesSince — CONDSTORE fast path (Dovecot)", () => {
  it("reports condstore capability against a real server", async () => {
    const adapter = new ImapAdapter(dovecotConfig());
    await adapter.connect();
    expect((await adapter.capabilities()).condstore).toBe(true);
    await adapter.close();
  });

  it("reports a flag set by ANOTHER client, as a flag change and not a create, and advances the modseq", async () => {
    const cfg = dovecotConfig();
    const adapter = new ImapAdapter(cfg);
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);
    expect((await adapter.capabilities()).condstore).toBe(true);

    // ── two messages, appended by something that is not us ──────────────────────────────
    const ids = [`fp-a-${randomUUID()}@x`, `fp-b-${randomUUID()}@x`];
    const other = await otherClient(cfg);
    try {
      const lock = await other.getMailboxLock("INBOX");
      try {
        for (const id of ids) {
          await other.append("INBOX", [
            `Message-ID: <${id}>`, "From: s@x.example", "To: g@lichtgrat.example",
            `Subject: ${id}`, "Content-Type: text/plain; charset=utf-8", "", "hello",
          ].join("\r\n"));
        }
      } finally { lock.release(); }
    } finally { await other.logout(); }

    // ── pass 1: the COLD pass. No baseline modseq, so this is the fallback branch, and its
    //    job here is to produce the baseline the fast path needs. ────────────────────────
    const cold = await adapter.changesSince({ folders: {} });
    expect(cold.creates).toHaveLength(2);
    const baseline = cold.newCursor.folders["INBOX"]!;
    // The precondition for `canFastPath`: a real server published a real modseq.
    expect(BigInt(baseline.highestModseq)).toBeGreaterThan(0n);

    // The cursor the worker would hold: the published watermarks plus the known-set, which
    // `sync.ts` rebuilds from its own rows. Without `known`, every UID reads as a create.
    const cursor: ImapCursor = { folders: {} };
    for (const [name, f] of Object.entries(cold.newCursor.folders)) {
      cursor.folders[name] = { ...f, known: [] };
    }
    const uids = cold.creates.map((c) => parseRef(c.locator.ref).uid).sort((a, b) => a - b);
    cursor.folders["INBOX"] = {
      ...baseline,
      known: uids.map((uid) => ({ uid, messageId: null })),
    };

    // ── the other client marks ONE of them read, AND a third message arrives ────────────
    //
    // The third message is not decoration; it is what makes this a test of the PARTITION.
    // Both events push a UID's modseq above the baseline, so `changedSince` returns both, and
    // the only thing that keeps the new arrival out of `flagChanges` is the known-set filter
    // inside the fast path. Without it, a mailbox receiving mail would report every new message
    // as a read-state change as well as a create. Verified by mutation: deleting that filter
    // leaves a two-message version of this test GREEN and fails only the fake.
    const target = uids[0]!;
    const untouched = uids[1]!;
    const arrivalId = `fp-c-${randomUUID()}@x`;
    const marker = await otherClient(cfg);
    try {
      const lock = await marker.getMailboxLock("INBOX");
      try {
        await marker.messageFlagsAdd(String(target), ["\\Seen"], { uid: true });
        await marker.append("INBOX", [
          `Message-ID: <${arrivalId}>`, "From: s@x.example", "To: g@lichtgrat.example",
          `Subject: ${arrivalId}`, "Content-Type: text/plain; charset=utf-8", "", "hello",
        ].join("\r\n"));
      } finally { lock.release(); }
    } finally { await marker.logout(); }

    // ── pass 2: the branch production takes ─────────────────────────────────────────────
    const batch = await adapter.changesSince(cursor);

    // The new arrival, and ONLY it: the read message's modseq also moved, and a fast path that
    // re-sourced everything above the cursor — the shape this code had before the flag/body
    // split, and the one that reproduced the 2026-08-01 OOM — would report it as a create too.
    expect(batch.creates).toHaveLength(1);
    const created = batch.creates[0]!;
    const arrivalUid = parseRef(created.locator.ref).uid;
    // The BODY came with it — the create carries bytes, which is the half `changedSince` must
    // not be asked to supply.
    expect(created.raw?.toString("utf8")).toContain(arrivalId);
    expect(uids).not.toContain(arrivalUid);

    // EXACTLY the message the other client touched, with the flag it set. Not "at least one":
    // `changedSince` returning the whole folder would also satisfy a length-≥-1 assertion, and
    // that is the failure this is here to catch. The two negatives are the two ways to be
    // wrong — the message nothing happened to (no `changedSince` at all), and the new arrival
    // (no known-set filter).
    expect(batch.flagChanges).toHaveLength(1);
    expect(parseRef(batch.flagChanges[0]!.locator.ref).uid).toBe(target);
    expect(batch.flagChanges[0]!.seen).toBe(true);
    expect(batch.flagChanges[0]!.locator.folder).toBe("INBOX");
    const flagged = batch.flagChanges.map((f) => parseRef(f.locator.ref).uid);
    expect(flagged).not.toContain(untouched);
    expect(flagged).not.toContain(arrivalUid);

    // The modseq MOVED, which is what makes the next cycle cheap — and is the field
    // showed advancing in production. A pass that reported the change but republished
    // the old watermark would re-report it for ever.
    const next = batch.newCursor.folders["INBOX"]!;
    expect(BigInt(next.highestModseq)).toBeGreaterThan(BigInt(baseline.highestModseq));

    // …and the advance settles: a third pass from the new cursor, with the arrival now known,
    // reports nothing. This is the half that proves the advance is real rather than a value
    // nobody consumes — a cursor that did not move would re-report the same flag for ever.
    const settled = await adapter.changesSince({
      folders: {
        ...cursor.folders,
        INBOX: { ...next, known: [...cursor.folders["INBOX"]!.known, { uid: arrivalUid, messageId: null }] },
      },
    });
    expect(settled.flagChanges).toHaveLength(0);
    expect(settled.creates).toHaveLength(0);

    await adapter.close();
  }, 30_000);
});
