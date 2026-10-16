import { describe, it, expect } from "vitest";
import { recordSentMessage } from "../src/sent-record.js";
import { planChange, commitChange , UNMETERED_STORAGE_CAP} from "../src/pipeline.js";
import { FakeRepo, dedupKeyFor } from "./fakes.js";
import type { AppendedSent } from "../src/send.js";
import type { Change, RepoPort, RoutingPort } from "../src/ports.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  RECORD-AT-SEND — the projection, and the ONE hazard that makes it dangerous
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `ImapAdapter.send` appends the compiled message to the mailbox's own Sent folder before it
 * returns, so the master already holds it. `recordSentMessage` writes the `messages` row from that
 * append instead of leaving it to the sync worker's next pass over Sent — which is a poll interval
 * away, and is the whole of "I see my sent message, but it took a minute".
 *
 * ## WHAT WOULD GO WRONG, AND WHAT EACH TEST BELOW BREAKS ON
 *
 * The projection is only safe because the row it writes is INDISTINGUISHABLE, to the dedup path,
 * from the row ingest would have written for the same message. That rests entirely on the
 * fingerprint, and the fingerprint rests entirely on the BYTES:
 *
 *  · `fingerprintSource` is the direct assertion, and it is the one that cannot be fooled: the
 *    stored `dedup_key` must be the key of the bytes that were appended. `OutboundMessage` carries
 *    no date at all — `MailComposer` stamps `Date:` at build time — so any rebuild stamps a
 *    different instant, and the fingerprint reads `date`. The test proves the two keys differ
 *    first, so it cannot pass vacuously.
 *  · `sameBytesSameUid` asserts the same key survives the worker's re-observation.
 *
 * ## THE MUTATION, AND WHERE IT ACTUALLY BITES
 *
 * Restamping `Date:` in `sent-record.ts` was run, and the result corrects the obvious expectation:
 * the worker's Sent-folder pass STAYS GREEN under a drifted key, because its change is
 * `ownAuthored` and `resolveExisting`'s own-sent-twin arm matches on Message-ID alone. The Sent
 * door masks the mistake entirely.
 *
 * `selfCcTwin` is the case that goes red, and it is the expensive one: an inbound copy — a self-CC,
 * a list echoing your own post back — is NOT own-authored, so the twin arm is gated off for the
 * forgery reason it exists, both key lookups miss, and the message ingests a SECOND time as
 * `"new"`. So the duplicate this whole design fears appears through the door nobody would test
 * first. Both that test and `fingerprintSource` were watched failing; the two after them are the
 * provider shapes that are legitimately not byte-identical and must still converge to one row.
 */

const OWNER = "mila@lichtgrat.example";
const SENT = "Sent";
const ACCOUNT = "acct-1";
const MAILBOX = "mbx-1";

/**
 * What `MailComposer` handed to `client.append` — CRLF line endings, headers in the order the
 * composer emits them. The exact bytes do not matter; that these are the bytes the projection is
 * given, and the ones the "server" hands back later, is the entire point.
 */
function appendedBytes(o: {
  messageId: string; subject?: string; to?: string; body?: string; inReplyTo?: string;
}): Buffer {
  return Buffer.from([
    `From: ${OWNER}`,
    `To: ${o.to ?? "anna@example.com"}`,
    `Subject: ${o.subject ?? "the north elevation"}`,
    ...(o.inReplyTo ? [`In-Reply-To: <${o.inReplyTo}>`, `References: <${o.inReplyTo}>`] : []),
    `Message-ID: <${o.messageId}>`,
    "Date: Thu, 13 Aug 2026 08:00:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    o.body ?? "Thursday works.",
    "",
  ].join("\r\n"));
}

/**
 * WHAT A REBUILD FROM THE `OutboundMessage` WOULD PRODUCE — and why it is not the same message.
 *
 * `OutboundMessage` carries `from`/`to`/`subject`/`text`/`messageId` and **no date**: the `Date:`
 * header is stamped by `MailComposer` at build time and exists nowhere else. So anything that
 * assembles an equivalent message afterwards stamps a different instant, and `messageFingerprint`
 * reads `date` as epoch milliseconds. The body drifts too — the composer normalizes newlines and
 * ends the part with one, and `sha256(textBody)` is in the fingerprint.
 *
 * Both drifts are in here because both are real, and either alone is enough: this is right by every
 * human reading and DIFFERENT by identity, which is exactly why the fingerprint may only ever be
 * computed from the bytes that were actually appended.
 *
 * (What is deliberately NOT modelled: a `Received:` chain and a different transfer encoding. Those
 * do not move the fingerprint — headers outside the list are not read, and the body is hashed after
 * decoding — and pretending they did would make this test pass for the wrong reason.)
 */
function outboundShapedBytes(o: { messageId: string; subject?: string; to?: string; body?: string }): Buffer {
  return Buffer.from([
    `From: ${OWNER}`,
    `To: ${o.to ?? "anna@example.com"}`,
    `Subject: ${o.subject ?? "the north elevation"}`,
    `Message-ID: <${o.messageId}>`,
    // One second later — a second `new Date()`, which is all a rebuild can do.
    "Date: Thu, 13 Aug 2026 08:00:01 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    // The draft's body verbatim, without the composer's trailing newline.
    o.body ?? "Thursday works.",
  ].join("\r\n"));
}

/**
 * A PROVIDER'S OWN RE-RENDERED SENT COPY — Exchange Online files its own version of every SMTP
 * submission into Sent Items beside the byte-exact copy the send path appended.
 *
 * Modelled as the RE-WRAPPED BODY, because that is the difference that actually moves the
 * fingerprint: the words are identical, the line breaks are not, and the body is hashed after
 * decoding. The `Received:` chain is here for realism and contributes nothing to the identity.
 */
function rerenderedBytes(o: { messageId: string; subject?: string; to?: string; body: string }): Buffer {
  return Buffer.from([
    "Received: from mail.example.test by EXCH01.example.test; Thu, 13 Aug 2026 08:00:01 +0000",
    `From: ${OWNER}`,
    `To: ${o.to ?? "anna@example.com"}`,
    `Subject: ${o.subject ?? "the north elevation"}`,
    `Message-ID: <${o.messageId}>`,
    "Date: Thu, 13 Aug 2026 08:00:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    // Re-wrapped at a narrower column than the composer chose.
    o.body.replace(/ and /, "\r\nand "),
    "",
  ].join("\r\n"));
}

/** A body long enough that a re-wrap at a different column is the ordinary thing to happen to it. */
const LONG_BODY = "Thursday works, and I will bring the revised drawings for the north elevation.";

/** `recordSentMessage`'s deps over one `FakeRepo`, with no transaction to open. */
function depsFor(repo: FakeRepo) {
  return {
    accountId: ACCOUNT,
    mailboxId: MAILBOX,
    storageCap: UNMETERED_STORAGE_CAP,
    repo: repo as RepoPort,
    // The fake has no transactions; `commitChange` reads `routing` only on the AI branch, which the
    // `ownAuthored` early return makes unreachable, so one object serves both roles.
    withTx: <T>(run: (r: RepoPort & RoutingPort) => Promise<T>): Promise<T> =>
      run(repo as unknown as RepoPort & RoutingPort),
  };
}

/** One `Change` as the SYNC WORKER would present it, having read `raw` at `ref` out of Sent. */
function workerSawInSent(raw: Buffer, ref: string): Change {
  return { type: "create", locator: { folder: SENT, ref }, raw, seen: true, ownAuthored: true };
}

/** Run the worker's two ingest phases over one change, exactly as `sync.ts` does. */
async function workerIngest(repo: FakeRepo, change: Change) {
  const plan = await planChange(change, { repo, accountId: ACCOUNT, mailboxId: MAILBOX });
  return commitChange(plan, {
    storageCap: UNMETERED_STORAGE_CAP,
    repo, routing: repo as unknown as RoutingPort, accountId: ACCOUNT, mailboxId: MAILBOX,
  });
}

describe("recordSentMessage — the just-appended Sent copy, recorded now", () => {
  // ── THE ACCEPTANCE ──────────────────────────────────────────────────────────────────────────
  it("ACCEPTANCE: the row exists with the sent content and carries the append's locator", async () => {
    const repo = new FakeRepo();
    const raw = appendedBytes({ messageId: "sent-1@lichtgrat.example" });
    const appended: AppendedSent = { locator: { folder: SENT, ref: "42:7" }, raw };

    const out = await recordSentMessage(appended, depsFor(repo));

    expect(out.outcome).toBe("new");
    expect(repo.rows.size).toBe(1);
    const row = repo.rows.get(out.messageId)!;

    // The content, from the bytes that were appended.
    expect(row.stored.messageIdHeader).toBe("sent-1@lichtgrat.example");
    expect(row.input.subject).toBe("the north elevation");
    expect(row.input.fromAddress).toBe(OWNER);
    expect(row.input.to.map((a) => a.address)).toEqual(["anna@example.com"]);
    expect(repo.bodies.get(out.messageId)!.text).toContain("Thursday works.");

    // THE LOCATOR — the UID the server answered the APPEND with, not a placeholder. This is also
    // what makes the worker's next pass free: `insertMessage` writes the primary instance, so the
    // adapter's known-set already holds this UID and never re-fetches it.
    expect(row.stored.nativeLocator).toEqual({ folder: SENT, ref: "42:7" });
    expect([...repo.instances.values()]).toEqual([
      { messageId: out.messageId, folder: SENT, ref: "42:7", isPrimary: true },
    ]);

    // NOT UNREAD, and NEVER MOVED: nothing the user wrote is new to them, and ohmail does not file
    // your Sent folder for you. `desired === observed` is the organize-in-place statement, and it
    // is why `action` is `none` rather than a move this projection would owe the reconciler.
    expect(row.input.unread).toBe(false);
    expect(out.action).toEqual({ type: "none" });
    expect(repo.folder.get(out.messageId)).toEqual({
      desiredFolder: SENT, observedFolder: SENT, lastSetBy: "us",
    });

    // THE CLIENT IS TOLD. Without a `message`/`create` row in `change_log` the projection is
    // invisible to every mirror and the whole slice buys nothing.
    const creates = repo.changes.filter((c) => c.entityType === "message" && c.op === "create");
    expect(creates.map((c) => c.entityId)).toEqual([out.messageId]);
    // And it is told nothing MOVED, because nothing did.
    expect(repo.changes.filter((c) => c.op === "move")).toEqual([]);
  });

  // ── THE FINGERPRINT SOURCE ──────────────────────────────────────────────────────────────────
  it("fingerprintSource: identity comes from the APPENDED BYTES, not from an equivalent rendering", async () => {
    const repo = new FakeRepo();
    const raw = appendedBytes({ messageId: "sent-2@lichtgrat.example" });
    const rebuilt = outboundShapedBytes({ messageId: "sent-2@lichtgrat.example" });

    // The premise, asserted rather than assumed: what a rebuild from the `OutboundMessage` can
    // produce does NOT share a fingerprint with what was appended. If this ever stops being true the
    // rest of this test proves nothing.
    const keyOfAppended = await dedupKeyFor(raw);
    const keyOfRebuilt = await dedupKeyFor(rebuilt);
    expect(keyOfRebuilt).not.toBe(keyOfAppended);

    const out = await recordSentMessage(
      { locator: { folder: SENT, ref: "42:8" }, raw }, depsFor(repo),
    );

    // Fingerprint the OutboundMessage shape instead of `appended.raw` and this is the line that
    // goes red.
    expect(repo.rows.get(out.messageId)!.input.dedupKey).toBe(keyOfAppended);
  });

  // ── THE DEDUP PROOF ────────────────────────────────────────────────────────────────────────
  it("sameBytesSameUid: the worker's later observation is a DUPLICATE — no second row, no churn", async () => {
    const repo = new FakeRepo();
    const raw = appendedBytes({ messageId: "sent-3@lichtgrat.example" });
    const projected = await recordSentMessage(
      { locator: { folder: SENT, ref: "42:9" }, raw }, depsFor(repo),
    );
    const changesAfterProjection = repo.changes.length;

    // The sync worker reads that very UID back out of Sent and ingests it, as `sync.ts` does.
    const observed = await workerIngest(repo, workerSawInSent(raw, "42:9"));

    // `observedFolder === knownFolder` ⇒ `duplicate`, decided BEFORE any evidence test.
    expect(observed.outcome).toBe("duplicate");
    expect(observed.messageId).toBe(projected.messageId);
    // ONE row for one message.
    expect(repo.rows.size).toBe(1);
    // …and it is still on the key the bytes in the mailbox compute. This is what makes the
    // `duplicate` above mean "the fingerprint matched" rather than "the own-sent-twin arm caught
    // it" — those two are indistinguishable from the outcome alone, and only the first is the
    // property this projection depends on (see the file header's mutation note).
    expect(repo.rows.get(projected.messageId)!.input.dedupKey).toBe(await dedupKeyFor(raw));
    // NO CHURN: not one further `change_log` row, so no client is told anything happened.
    expect(repo.changes.length).toBe(changesAfterProjection);
    // And no adoption: the folder state is untouched and no audit was written.
    expect(repo.audits).toEqual([]);
    expect(repo.folder.get(projected.messageId)).toEqual({
      desiredFolder: SENT, observedFolder: SENT, lastSetBy: "us",
    });
  });

  // ── THE EXCHANGE SHAPE ──────────────────────────────────────────────────────────────────────
  it("a provider's own re-rendered Sent copy converges on the projected row, at its own UID", async () => {
    // Exchange Online files its own version of every SMTP submission into Sent Items beside the
    // byte-exact copy the send path appended: new `Received:` chain, re-encoded MIME, its own UID.
    // Different bytes ⇒ a different fingerprint ⇒ both key lookups MISS, and `resolveExisting`'s
    // own-sent-twin arm (Message-ID, gated on `ownAuthored`) is what stops it becoming a second row.
    const repo = new FakeRepo();
    const raw = appendedBytes({ messageId: "sent-4@lichtgrat.example", body: LONG_BODY });
    const twin = rerenderedBytes({ messageId: "sent-4@lichtgrat.example", body: LONG_BODY });
    // The premise: the twin really does have a different identity, so the own-sent-twin arm is what
    // this test exercises and not the fingerprint hit.
    expect(await dedupKeyFor(twin)).not.toBe(await dedupKeyFor(raw));

    const projected = await recordSentMessage(
      { locator: { folder: SENT, ref: "42:10" }, raw }, depsFor(repo),
    );
    const changesAfterProjection = repo.changes.length;

    const observed = await workerIngest(repo, workerSawInSent(twin, "42:11"));

    expect(observed.outcome).toBe("duplicate");
    expect(observed.messageId).toBe(projected.messageId);
    expect(repo.rows.size).toBe(1);
    expect(repo.changes.length).toBe(changesAfterProjection);
    // The row converges on the copy the server kept — the repoint Sent has always had, which is
    // what repairs the REPLACE shape even when Exchange expunges the appended copy below the
    // watermark, where no delete is ever reported (review round 2). And the superseded locator
    // is RECORDED as a non-primary instance, so neither UID is ever re-fetched — the recording
    // is what stops the repoint ping-pong a truncating first scan turns into a permanent loop
    // (`pipeline.duplicate-copy.test.ts`, the Sent case). Nothing was adopted and nothing moved.
    expect(repo.rows.get(projected.messageId)!.stored.nativeLocator)
      .toEqual({ folder: SENT, ref: "42:11" });
    expect([...repo.instances.values()].filter((i) => i.folder === SENT).map((i) => i.ref).sort())
      .toEqual(["42:10", "42:11"]);
    expect(repo.audits).toEqual([]);
  });

  // ── A COPY IN ANOTHER FOLDER ────────────────────────────────────────────────────────────────
  it("selfCcTwin: a self-CC'd copy in INBOX takes the row — one row, both copies known, one move", async () => {
    const repo = new FakeRepo();
    const raw = appendedBytes({ messageId: "sent-5@lichtgrat.example", to: `anna@example.com, ${OWNER}` });
    const projected = await recordSentMessage(
      { locator: { folder: SENT, ref: "42:12" }, raw }, depsFor(repo),
    );
    const changesAfterProjection = repo.changes.length;

    // The same message, delivered back to the sender's own INBOX.
    const observed = await workerIngest(
      repo, { type: "create", locator: { folder: "INBOX", ref: "9:3" }, raw, seen: false, ownAuthored: false },
    );

    // INBOX holds received mail (`dedup.ts`'s `received_copy`): the copy takes the row and its
    // unread state, the Sent copy stays a recorded instance — still ONE row, no body re-fetched,
    // nothing adopted. It pinned `external_copy` here once: the collapse that hid such a letter.
    expect(observed.outcome).toBe("received_copy");
    expect(repo.rows.size).toBe(1);
    const row = repo.rows.get(projected.messageId)!;
    expect(row.stored.nativeLocator).toEqual({ folder: "INBOX", ref: "9:3" });
    expect(row.input.unread).toBe(true);
    expect([...repo.instances.values()].map((i) => `${i.folder}:${i.ref}${i.isPrimary ? "*" : ""}`).sort())
      .toEqual(["INBOX:9:3*", `${SENT}:42:12`]);
    expect(repo.folder.get(projected.messageId)).toEqual({
      desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
    });
    expect(repo.changes.slice(changesAfterProjection).map((c) => [c.op, c.meta]))
      .toEqual([["move", { from: SENT, to: "INBOX" }]]);
    expect(repo.audits).toEqual([]);
  });

  // ── A SERVER THAT ANSWERS NO APPENDUID ──────────────────────────────────────────────────────
  it("a `0:0` ref still records the message, and the worker's pass repairs the locator", async () => {
    // No UIDPLUS ⇒ `imap.ts#send` cannot name the UID and reports `0:0`. Recording anyway is the
    // right trade: the user gets their message now, and because the fingerprint is the identity the
    // real UID arrives as a `duplicate` that repoints the row rather than as a second one.
    const repo = new FakeRepo();
    const raw = appendedBytes({ messageId: "sent-6@lichtgrat.example" });
    const projected = await recordSentMessage(
      { locator: { folder: SENT, ref: "0:0" }, raw }, depsFor(repo),
    );
    expect(repo.rows.size).toBe(1);

    const observed = await workerIngest(repo, workerSawInSent(raw, "42:13"));

    expect(observed.outcome).toBe("duplicate");
    expect(repo.rows.size).toBe(1);
    expect(repo.rows.get(projected.messageId)!.stored.nativeLocator)
      .toEqual({ folder: SENT, ref: "42:13" });
  });

  // ── THREADING ───────────────────────────────────────────────────────────────────────────────
  it("the projected reply joins the conversation it answers, at send time", async () => {
    // The product reason the row has to exist NOW rather than in a minute: a reply that is not on
    // its thread is a reply the reader cannot see in the conversation they are reading.
    const repo = new FakeRepo();
    const theirs = Buffer.from([
      "From: anna@example.com",
      `To: ${OWNER}`,
      "Subject: the north elevation",
      "Message-ID: <theirs-1@example.com>",
      "Date: Thu, 13 Aug 2026 07:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Thursday?",
      "",
    ].join("\r\n"));
    const inbound = await workerIngest(
      repo, { type: "create", locator: { folder: "INBOX", ref: "9:1" }, raw: theirs, seen: false },
    );
    const theirThread = repo.rows.get(inbound.messageId)!.stored.threadId;
    expect(theirThread).not.toBeNull();

    const out = await recordSentMessage({
      locator: { folder: SENT, ref: "42:14" },
      raw: appendedBytes({ messageId: "sent-7@lichtgrat.example", inReplyTo: "theirs-1@example.com" }),
    }, depsFor(repo));

    expect(repo.rows.get(out.messageId)!.stored.threadId).toBe(theirThread);
  });
});
