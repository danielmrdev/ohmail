import { describe, it, expect, afterEach } from "vitest";
import { ImapAdapter, MoveIncompleteError, MoveVerifyError, parseRef, makeRef } from "../../src/adapters/imap.js";
import { FIXTURE_DOOR } from "./_door.js";

/**
 * ═══ THE CONSENT GATE'S PARTIAL FAILURE: COPY LANDED, THE DELETE DID NOT ══════════════════
 *
 * The consent gate's ledger row carries three LIVE acceptances, and this file discharges the only
 * one a tree can reach: **the move that half happened.** The gate itself is demote-only and its
 * routing is proved elsewhere (`rules` slice 1, adoption slice 2, the auth verdict slice 3 —
 * "the consent gate runs before the heuristic", "adoption requires a disappearance" and "the
 * anti-spoofing verdict was parsed and then thrown away at ingest", 2026-08-03/04). What was
 * never driven is what the gate's own filing does to the MAILBOX when the second half of a
 * COPY+EXPUNGE pair is refused: the message is then in two folders, and the user is reading a
 * mailbox that holds their mail twice.
 *
 * ## Why this cannot be GreenMail
 *
 * GreenMail is an HONEST server: asked to expunge, it expunges. The partial state can only be
 * SEEDED there — `imap.move.test.ts` appends a copy into the destination by hand and calls the
 * result "a move that was interrupted". That proves the pre-check reads a copy somebody put
 * there; it does not prove that the gate's OWN move can produce that state, nor what the gate
 * tells its caller when it does. Both halves are the acceptance. So the server here is ours and
 * the adapter is the real `ImapAdapter` — the pattern `imap.hostile-server.test.ts` and
 * `imap.epoch-guard.test.ts` already use.
 *
 * ## The double fails the way the driver fails, which is NOT by throwing
 *
 * Measured in `imapflow@1.5.0`: `messageDelete` is `messageFlagsAdd(\Deleted)` then
 * `run('EXPUNGE')`, and BOTH command wrappers catch their own error and `return false`
 * (`lib/commands/store.js`, `lib/commands/expunge.js`). `messageDelete` returns the EXPUNGE's
 * verdict alone. So a refused delete reaches the adapter in one of two shapes, and a rejection
 * is not among them:
 *
 *   · `refuses`     — the UID EXPUNGE is refused ⇒ RESOLVES `false`, nothing removed;
 *   · `claims-done` — the STORE is refused and the EXPUNGE then runs on nothing ⇒ RESOLVES
 *                     `true`, nothing removed.
 *
 * `organizer-lease.ts` names both at `removeClaims` and refuses on each ("A refusal is a failure
 * here, exactly as a rejection is", and the custody re-read beneath it). This file asks the same
 * question of the filing path beside it.
 *
 * A `rejects` arm is kept as the third policy because it is the shape `move`'s own step-5
 * comment presumes ("A failure here leaves a duplicate … and the next reconcile pass retries the
 * whole move"), and a test that only drove the shape the code was written for would measure
 * nothing.
 *
 * ## The acceptance, in one sentence
 *
 * After the refused delete the mailbox holds the message TWICE; after the repair pass it holds
 * it ONCE — and the repair pass wrote nothing to the destination to get there.
 */

/** How the fake's EXPUNGE behaves — see the header for where each shape comes from. */
type DeletePolicy = "expunges" | "refuses" | "claims-done" | "rejects";

interface StoredMessage { uid: number; raw: Buffer; messageId: string }
interface FakeFolder { path: string; uidValidity: bigint; uidNext: number; messages: StoredMessage[] }

const cfg = { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } };

/** A minimal, PARSEABLE RFC822 message — `fingerprintOf` answers null for anything else. */
function eml(messageId: string, subject = "s"): Buffer {
  return Buffer.from([
    `Message-ID: <${messageId}>`,
    "From: sender@example.com",
    "To: reader@example.com",
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "body",
  ].join("\r\n"));
}

/**
 * A fake IMAP server that HOLDS MAIL — folders, uids, a uidvalidity per folder — so "exactly one
 * copy in the whole mailbox" is a count over its store and not a counter the fake incremented.
 * Only the socket's other end is ours; the adapter under test is the shipping one.
 */
function mailServer(o: {
  folders: Record<string, string[]>;
  caps?: Array<"MOVE" | "UIDPLUS">;
  deletePolicy?: () => DeletePolicy;
}) {
  const folders = new Map<string, FakeFolder>();
  let nextValidity = 1000n;
  for (const [path, ids] of Object.entries(o.folders)) {
    const f: FakeFolder = { path, uidValidity: nextValidity++, uidNext: 1, messages: [] };
    for (const id of ids) f.messages.push({ uid: f.uidNext++, raw: eml(id), messageId: id });
    folders.set(path, f);
  }
  const wire: string[] = [];
  const policy = o.deletePolicy ?? ((): DeletePolicy => "expunges");
  let current = "INBOX";
  const folderOf = (path: string): FakeFolder => {
    const f = folders.get(path);
    if (!f) throw new Error(`fake server: no such folder ${path}`);
    return f;
  };
  const view = (path: string): unknown => {
    const f = folderOf(path);
    return {
      path, uidValidity: f.uidValidity, uidNext: f.uidNext,
      highestModseq: 0n, exists: f.messages.length,
    };
  };
  const bare = (v: string): string => v.replace(/[<>]/g, "").trim();

  const client = {
    wire, folders,
    capabilities: new Map((o.caps ?? ["UIDPLUS"]).map((c) => [c, true] as const)),
    mailbox: view("INBOX"),
    async list() {
      return [...folders.keys()].map((path) => ({
        path, name: path.split("/").pop()!, delimiter: "/", flags: new Set<string>(),
      }));
    },
    async getMailboxLock(path: string) {
      current = path;
      client.mailbox = view(path);
      return { path, release() { /* nothing */ } };
    },
    async search(query: { header?: Record<string, string> }, _opts?: unknown) {
      const want = query.header?.["message-id"];
      if (want === undefined) return [];
      wire.push(`search ${current} ${want}`);
      return folderOf(current).messages.filter((m) => m.messageId === bare(want)).map((m) => m.uid);
    },
    async fetchOne(range: string, query?: { source?: boolean; envelope?: boolean }, _o?: unknown) {
      const uid = Number(range);
      wire.push(`fetchOne ${current}#${uid}${query?.source ? " +source" : ""}${query?.envelope ? " +envelope" : ""}`);
      const m = folderOf(current).messages.find((x) => x.uid === uid);
      // imapflow answers `false`, not null, for a range that matches nothing (`fetchOne` returns
      // `false` when the FETCH list is empty) — the shape the adapter's own existence probe reads.
      if (!m) return false;
      return {
        uid: m.uid,
        ...(query?.envelope ? { envelope: { messageId: `<${m.messageId}>` } } : {}),
        ...(query?.source ? { source: m.raw } : {}),
      };
    },
    async download(range: string, _part: unknown, opts?: { maxBytes?: number }) {
      const uid = Number(range);
      const m = folderOf(current).messages.find((x) => x.uid === uid);
      if (!m) return null;
      const cap = opts?.maxBytes ?? Number.POSITIVE_INFINITY;
      return {
        meta: { expectedSize: m.raw.length, contentType: "message/rfc822", filename: null },
        content: (async function* () {
          if (m.raw.length <= cap) yield m.raw;
          else yield m.raw.subarray(0, cap);
        })(),
      };
    },
    async messageCopy(uids: number[], to: string, _o?: unknown) {
      const src = folderOf(current);
      const dst = folderOf(to);
      const uidMap = new Map<number, number>();
      for (const uid of uids) {
        const m = src.messages.find((x) => x.uid === uid);
        if (!m) continue;
        const landed = dst.uidNext++;
        dst.messages.push({ uid: landed, raw: m.raw, messageId: m.messageId });
        uidMap.set(uid, landed);
        wire.push(`copy ${current}#${uid} → ${to}#${landed}`);
      }
      return { path: current, destination: to, uidValidity: dst.uidValidity, uidMap };
    },
    async messageMove(uids: number[], to: string, _o?: unknown) {
      const res = await client.messageCopy(uids, to);
      const src = folderOf(current);
      src.messages = src.messages.filter((m) => !uids.includes(m.uid));
      wire.push(`move ${current} ${JSON.stringify(uids)} → ${to}`);
      return res;
    },
    async messageDelete(uids: number[], _o?: unknown) {
      const how = policy();
      wire.push(`delete ${current} ${JSON.stringify(uids)} (${how})`);
      if (how === "rejects") throw new Error("EXPUNGE failed");
      if (how === "refuses") return false;
      if (how === "claims-done") return true;   // the STORE was refused; the EXPUNGE took nothing
      const f = folderOf(current);
      f.messages = f.messages.filter((m) => !uids.includes(m.uid));
      return true;
    },
    async logout() { /* nothing */ },
    close() { /* nothing */ },
  };
  return client;
}

/** Every copy of one logical message, everywhere in the mailbox. */
function copiesOf(server: ReturnType<typeof mailServer>, messageId: string): string[] {
  const out: string[] = [];
  for (const f of server.folders.values()) {
    for (const m of f.messages) if (m.messageId === messageId) out.push(`${f.path}#${m.uid}`);
  }
  return out.sort();
}

function inboxRef(server: ReturnType<typeof mailServer>, messageId: string): string {
  const inbox = server.folders.get("INBOX")!;
  const m = inbox.messages.find((x) => x.messageId === messageId)!;
  return makeRef(inbox.uidValidity, m.uid);
}

describe("the consent gate's filing, with the destination copy made and the source delete refused", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  /**
   * THE POSITIVE CONTROL. An ordinary demotion to the Screener is admitted: one copy in the
   * mailbox, in the destination, and exactly one COPY on the wire. Every refusal below is read
   * against this.
   */
  it("files a message into ohmail/Screener and leaves exactly one copy", async () => {
    const server = mailServer({ folders: { "INBOX": ["plain@x"], "ohmail/Screener": [] } });
    adapter = new ImapAdapter(cfg, { client: server });
    await adapter.connect();
    const ref = inboxRef(server, "plain@x");

    const landed = await adapter.move({ folder: "INBOX", ref }, "ohmail/Screener", FIXTURE_DOOR);

    expect(landed.folder).toBe("ohmail/Screener");
    expect(copiesOf(server, "plain@x")).toEqual([`ohmail/Screener#${parseRef(landed.ref).uid}`]);
    expect(server.wire.filter((w) => w.startsWith("copy ")).length).toBe(1);
  });

  /**
   * ── THE ACCEPTANCE ────────────────────────────────────────────────────────────────────────
   *
   * Three refusal shapes, driven as one case each. In every one the FIRST move must leave the
   * caller holding a failure — because the mailbox is now holding the message twice, and a
   * caller told the move succeeded commits the destination locator and never comes back. Then
   * the repair pass runs against a server that has recovered, and the mailbox must hold ONE.
   */
  const REFUSAL = {
    // The fake threw, so the driver's own error propagates untouched — `move` adds nothing.
    "rejects": { class: Error, because: null },
    // The two shapes imapflow actually produces, each named by the field that says which.
    "refuses": { class: MoveIncompleteError, because: "refused" },
    "claims-done": { class: MoveIncompleteError, because: "survived" },
  } as const;

  for (const how of ["rejects", "refuses", "claims-done"] as const) {
    it(`refuses the move when the expunge ${how}, and the repair pass leaves exactly one copy`, async () => {
      let policy: DeletePolicy = how;
      const server = mailServer({
        folders: { "INBOX": ["half@x"], "ohmail/Screener": [] },
        deletePolicy: () => policy,
      });
      adapter = new ImapAdapter(cfg, { client: server });
      await adapter.connect();
      const ref = inboxRef(server, "half@x");

      // The half-done move. The COPY lands; the delete does not.
      const expected = REFUSAL[how];
      const err = await adapter.move({ folder: "INBOX", ref }, "ohmail/Screener", FIXTURE_DOOR).then(
        (ok) => { throw new Error(`a move whose source was not expunged resolved ${JSON.stringify(ok)}`); },
        (e: unknown) => e,
      );
      expect(err, "a move whose source was not expunged has not happened").toBeInstanceOf(expected.class);
      if (expected.because !== null) {
        expect((err as MoveIncompleteError).because, "the refusal names which half failed")
          .toBe(expected.because);
      }

      // THE PARTIAL STATE IS REAL, and it is the user's mailbox holding their mail twice.
      expect(copiesOf(server, "half@x").length, "the copy landed and the source stayed").toBe(2);

      // THE REPAIR PASS — the same move, against a server that now expunges.
      policy = "expunges";
      const copiesBefore = server.wire.filter((w) => w.startsWith("copy ")).length;
      const landed = await adapter.move({ folder: "INBOX", ref }, "ohmail/Screener", FIXTURE_DOOR);

      expect(copiesOf(server, "half@x"), "exactly one copy, in the destination")
        .toEqual([`ohmail/Screener#${parseRef(landed.ref).uid}`]);
      expect(
        server.wire.filter((w) => w.startsWith("copy ")).length - copiesBefore,
        "the repair pass must ADOPT its own copy, never make a second",
      ).toBe(0);
    });
  }

  /**
   * THE COST, ASSERTED. The custody read lives inside `if (sourceAwaitingDelete)`, which an atomic
   * `UID MOVE` never enters — the comment at step 5 says "an atomic MOVE never reaches it", so the
   * claim is measured rather than left as prose. Moved out of the branch, this case reddens.
   */
  it("pays nothing on a server with MOVE: no custody read after an atomic move", async () => {
    const server = mailServer({ folders: { "INBOX": ["atomic@x"], "ohmail/Screener": [] }, caps: ["UIDPLUS", "MOVE"] });
    adapter = new ImapAdapter(cfg, { client: server });
    await adapter.connect();
    const ref = inboxRef(server, "atomic@x");

    const landed = await adapter.move({ folder: "INBOX", ref }, "ohmail/Screener", FIXTURE_DOOR);

    expect(copiesOf(server, "atomic@x")).toEqual([`ohmail/Screener#${parseRef(landed.ref).uid}`]);
    const afterMove = server.wire.slice(server.wire.findIndex((w) => w.startsWith("move ")) + 1);
    expect(afterMove.filter((w) => w.startsWith("fetchOne ")), "no read is owed after an atomic move")
      .toEqual([]);
    expect(server.wire.filter((w) => w.startsWith("delete ")), "and no expunge of our own").toEqual([]);
  });

  /**
   * The fence under the repair pass, stated as its own case so the mutation has a subject: with
   * the destination pre-check gone, the retry copies again and the destination grows. Kept
   * separate from the acceptance because the acceptance asserts the OUTCOME and this asserts the
   * MECHANISM that produces it.
   */
  it("adopts the copy it already made rather than copying a second time", async () => {
    const server = mailServer({ folders: { "INBOX": ["fence@x"], "ohmail/Screener": [] } });
    adapter = new ImapAdapter(cfg, { client: server });
    await adapter.connect();
    const inbox = server.folders.get("INBOX")!;
    const screener = server.folders.get("ohmail/Screener")!;
    // Verbatim the state the refused delete leaves: our own copy at the destination, the source
    // still in INBOX.
    const m = inbox.messages[0]!;
    screener.messages.push({ uid: screener.uidNext++, raw: m.raw, messageId: m.messageId });

    const landed = await adapter.move({ folder: "INBOX", ref: inboxRef(server, "fence@x") }, "ohmail/Screener", FIXTURE_DOOR);

    expect(copiesOf(server, "fence@x")).toEqual([`ohmail/Screener#${parseRef(landed.ref).uid}`]);
    expect(server.wire.filter((w) => w.startsWith("copy ")).length, "no second copy may be made").toBe(0);
  });

  /**
   * And the refusal that must NOT converge: two copies at the destination cannot be told apart,
   * so the move refuses before writing and the source stays. The mirror of the case above — it
   * is what stops the adopt branch being written as "anything at the destination will do".
   */
  it("refuses, writing nothing, when the destination holds two copies it cannot tell apart", async () => {
    const server = mailServer({ folders: { "INBOX": ["amb@x"], "ohmail/Screener": [] } });
    adapter = new ImapAdapter(cfg, { client: server });
    await adapter.connect();
    const inbox = server.folders.get("INBOX")!;
    const screener = server.folders.get("ohmail/Screener")!;
    const m = inbox.messages[0]!;
    screener.messages.push({ uid: screener.uidNext++, raw: m.raw, messageId: m.messageId });
    screener.messages.push({ uid: screener.uidNext++, raw: m.raw, messageId: m.messageId });

    await expect(adapter.move({ folder: "INBOX", ref: inboxRef(server, "amb@x") }, "ohmail/Screener", FIXTURE_DOOR))
      .rejects.toBeInstanceOf(MoveVerifyError);
    expect(copiesOf(server, "amb@x").length, "an ambiguous destination must not grow").toBe(3);
    expect(server.wire.filter((w) => w.startsWith("copy ")).length).toBe(0);
  });
});
