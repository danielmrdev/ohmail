import { describe, it, expect } from "vitest";
import { planChange, commitChange , UNMETERED_STORAGE_CAP} from "../src/pipeline.js";
import {
  parseMessageIds, threadKeyOf, baseSubject, resolveThread, MAX_MESSAGE_ID_BYTES, MAX_THREAD_CANDIDATES,
} from "../src/threading.js";
import { opensWithForwardPrefix } from "../src/reply-subject.js";
import { FakeRepo, FakeAdapter } from "./fakes.js";
import type { Change, PipelineDeps } from "../src/ports.js";

/**
 * THREADING AT INGEST — slice.
 *
 * Driven through the REAL two-phase pipeline (`planChange` → `commitChange`) with real message
 * bytes rather than against `resolveThread` directly, because the thing that was broken was not
 * a function: it was that nothing on the ingest path ever created a thread. A test that called
 * the resolver in isolation would have passed on the day production had a backlog of unthreaded rows.
 *
 * Each `MUTATION` block below names the one-line change that makes the guard above it fail, and
 * quotes what was actually observed when that change was applied, run, and reverted. A guard
 * nobody has watched fail is not evidence, and the quotes are the evidence.
 */

function eml(o: {
  id: string; from?: string; subject?: string; inReplyTo?: string; references?: string[]; date?: string;
}): Buffer {
  const lines = [
    `Message-ID: <${o.id}>`,
    `From: ${o.from ?? "anna@example.com"}`,
    "To: mila@lichtgrat.example",
    `Subject: ${o.subject ?? "Roof detail"}`,
    `Date: ${o.date ?? "Mon, 06 Jul 2026 09:00:00 +0000"}`,
    "Content-Type: text/plain; charset=utf-8",
  ];
  if (o.inReplyTo) lines.push(`In-Reply-To: <${o.inReplyTo}>`);
  if (o.references?.length) lines.push(`References: ${o.references.map((r) => `<${r}>`).join(" ")}`);
  // A body unique per message: `dedupKey` falls back to the body hash when a Message-ID is
  // absent, and two messages that differ only in headers must still be two messages.
  lines.push("", `body of ${o.id}`);
  return Buffer.from(lines.join("\r\n"));
}

let uid = 0;
function makeDeps(accountId = "acct-1", mailboxId = "mb-1"): PipelineDeps & { repo: FakeRepo } {
  return { repo: new FakeRepo(), adapter: new FakeAdapter(), accountId, mailboxId };
}

async function ingest(
  deps: PipelineDeps & { repo: FakeRepo }, raw: Buffer, ref?: string,
): Promise<string> {
  const change: Change = { type: "create", locator: { folder: "INBOX", ref: ref ?? `1:${++uid}` }, raw };
  const ctx = { repo: deps.repo, accountId: deps.accountId, mailboxId: deps.mailboxId };
  const plan = await planChange(change, ctx);
  const res = await commitChange(plan, { ...ctx, storageCap: UNMETERED_STORAGE_CAP });
  return res.messageId;
}

/** The thread every named message ended up in, by `messages.thread_id`. */
const threadOf = (repo: FakeRepo, messageId: string): string | null =>
  repo.rows.get(messageId)!.stored.threadId;

// ─────────────────────────────────────────────────────────────────────────────────────────
// GUARD 1 — a 4-deep chain, ingested BACKWARDS, is one conversation
// ─────────────────────────────────────────────────────────────────────────────────────────

describe("a 4-deep References chain ingested out of order lands in ONE thread", () => {
  /**
   * IMAP hands mail over in UID order, which is arrival order at the server and not
   * conversation order, so a reply is routinely ingested before the mail it answers. What
   * carries this is the ANCHOR — `threads.root_message_id_header`, the LEFTMOST reference —
   * because every message of a chain derives the same one whichever arrives first.
   */
  it("D, C, B, A — the exact reverse of the conversation — is one thread of four", async () => {
    const d = makeDeps();
    const ids = {
      d: await ingest(d, eml({ id: "d@x", inReplyTo: "c@x", references: ["a@x", "b@x", "c@x"] })),
      c: await ingest(d, eml({ id: "c@x", inReplyTo: "b@x", references: ["a@x", "b@x"] })),
      b: await ingest(d, eml({ id: "b@x", inReplyTo: "a@x", references: ["a@x"] })),
      a: await ingest(d, eml({ id: "a@x" })),
    };
    const threads = new Set(Object.values(ids).map((id) => threadOf(d.repo, id)));
    expect(threads.size, "four messages of one conversation, four different threads").toBe(1);
    expect([...threads][0]).not.toBeNull();
    expect(d.repo.threads.size).toBe(1);
    // …and the row is anchored on the ROOT, not on whichever message happened to arrive first.
    expect([...d.repo.threads.values()][0]!.rootMessageIdHeader).toBe("a@x");
  });

  it("and forwards, A, B, C, D, gives the identical shape", async () => {
    const d = makeDeps();
    const ids = [
      await ingest(d, eml({ id: "a@x" })),
      await ingest(d, eml({ id: "b@x", inReplyTo: "a@x", references: ["a@x"] })),
      await ingest(d, eml({ id: "c@x", inReplyTo: "b@x", references: ["a@x", "b@x"] })),
      await ingest(d, eml({ id: "d@x", inReplyTo: "c@x", references: ["a@x", "b@x", "c@x"] })),
    ];
    expect(new Set(ids.map((id) => threadOf(d.repo, id))).size).toBe(1);
    expect(d.repo.threads.size).toBe(1);
  });

  /**
   * MUTATION — anchor on the RIGHTMOST reference instead of the leftmost, i.e. in
   * `threadKeyOf`, `references[references.length - 1] ?? …` in place of `references[0] ?? …`.
   * That is precisely the alternative the design comment argues against, and it is the line
   * that carries out-of-order convergence.
   *
   * OBSERVED: `AssertionError: four messages of one conversation, four different threads:
   * expected 3 to be 1`. Backwards, D anchors on `c@x`, C on `b@x`, B and A on `a@x` — three
   * `threads` rows for one conversation. Restored.
   *
   * The brief predicted this guard would go red on dropping the right-to-left References WALK.
   * It does not: with the anchor in place, D/C/B/A all derive `a@x` and converge without any
   * candidate ever matching. The walk is load-bearing for a different case, which is GUARD 2.
   */
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// GUARD 2 — the References WALK, and that it goes right to left
// ─────────────────────────────────────────────────────────────────────────────────────────

describe("References is walked, nearest ancestor first", () => {
  /**
   * The shape that needs the walk is the shape production actually has. Our own replies are
   * sent from the mail client and land in `Sent`, which is NOT in `WATCHED_FOLDERS`, so the
   * counterpart's next message names an `In-Reply-To` we have never ingested. Add a client that
   * truncates `References` — Outlook does — and the anchor no longer points at the root either.
   * The only thing left that can find the conversation is the References walk.
   */
  it("finds the thread when In-Reply-To names a message we never ingested", async () => {
    const d = makeDeps();
    const a = await ingest(d, eml({ id: "a@x" }));
    const b = await ingest(d, eml({ id: "b@x", inReplyTo: "a@x", references: ["a@x"] }));
    // `mine@sent` was authored by the user, went to Sent, and was never ingested. The reply's
    // References have been truncated by the sender's client — `a@x` is gone.
    const c = await ingest(d, eml({
      id: "c@x", inReplyTo: "mine@sent", references: ["b@x", "mine@sent"],
    }));

    expect(threadOf(d.repo, c), "the reply started its own conversation").toBe(threadOf(d.repo, a));
    expect(threadOf(d.repo, c)).toBe(threadOf(d.repo, b));
    expect(d.repo.threads.size).toBe(1);
  });

  /**
   * MUTATION — drop `References` from the candidate list in `threadKeyOf`
   * (`const ordered = [...inReplyTo];`).
   *
   * OBSERVED: `AssertionError: the reply started its own conversation: expected 'thr-2' to be
   * 'thr-1'`. With no walk, `mine@sent` is the only candidate, it misses, and the truncated
   * anchor `b@x` mints a second thread. Four other tests in this file went red with it —
   * `threadKeyOf`'s own candidate assertions and the over-long-token guard, which reads the
   * References list. Restored.
   */
  it("picks the NEAREST ingested ancestor when two references are in different threads", async () => {
    // Two conversations that a later message stitches together by naming both. Right-to-left
    // means the nearest ancestor wins, which is the one the message is actually a reply to.
    const d = makeDeps();
    const older = await ingest(d, eml({ id: "old@x", subject: "Budget" }));
    const nearer = await ingest(d, eml({ id: "near@x", subject: "Roof detail" }));
    expect(threadOf(d.repo, older)).not.toBe(threadOf(d.repo, nearer));

    const reply = await ingest(d, eml({
      id: "reply@x", subject: "Re: Roof detail", references: ["old@x", "near@x"],
    }));
    expect(threadOf(d.repo, reply)).toBe(threadOf(d.repo, nearer));
    expect(threadOf(d.repo, reply)).not.toBe(threadOf(d.repo, older));
  });

  /**
   * MUTATION — walk References LEFT to right (`...references` instead of
   * `...[...references].reverse()`).
   *
   * OBSERVED: `AssertionError: expected 'thr-1' to be 'thr-2'` — the reply joined `old@x`'s
   * conversation, the one it is furthest from. Restored.
   */
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// GUARD 3 — account isolation (the "Account isolation is absolute, and it binds staff too" invariant)
// ─────────────────────────────────────────────────────────────────────────────────────────

describe("account scoping", () => {
  /**
   * A Message-ID is chosen by whoever sends the mail. If the parent lookup were not scoped, a
   * stranger could send you mail carrying `In-Reply-To: <another-account's-header>` and have it
   * adopt that account's conversation — which `materializeThread` renders as one thread. This
   * is the "Account isolation is absolute, and it binds staff too" invariant reached through the threading key.
   */
  it("an identical Message-ID in another account never joins this account's thread", async () => {
    // ONE FakeRepo, TWO accounts — the same shape as one database holding both.
    const repo = new FakeRepo();
    const mine: PipelineDeps & { repo: FakeRepo } =
      { repo, adapter: new FakeAdapter(), accountId: "acct-mine", mailboxId: "mb-mine" };
    const theirs: PipelineDeps & { repo: FakeRepo } =
      { repo, adapter: new FakeAdapter(), accountId: "acct-theirs", mailboxId: "mb-theirs" };

    const root = await ingest(mine, eml({ id: "secret-root@x", subject: "Contract" }));
    const intruder = await ingest(theirs, eml({
      id: "intruder@x", subject: "Re: Contract", inReplyTo: "secret-root@x",
      references: ["secret-root@x"],
    }));

    expect(threadOf(repo, intruder), "another account's message joined this thread")
      .not.toBe(threadOf(repo, root));
    // Two conversations, and the intruder's is anchored on the header it NAMED — which is
    // harmless, because the anchor is unique PER ACCOUNT.
    expect(repo.threads.size).toBe(2);
    const [t1, t2] = [...repo.threads.values()];
    expect(new Set([t1!.accountId, t2!.accountId])).toEqual(new Set(["acct-mine", "acct-theirs"]));
  });

  /**
   * MUTATION — remove the account predicate from `FakeRepo.findThreadParent`
   * (`if (row.input.accountId !== accountId) continue;`), the in-memory mirror of
   * `eq(messages.accountId, accountId)` in `DrizzleRepo.findThreadParent`.
   *
   * OBSERVED: `AssertionError: another account's message joined this thread: expected 'thr-1'
   * not to be 'thr-1'`. One account's mail was inside another account's conversation.
   * Restored. The SQL half of the same claim is `thread-resolution.pg.test.ts`.
   */
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// GUARD 4 — there is no subject fallback, and there must never be one
// ─────────────────────────────────────────────────────────────────────────────────────────

describe("no subject fallback", () => {
  /**
   * THIS GUARD EXISTS TO FAIL A FUTURE IMPROVEMENT, not to describe a bug.
   *
   * Subject matching looks like free recall and is a false-merge machine: "Re: invoice" from
   * two unrelated senders is one of the commonest subjects in any mailbox, and merging them
   * puts one correspondent's mail inside another conversation — visible, wrong, and not
   * undoable by the user, because there is no thread SPLIT. An unmerged singleton is merely a
   * conversation that reads as two. The ruling is deterministic-only; if somebody adds a
   * subject arm "just for orphans", this is what stops it.
   */
  it("two messages with the same subject and no header relation stay in DIFFERENT threads", async () => {
    const d = makeDeps();
    const one = await ingest(d, eml({ id: "one@x", subject: "Re: Invoice", from: "billing@acme.test" }));
    const two = await ingest(d, eml({ id: "two@x", subject: "Re: Invoice", from: "accounts@other.test" }));
    expect(threadOf(d.repo, one)).not.toBe(threadOf(d.repo, two));
    expect(d.repo.threads.size).toBe(2);
  });

  it("…even when the subjects are byte-identical AND the senders are the same person", async () => {
    const d = makeDeps();
    const one = await ingest(d, eml({ id: "p1@x", subject: "Weekly report", from: "anna@example.com" }));
    const two = await ingest(d, eml({ id: "p2@x", subject: "Weekly report", from: "anna@example.com" }));
    expect(threadOf(d.repo, one)).not.toBe(threadOf(d.repo, two));
  });

  /**
   * MUTATION — the forbidden improvement itself, added to `threadKeyOf`: anchor a message with
   * no header relation on its normalized subject instead of on its own Message-ID
   * (`?? (subject ? \`subj:${baseSubject(subject).toLowerCase()}\` : own)`).
   *
   * OBSERVED: both guards above failed with `AssertionError: expected 'thr-1' not to be
   * 'thr-1'` — two unrelated senders' "Re: Invoice" merged into one conversation, which is
   * exactly the damage the ruling forbids. Three further tests went red with it, including
   * the 4-deep chain (subject-anchoring collapsed "Roof detail" and "Re: Roof detail" from
   * different chains) and the anchorless-message guard (`expected 'subj:no id here' to be
   * null`). Restored.
   */
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// GUARD 5 — idempotency
// ─────────────────────────────────────────────────────────────────────────────────────────

describe("idempotency", () => {
  it("re-ingesting the same message creates no second thread and no duplicate change rows", async () => {
    const d = makeDeps();
    const raw = eml({ id: "solo@x" });
    // The SAME locator, because that is what a re-drain of an unmoved message looks like.
    const first = await ingest(d, raw, "1:900");
    const changesAfterFirst = d.repo.changes.length;
    const threadAfterFirst = threadOf(d.repo, first);

    const second = await ingest(d, raw, "1:900");

    expect(second).toBe(first);
    expect(d.repo.threads.size).toBe(1);
    expect(threadOf(d.repo, second)).toBe(threadAfterFirst);
    // The duplicate branch of `commitChange` records nothing client-visible — and in particular
    // no second `thread` create, which is what would make a mirror show the conversation twice.
    expect(d.repo.changes.length).toBe(changesAfterFirst);
    expect(d.repo.changes.filter((c) => c.entityType === "thread")).toHaveLength(1);
  });

  it("a message with NO Message-ID at all is a singleton, and re-ingest does not double it", async () => {
    // Anchorless: `root_message_id_header` is NULL, which Postgres treats as DISTINCT, so the
    // unique index cannot dedup it. The re-entry guard is `StoredMessage.threadId` instead.
    const d = makeDeps();
    const raw = Buffer.from([
      "From: anna@example.com", "To: mila@lichtgrat.example", "Subject: No id here",
      "Content-Type: text/plain; charset=utf-8", "", "body",
    ].join("\r\n"));
    const first = await ingest(d, raw, "1:901");
    await ingest(d, raw, "1:901");
    expect(d.repo.threads.size).toBe(1);
    expect([...d.repo.threads.values()][0]!.rootMessageIdHeader).toBeNull();
    expect(threadOf(d.repo, first)).not.toBeNull();
  });

  /**
   * THE LOCK-ORDER GUARD, expressed as the one thing a test can actually see.
   *
   * `allocateSeq` takes the account's `account_sync_state` row lock and holds it to COMMIT,
   * so a transaction that records a change excludes every other change-recording transaction for
   * that account for the rest of its life. If `resolveThread` recorded as it went, a whole
   * backfill batch would hold the seq lock from its first row and then lock a NEW `threads` row
   * on its second — while a concurrent ingest holds that row and waits for the seq lock. Real
   * cycle, 40P01, one side aborted.
   *
   * The fix is that the resolver RETURNS its delta rows and the caller appends them last. This
   * asserts the resolver stayed silent, so a future "simplification" that moves `recordChange`
   * back inside it fails here rather than in production during a leader handover.
   */
  it("resolveThread records NO change itself — the caller appends them after the thread locks", async () => {
    const repo = new FakeRepo();
    await repo.insertMessage({ senderCheck: null,
      accountId: "acct-1", mailboxId: "mb-1",
      canonical: { messageIdHeader: "root@x", bodyHash: "h" },
      dedupKey: "mid:root@x", subject: "Roof detail", fromAddress: "anna@example.com", date: null,
      nativeLocator: { folder: "INBOX", ref: "1:1" },
      flags: { no_ai: false, no_forward: false, no_kb: false, priority: false },
    });
    const stored = await repo.insertMessage({ senderCheck: null,
      accountId: "acct-1", mailboxId: "mb-1",
      canonical: { messageIdHeader: "reply@x", bodyHash: "h2" },
      dedupKey: "mid:reply@x", subject: "Re: Roof detail", fromAddress: "bob@example.com", date: null,
      nativeLocator: { folder: "INBOX", ref: "1:2" },
      flags: { no_ai: false, no_forward: false, no_kb: false, priority: false },
    });

    const r = await resolveThread(repo, {
      accountId: "acct-1", messageId: stored.id, messageIdHeader: "reply@x",
      headers: { references: ["<root@x>"] }, subject: "Re: Roof detail",
      participants: [{ name: null, address: "bob@example.com" }], date: null,
      emitMessageUpdate: true,
    });

    expect(repo.changes, "resolveThread wrote to the delta log itself").toHaveLength(0);
    // …and it still OWES the rows, so nothing was silently dropped either.
    expect(r.changes.map((c) => `${c.entityType}:${c.op}`))
      .toEqual(["thread:create", "message:update"]);
  });

  it("the thread create is recorded BEFORE the message create", async () => {
    // Delta order is a contract (the "Delta-first client contract" invariant): a client applying in seq order must never see a
    // message referencing a thread it has not been told about.
    const d = makeDeps();
    await ingest(d, eml({ id: "ordered@x" }));
    const kinds = d.repo.changes.map((c) => `${c.entityType}:${c.op}`);
    expect(kinds.indexOf("thread:create")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("thread:create")).toBeLessThan(kinds.indexOf("message:create"));
  });

  it("a reply that joins a thread records a thread UPDATE, not a second create", async () => {
    const d = makeDeps();
    await ingest(d, eml({ id: "r1@x", date: "Mon, 06 Jul 2026 09:00:00 +0000" }));
    d.repo.changes.length = 0;
    await ingest(d, eml({
      id: "r2@x", inReplyTo: "r1@x", references: ["r1@x"], from: "bob@example.com",
      date: "Tue, 07 Jul 2026 09:00:00 +0000",
    }));
    const threadChanges = d.repo.changes.filter((c) => c.entityType === "thread");
    expect(threadChanges).toHaveLength(1);
    expect(threadChanges[0]!.op).toBe("update");
    // …because the thread genuinely moved: a newer message and a second participant.
    const t = [...d.repo.threads.values()][0]!;
    expect(t.participants.map((p) => p.address)).toContain("bob@example.com");
    expect(t.lastMessageAt?.toISOString()).toBe("2026-07-07T09:00:00.000Z");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// GUARD 6 — the header parser, including the wedge guard
// ─────────────────────────────────────────────────────────────────────────────────────────

describe("header parsing", () => {
  it("extracts a folded, multi-value References list in order, CASE PRESERVED", () => {
    // Case is significant: `normalizeMessageId` stopped folding it in that change slice 2, because RFC 5322
    // §3.6.4 makes `id-left` a case-sensitive `dot-atom-text`. It matters HERE too — these tokens
    // are matched against `messages.message_id_header`, which is now stored case-preserved, so a
    // parser that folded them would stop finding the parent it is looking for.
    expect(parseMessageIds(["<A@x> <b@x>", "  <C@x>"])).toEqual(["A@x", "b@x", "C@x"]);
  });

  it("accepts a bare, bracket-free id — some senders emit one", () => {
    expect(parseMessageIds(["bare@x"])).toEqual(["bare@x"]);
  });

  it("dedups while preserving order, and drops empties", () => {
    expect(parseMessageIds(["<a@x> <a@x> <b@x>", "<>"])).toEqual(["a@x", "b@x"]);
  });

  /**
   * THE WEDGE GUARD. `threads_account_root_header_uq` and
   * `messages_account_message_id_header_idx` are btree indexes, and a btree index tuple cannot
   * exceed a few kilobytes — Postgres raises `54000` on the INSERT. `References` tokens are chosen
   * by whoever sent the mail, so one hostile message with a 3 KB reference would abort the
   * persist transaction, leave the sync cursor unadvanced (the pipeline's crash-safe design),
   * and make the worker re-plan that same message for ever. The mailbox stops syncing.
   *
   * Found by the architecture review, not by me: my own parser had no cap.
   */
  it("drops a token longer than the RFC 5322 line limit instead of wedging the index", () => {
    const huge = "x".repeat(MAX_MESSAGE_ID_BYTES + 1) + "@x";
    expect(parseMessageIds([`<${huge}> <ok@x>`])).toEqual(["ok@x"]);

    const key = threadKeyOf("mine@x", { references: [`<${huge}> <real-root@x>`] });
    expect(key.candidates).toEqual(["real-root@x"]);
    expect(key.rootMessageIdHeader, "an over-long token became the anchor").toBe("real-root@x");
  });

  it("falls through to the next anchor when EVERY reference is over-long", () => {
    const huge = `<${"x".repeat(MAX_MESSAGE_ID_BYTES + 1)}@x>`;
    const key = threadKeyOf("mine@x", { references: [huge], "in-reply-to": [huge] });
    expect(key.candidates).toEqual([]);
    expect(key.rootMessageIdHeader).toBe("mine@x");
  });

  it("a message's own id is never its own parent candidate", () => {
    const key = threadKeyOf("self@x", { references: ["<self@x> <other@x>"] });
    expect(key.candidates).toEqual(["other@x"]);
  });

  it("the anchor is the leftmost reference, then In-Reply-To, then the message's own id", () => {
    expect(threadKeyOf("d@x", { references: ["<a@x> <b@x> <c@x>"], "in-reply-to": ["<c@x>"] })
      .rootMessageIdHeader).toBe("a@x");
    expect(threadKeyOf("d@x", { "in-reply-to": ["<c@x>"] }).rootMessageIdHeader).toBe("c@x");
    expect(threadKeyOf("d@x", {}).rootMessageIdHeader).toBe("d@x");
    expect(threadKeyOf(null, {}).rootMessageIdHeader).toBeNull();
  });

  it("candidates are In-Reply-To first, then References right-to-left", () => {
    expect(threadKeyOf("d@x", { references: ["<a@x> <b@x>"], "in-reply-to": ["<z@x>"] }).candidates)
      .toEqual(["z@x", "b@x", "a@x"]);
  });
});

/**
 * A SENDER'S ID LIST IS BOUNDED. Each candidate is one bind parameter in the thread lookup and the
 * correspondent check, and In-Reply-To and References are whatever the sender wrote: tens of thousands of ids made
 * one statement the driver refused on another caller's query. Past {@link MAX_THREAD_CANDIDATES} the
 * nearest ids are kept, In-Reply-To first, and the root takes the last place.
 */
describe("a sender's id list is bounded", () => {
  const ids = (n: number, p = "r"): string[] => Array.from({ length: n }, (_, i) => `${p}${i}@x`);
  const refs = (list: readonly string[]): string[] => [list.map((id) => `<${id}>`).join(" ")];

  it("at one past the bound keeps In-Reply-To, the newest References and the root", () => {
    const r = ids(MAX_THREAD_CANDIDATES + 1);
    const key = threadKeyOf("d@x", { references: refs(r), "in-reply-to": ["<z@x>"] });
    expect(key.candidates).toHaveLength(MAX_THREAD_CANDIDATES);
    expect(key.candidates[0]).toBe("z@x");
    expect(key.candidates.slice(1, -1)).toEqual([...r].reverse().slice(0, MAX_THREAD_CANDIDATES - 2));
    expect(key.candidates.at(-1), "the root keeps its place").toBe(r[0]);
    expect(key.rootMessageIdHeader).toBe(r[0]);
  });

  it("at the bound changes nothing", () => {
    const r = ids(MAX_THREAD_CANDIDATES - 1);
    expect(threadKeyOf("d@x", { references: refs(r), "in-reply-to": ["<z@x>"] }).candidates)
      .toEqual(["z@x", ...[...r].reverse()]);
  });

  it("names the bound for 70,000 ids, never the message's own id or a repeat", () => {
    const r = ids(70_000);
    const key = threadKeyOf("r69999@x", { references: refs(r), "in-reply-to": ["<r69998@x>"] });
    expect(key.candidates).toHaveLength(MAX_THREAD_CANDIDATES);
    expect(new Set(key.candidates).size).toBe(MAX_THREAD_CANDIDATES);
    expect([key.candidates[0], key.candidates[1], key.candidates.at(-1)]).toEqual(["r69998@x", "r69997@x", "r0@x"]);
    expect(key.candidates).not.toContain("r69999@x");
  });

  it("threads a reply past the bound into its nearest ingested ancestor's conversation", async () => {
    // `near@x` is the newest reference and `old@x` the root, with 150 never-ingested ids between.
    const d = makeDeps();
    const older = await ingest(d, eml({ id: "old@x", subject: "Budget" }));
    const nearer = await ingest(d, eml({ id: "near@x", subject: "Roof detail" }));
    const reply = await ingest(d, eml({
      id: "reply@x", subject: "Re: Roof detail", references: ["old@x", ...ids(150, "gone"), "near@x"],
    }));
    expect(threadOf(d.repo, reply)).toBe(threadOf(d.repo, nearer));
    expect(threadOf(d.repo, reply)).not.toBe(threadOf(d.repo, older));
  });
});

describe("baseSubject", () => {
  it("strips a stack of reply and forward prefixes, in any language we have seen", () => {
    expect(baseSubject("Re: Fwd: Re: Roof detail")).toBe("Roof detail");
    expect(baseSubject("AW: Dachdetail")).toBe("Dachdetail");
    expect(baseSubject("RE[2]: Roof detail")).toBe("Roof detail");
  });

  /**
   * The localized FORWARD prefixes, and the reply prefixes of the other Outlook localizations.
   *
   * The gap this pins was found in production data: a thread created from a German Outlook
   * forward was named "WG: …" because the list stripped AW (the reply) but not WG (the
   * forward). The list is the documented set the localized clients actually emit — one
   * principled table, not a per-incident patch.
   */
  it("strips the localized forward prefixes — WG: (de) is the one production showed", () => {
    expect(baseSubject("WG: Webshop")).toBe("Webshop");
    expect(baseSubject("WG: WG: Angebot")).toBe("Angebot");
    expect(baseSubject("AW: WG: Angebot")).toBe("Angebot");
  });

  it("strips the other localized reply/forward prefixes of the documented set", () => {
    expect(baseSubject("Antw.: onderwerp")).toBe("onderwerp");       // nl reply, with the dot
    expect(baseSubject("Doorst: onderwerp")).toBe("onderwerp");      // nl forward
    expect(baseSubject("RV: asunto")).toBe("asunto");                // es forward
    expect(baseSubject("RES: assunto")).toBe("assunto");             // pt reply
    expect(baseSubject("ENC: assunto")).toBe("assunto");             // pt forward
    expect(baseSubject("Odp: temat")).toBe("temat");                 // pl reply
    expect(baseSubject("PD: temat")).toBe("temat");                  // pl forward
    expect(baseSubject("SV: emne")).toBe("emne");                    // sv/da/no/is reply
    expect(baseSubject("VB: ämne")).toBe("ämne");                    // sv forward
    expect(baseSubject("VS: aihe")).toBe("aihe");                    // fi reply / no+da forward
    expect(baseSubject("VL: aihe")).toBe("aihe");                    // fi forward
    expect(baseSubject("FS: efni")).toBe("efni");                    // is forward
    expect(baseSubject("YNT: konu")).toBe("konu");                   // tr reply
    expect(baseSubject("R: oggetto")).toBe("oggetto");               // it reply
    expect(baseSubject("I: oggetto")).toBe("oggetto");               // it forward
    expect(baseSubject("ATB: pwnc")).toBe("pwnc");                   // cy reply
    expect(baseSubject("YML: pwnc")).toBe("pwnc");                   // cy forward
    expect(baseSubject("BLS: subjek")).toBe("subjek");               // id reply
    expect(baseSubject("Vá: tárgy")).toBe("tárgy");                  // hu reply
    expect(baseSubject("回复: 主题")).toBe("主题");                   // zh-Hans reply
    expect(baseSubject("回覆：主題")).toBe("主題");                   // zh-Hant reply, fullwidth colon
    expect(baseSubject("转发: 主题")).toBe("主题");                   // zh-Hans forward
    expect(baseSubject("轉寄：主題")).toBe("主題");                   // zh-Hant forward, fullwidth colon
  });

  it("strips a mixed multilingual stack the way one real chain carried it", () => {
    expect(baseSubject("AW: AW: AW: Webshop")).toBe("Webshop");
    expect(baseSubject("Re: AW: AW: Webshop")).toBe("Webshop");
    expect(baseSubject("Re: WG: Webshop")).toBe("Webshop");
  });

  it("leaves a subject that merely starts with those letters alone", () => {
    expect(baseSubject("Rethinking the roof")).toBe("Rethinking the roof");
    expect(baseSubject("Fwderal paperwork")).toBe("Fwderal paperwork");
    // The one- and two-letter tokens are the false-positive risk the colon anchor carries,
    // so each is pinned against an innocent subject that begins with the same letters.
    expect(baseSubject("Reserve: two seats")).toBe("Reserve: two seats");
    expect(baseSubject("Item: the missing invoice")).toBe("Item: the missing invoice");
    expect(baseSubject("R" + "2: robot naming")).toBe("R" + "2: robot naming");
    expect(baseSubject("Ipad: handover notes")).toBe("Ipad: handover notes");
    expect(baseSubject("Encoding: UTF-8 everywhere")).toBe("Encoding: UTF-8 everywhere");
    expect(baseSubject("Password: rotate on Friday")).toBe("Password: rotate on Friday");
  });

  it("a thread created by a reply is named after the conversation, not the reply", async () => {
    const d = makeDeps();
    await ingest(d, eml({ id: "late@x", subject: "Re: Roof detail", references: ["root@x"] }));
    expect([...d.repo.threads.values()][0]!.subject).toBe("Roof detail");
  });

  it("and the root arriving later does NOT rename it — rename is a user write", async () => {
    const d = makeDeps();
    await ingest(d, eml({ id: "late@x", subject: "Re: Roof detail", references: ["root@x"] }));
    [...d.repo.threads.values()][0]!.subject = "What the user called it";
    await ingest(d, eml({ id: "root@x", subject: "Roof detail" }));
    expect(d.repo.threads.size).toBe(1);
    expect([...d.repo.threads.values()][0]!.subject).toBe("What the user called it");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// GUARD 7 — an Exchange forward chain: localized prefixes, two mailboxes, one conversation
// ─────────────────────────────────────────────────────────────────────────────────────────

describe("an Exchange/Outlook forward chain lands in ONE thread named without prefixes", () => {
  /**
   * The shape is modelled on a real fragmented-looking conversation: a German Outlook forward
   * ("WG:") starts the account's copy of the chain, Outlook replies stack "AW:" and a Gmail
   * correspondent stacks "Re:" on top of those, the ROOT the References name was never
   * ingested (it predates the forward), and the last reply arrives in a DIFFERENT mailbox of
   * the same account. Exchange Message-IDs carry long host-shaped ids; nothing about them is
   * special, but the fixture keeps the shape honest.
   *
   * Two claims, each with its own mutation:
   *  - identity: every message converges on ONE thread, anchored on the never-ingested root
   *    (headers only — the subjects contribute nothing to identity);
   *  - naming: the thread a FORWARD creates is named after the conversation, which is what
   *    `baseSubject`'s localized prefix table exists for.
   */
  const host = "AM7PR03MB0001.eurprd03.prod.example.com";
  const root = `root-before-forward@${host}`;
  const chain = {
    f1: { id: `fwd-1@${host}`, subject: "WG: Webshop", parent: root, refs: [root] },
    a1: { id: `reply-1@${host}`, subject: "AW: Webshop", parent: `fwd-1@${host}`, refs: [root, `fwd-1@${host}`] },
    g1: {
      id: "gmail-1@mail.example.org", subject: "Re: AW: Webshop",
      parent: `reply-1@${host}`, refs: [root, `fwd-1@${host}`, `reply-1@${host}`],
    },
    a2: {
      id: `reply-2@${host}`, subject: "AW: AW: Webshop",
      parent: "gmail-1@mail.example.org", refs: [root, `fwd-1@${host}`, `reply-1@${host}`, "gmail-1@mail.example.org"],
    },
    g2: {
      id: "gmail-2@mail.example.org", subject: "Re: AW: AW: Webshop",
      parent: `reply-2@${host}`,
      refs: [root, `fwd-1@${host}`, `reply-1@${host}`, "gmail-1@mail.example.org", `reply-2@${host}`],
    },
  };
  const emlOf = (m: { id: string; subject: string; parent: string; refs: string[] }): Buffer =>
    eml({ id: m.id, subject: m.subject, inReplyTo: m.parent, references: m.refs });

  it("forward-first, a reply out of order, and a second mailbox: one thread, named 'Webshop'", async () => {
    const d = makeDeps();
    // The account's OTHER mailbox: same repo, same account — mailbox scope must not matter,
    // because the threading key is the ACCOUNT (the designed scope; see threading.ts).
    const d2 = { ...d, mailboxId: "mb-2" };

    const ids = [
      await ingest(d, emlOf(chain.f1)),   // the forward CREATES the thread ⇒ names it
      await ingest(d, emlOf(chain.g1)),   // out of order: its parent a1 is not ingested yet
      await ingest(d, emlOf(chain.a1)),
      await ingest(d, emlOf(chain.a2)),
      await ingest(d2, emlOf(chain.g2)),  // the other mailbox's copy joins, never splits
    ];

    expect(new Set(ids.map((id) => threadOf(d.repo, id))).size, "one conversation, one thread").toBe(1);
    expect(d.repo.threads.size).toBe(1);
    const thread = [...d.repo.threads.values()][0]!;
    // Anchored on the never-ingested pre-forward root — identity comes from headers alone.
    expect(thread.rootMessageIdHeader).toBe(root);
    // Named after the conversation, not after the forward that happened to arrive first.
    expect(thread.subject, "the forward prefix must not name the thread").toBe("Webshop");
  });

  /**
   * MUTATION — drop `"wg"` from `SUBJECT_PREFIX_TOKENS`.
   *
   * OBSERVED: `AssertionError: the forward prefix must not name the thread: expected
   * 'WG: Webshop' to be 'Webshop'`, plus the two baseSubject table tests that carry WG lines
   * (3 failed | 25 passed). Every identity assertion stayed green — subjects play no part in
   * which thread a message joins. Restored.
   *
   * MUTATION — the identity half. Anchoring on the RIGHTMOST reference alone did NOT turn
   * this guard red: g1, arriving before its parent, still found `fwd-1@…` by the References
   * WALK (GUARD 1 and the anchor-order test caught that mutation, 2 failed). Identity here is
   * carried by the walk and the anchor TOGETHER, each pinned by its own guard above; this
   * one goes red when BOTH are gone — walk dropped (`[...inReplyTo]` only) plus rightmost
   * anchor. OBSERVED: `AssertionError: one conversation, one thread: expected 2 to be 1` —
   * g1 missed every candidate and anchored on `reply-1@…` while f1 anchored on the root
   * (7 failed across the file). Restored both lines.
   */
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// A FORWARD IS A MEMBER OF THE CONVERSATION IT WAS FORWARDED FROM — by its headers alone
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The send mints `In-Reply-To`/`References` on a forward exactly as on a reply, off the
 * original. These cases are the INGEST half of that contract: the forward's own Sent copy and a
 * recipient's later answer both land in the original's thread, and a forward-looking subject
 * with no headers still starts a conversation of its own. Mutation watched red: drop the
 * `In-Reply-To` line from `eml` for the Sent copy — the first case splits into two threads.
 */
describe("a forward threads with its original by its headers, never by its subject", () => {
  it("the account's own Sent copy of a forward joins the original's conversation", async () => {
    const d = makeDeps();
    const original = await ingest(d, eml({ id: "orig@x", subject: "Roof detail" }));
    const forward = await ingest(d, eml({
      id: "fwd@me", subject: "Fwd: Roof detail", from: "mila@lichtgrat.example",
      inReplyTo: "orig@x", references: ["orig@x"],
    }));
    expect(threadOf(d.repo, forward)).toBe(threadOf(d.repo, original));
    expect(d.repo.threads.size).toBe(1);
  });

  it("a recipient's reply to the forward joins the same conversation, even before the Sent copy is ingested", async () => {
    const d = makeDeps();
    const original = await ingest(d, eml({ id: "orig@x", subject: "Roof detail" }));
    // The reply names the forward as its parent and carries the chain the forward carried plus
    // the forward itself. The forward's Sent copy is NOT here yet: `References` right-to-left
    // reaches past the unknown forward to the original.
    const answer = await ingest(d, eml({
      id: "answer@colleague", subject: "Re: Fwd: Roof detail", from: "sam@colleague.test",
      inReplyTo: "fwd@me", references: ["orig@x", "fwd@me"],
    }));
    expect(threadOf(d.repo, answer)).toBe(threadOf(d.repo, original));
    expect(d.repo.threads.size).toBe(1);
  });

  it("a forward-looking subject WITHOUT headers is its own conversation — the subject never keys", async () => {
    const d = makeDeps();
    const original = await ingest(d, eml({ id: "orig@x", subject: "Roof detail" }));
    const stranger = await ingest(d, eml({
      id: "other@me", subject: "Fwd: Roof detail", from: "mila@lichtgrat.example",
    }));
    expect(threadOf(d.repo, stranger)).not.toBe(threadOf(d.repo, original));
    expect(d.repo.threads.size).toBe(2);
  });
});

/**
 * The prefix table in both of the product's languages — one fixture per prefix Outlook and
 * Thunderbird emit in English and German, stacks included. The naming half of the conversation
 * key (`baseSubject`) and the face half (`opensWithForwardPrefix`) read ONE table. Mutation
 * watched red: remove `wg` from `SUBJECT_PREFIXES` — the WG: fixtures fail in both blocks.
 */
describe("the prefix table, English and German, stacked", () => {
  const cases: Array<[string, string]> = [
    ["Re: Angebot", "Angebot"], ["RE: Angebot", "Angebot"],
    ["Fwd: Angebot", "Angebot"], ["FW: Angebot", "Angebot"], ["Fw: Angebot", "Angebot"],
    ["WG: Angebot", "Angebot"], ["AW: Angebot", "Angebot"], ["TR: Angebot", "Angebot"],
    ["Fwd: Re: Angebot", "Angebot"], ["WG: AW: Angebot", "Angebot"],
    ["Re: WG: AW: Fwd: Angebot", "Angebot"], ["FW: RE: FW: Angebot", "Angebot"],
  ];
  for (const [subject, base] of cases) {
    it(`baseSubject(${JSON.stringify(subject)}) is ${JSON.stringify(base)}`, () => {
      expect(baseSubject(subject)).toBe(base);
    });
  }

  it("opensWithForwardPrefix reads the LEADING token only, in both languages", () => {
    for (const s of ["Fwd: x", "FW: x", "Fw: x", "WG: x", "Fwd: Re: x", "WG: AW: x", "FW[2]: x", "Fwd : x"]) {
      expect(opensWithForwardPrefix(s), s).toBe(true);
    }
    for (const s of ["Re: x", "AW: x", "Re: Fwd: x", "AW: WG: x", "x", "the fwd: convention", "VS: x", ""]) {
      expect(opensWithForwardPrefix(s), s).toBe(false);
    }
  });
});
