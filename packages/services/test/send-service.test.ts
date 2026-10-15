import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, drafts, outboundSends, messages, threads } from "@trafficflow/db";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { SentCopyAppendFailed } from "@trafficflow/core";
import { SendService, SEND_STALE_AFTER_MS } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

const svc = new SendService();
const NOW = new Date("2026-07-28T12:00:00Z");

/**
 * A fake SendAdapter factory + a spy state so the double-send tests can COUNT
 * `send` calls and DRIVE `messageInSent` — no network (the crux of Phase 3c). It
 * echoes the pre-minted `messageId` back as the providerMessageId, exactly as the
 * real ImapAdapter does.
 */
function fakeAdapter(opts: { inSent?: boolean; throwOnSend?: boolean; throwAppendFailed?: boolean } = {}) {
  const state = { sendCalls: 0, closes: 0, sentIds: [] as string[], probed: [] as string[], sent: [] as OutboundMessage[] };
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      state.sendCalls += 1;
      state.sentIds.push(msg.messageId!);
      state.sent.push(msg);
      if (opts.throwOnSend) throw new Error("smtp boom");
      // The real adapter's shape for "SMTP took it, the Sent APPEND did not" — the delivered id rides the error.
      if (opts.throwAppendFailed) throw new SentCopyAppendFailed(msg.messageId!, new Error("append boom"));
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent(id: string) {
      state.probed.push(id);
      return opts.inSent ?? false;
    },
    async close() {
      state.closes += 1;
    },
  });
  return { factory, state };
}

async function setup() {
  const db = await makeTestDb();
  const A = randomUUID();
  const B = randomUUID();
  const [mb] = await db.insert(mailboxes).values({ accountId: A, provider: "imap", address: "mila@lichtgrat.example" }).returning();
  const ctx: ServiceContext = { db, accountId: A, userId: null, now: () => NOW, requestId: "r" };
  const ctxB: ServiceContext = { db, accountId: B, userId: null, now: () => NOW, requestId: "r" };
  async function newDraft(status = "draft", over: { subject?: string; body?: string } = {}) {
    const [d] = await db.insert(drafts).values({
      accountId: A, mailboxId: mb!.id, subject: "Re: hi", body: "Thanks!",
      to: [{ name: null, address: "you@example.com" }], status,
      ...over,
    }).returning();
    return d!.id;
  }
  return { db, A, B, mailboxId: mb!.id, ctx, ctxB, newDraft };
}

describe("SendService — gated idempotent send (Phase 3c)", () => {
  it("first send: SMTP once, draft → sent, outbound_sends → sent, providerMessageId captured", async () => {
    const { db, ctx, newDraft } = await setup();
    const draftId = await newDraft();
    const { factory, state } = fakeAdapter();

    const res = await svc.send(ctx, draftId, "k1", { openSendAdapter: factory });

    expect(res.status).toBe("sent");
    expect(state.sendCalls).toBe(1);
    expect(res.providerMessageId).toBe(state.sentIds[0]);      // the pre-minted id, echoed back
    expect(res.providerMessageId).toMatch(/^<.+@lichtgrat\.example>$/);  // minted from the mailbox domain
    expect(res.seq).toBeGreaterThan(0);
    expect(state.closes).toBe(1);                               // adapter always closed

    const [d] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(d!.status).toBe("sent");
    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect(row!.status).toBe("sent");
    expect(row!.providerMessageId).toBe(res.providerMessageId);
    expect(row!.mintedMessageId).toBe(res.providerMessageId);   // minted up front == delivered id
    expect(row!.sentAt).toBeInstanceOf(Date);
  });

  it("threads Cc AND Bcc from the draft into the OutboundMessage the adapter is handed", async () => {
    // The service is where the stored recipients become the envelope. The header/envelope
    // asymmetry that makes Bcc blind is one layer down (the MIME builder,
    // `packages/core/test/outbound-cc-bcc.test.ts`); what this proves is that the service does not
    // DROP the bcc on the way there — the bug this slice replaced, where `drafts.cc` was stored and
    // never delivered.
    const { db, ctx, A, mailboxId } = await setup();
    const [d] = await db.insert(drafts).values({
      accountId: A, mailboxId, subject: "numbers", body: "see attached",
      to: [{ name: null, address: "to@example.com" }],
      cc: [{ name: "Cee", address: "cc@example.com" }],
      bcc: [{ name: null, address: "bcc@example.com" }],
      status: "draft",
    }).returning();
    const { factory, state } = fakeAdapter();

    const res = await svc.send(ctx, d!.id, "cc-bcc-1", { openSendAdapter: factory });

    expect(res.status).toBe("sent");
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]!.to).toEqual(["to@example.com"]);
    expect(state.sent[0]!.cc).toEqual(["cc@example.com"]);
    expect(state.sent[0]!.bcc).toEqual(["bcc@example.com"]);
  });

  it("a draft with recipients ONLY in Bcc is still a real send, not 'no recipients'", async () => {
    // The "no recipients" refusal is about an empty envelope, not an empty To — a mailing-list
    // style blind send addresses everyone in Bcc.
    const { db, ctx, A, mailboxId } = await setup();
    const [d] = await db.insert(drafts).values({
      accountId: A, mailboxId, subject: "quiet word", body: "hi",
      to: [], cc: [], bcc: [{ name: null, address: "blind@example.com" }], status: "draft",
    }).returning();
    const { factory, state } = fakeAdapter();

    const res = await svc.send(ctx, d!.id, "bcc-only", { openSendAdapter: factory });

    expect(res.status).toBe("sent");
    expect(state.sent[0]!.to).toEqual([]);
    expect(state.sent[0]!.bcc).toEqual(["blind@example.com"]);
  });

  it("CRUX — same Idempotency-Key does NOT resend: send twice → send-count 1, same result", async () => {
    const { ctx, newDraft } = await setup();
    const draftId = await newDraft();
    const { factory, state } = fakeAdapter();

    const first = await svc.send(ctx, draftId, "same", { openSendAdapter: factory });
    const second = await svc.send(ctx, draftId, "same", { openSendAdapter: factory });

    expect(state.sendCalls).toBe(1);                            // NEVER a second send
    expect(second.status).toBe("sent");
    expect(second.providerMessageId).toBe(first.providerMessageId);
  });

  it("CRUX — crash-recovery, DELIVERED: a stale pending whose id IS in Sent reconciles to sent, NO resend", async () => {
    const { db, ctx, mailboxId, A } = await setup();
    // A crashed prior attempt: draft left 'sending', a pending outbound_sends row
    // whose minted id IS present in the Sent folder (fake messageInSent → true).
    const [d] = await db.insert(drafts).values({
      accountId: A, mailboxId, subject: "s", body: "b",
      to: [{ name: null, address: "you@example.com" }], status: "sending",
    }).returning();
    const minted = "<delivered-9f3c@lichtgrat.example>";
    await db.insert(outboundSends).values({
      accountId: A, idempotencyKey: "recover", draftId: d!.id, mintedMessageId: minted, status: "pending",
      // STALE, explicitly: older than `SEND_STALE_AFTER_MS`, so no invocation can still be behind
      // it. A YOUNG pending row is a send in flight and must answer `in_flight` instead of being
      // probed — see the dedicated case below.
      createdAt: new Date(NOW.getTime() - SEND_STALE_AFTER_MS - 1000),
    });
    const { factory, state } = fakeAdapter({ inSent: true });

    const res = await svc.send(ctx, d!.id, "recover", { openSendAdapter: factory });

    expect(res.status).toBe("sent");
    expect(state.sendCalls).toBe(0);                            // reconciled, NOT resent
    expect(state.probed).toContain(minted);                    // verified by Sent
    expect(res.providerMessageId).toBe(minted);
    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.id, (await db.select().from(outboundSends).where(eq(outboundSends.draftId, d!.id)))[0]!.id));
    expect(row!.status).toBe("sent");
    const [draft] = await db.select().from(drafts).where(eq(drafts.id, d!.id));
    expect(draft!.status).toBe("sent");
  });

  it("CRUX — crash-recovery, AMBIGUOUS: a stale pending NOT in Sent → unverified, NO resend", async () => {
    const { db, ctx, mailboxId, A } = await setup();
    const [d] = await db.insert(drafts).values({
      accountId: A, mailboxId, subject: "s", body: "b",
      to: [{ name: null, address: "you@example.com" }], status: "sending",
    }).returning();
    const minted = "<ambiguous-2b1a@lichtgrat.example>";
    await db.insert(outboundSends).values({
      accountId: A, idempotencyKey: "amb", draftId: d!.id, mintedMessageId: minted, status: "pending",
      createdAt: new Date(NOW.getTime() - SEND_STALE_AFTER_MS - 1000),     // stale: no live sender
    });
    const { factory, state } = fakeAdapter({ inSent: false });

    const res = await svc.send(ctx, d!.id, "amb", { openSendAdapter: factory });

    expect(res.status).toBe("unverified");
    expect(state.sendCalls).toBe(0);                            // NEVER auto-resend on ambiguity
    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.draftId, d!.id));
    expect(row!.status).toBe("unverified");
    const [draft] = await db.select().from(drafts).where(eq(drafts.id, d!.id));
    expect(draft!.status).toBe("unverified");
  });

  it("a YOUNG pending reservation is in_flight — the recovery path must not probe a live send", async () => {
    // The double-tap. The first attempt is still mid-SMTP; probing Sent now finds nothing (the
    // message has not landed YET) and writing `unverified` would report a SUCCEEDING send as
    // ambiguous and tell the user to go check their Sent folder. It also made the `in_flight`
    // outcome this service declares unreachable.
    const { db, ctx, mailboxId, A } = await setup();
    const [d] = await db.insert(drafts).values({
      accountId: A, mailboxId, subject: "s", body: "b",
      to: [{ name: null, address: "you@example.com" }], status: "sending",
    }).returning();
    await db.insert(outboundSends).values({
      accountId: A, idempotencyKey: "live", draftId: d!.id,
      mintedMessageId: "<inflight-1@lichtgrat.example>", status: "pending",
      createdAt: new Date(NOW.getTime() - 5_000),        // 5 s old: an invocation could still be alive
    });
    const { factory, state } = fakeAdapter({ inSent: false });

    const res = await svc.send(ctx, d!.id, "live", { openSendAdapter: factory });

    expect(res.status).toBe("in_flight");
    expect(state.sendCalls).toBe(0);                     // never resent
    expect(state.probed).toEqual([]);                    // and never even probed
    // The reservation is UNTOUCHED, so the real sender can still finalize it.
    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.draftId, d!.id));
    expect(row!.status).toBe("pending");
    const [draftRow] = await db.select().from(drafts).where(eq(drafts.id, d!.id));
    expect(draftRow!.status).toBe("sending");
  });

  it("the cutoff is a boundary, not a vibe: one ms past it, recovery runs", async () => {
    const { db, ctx, mailboxId, A } = await setup();
    const [d] = await db.insert(drafts).values({
      accountId: A, mailboxId, subject: "s", body: "b",
      to: [{ name: null, address: "you@example.com" }], status: "sending",
    }).returning();
    await db.insert(outboundSends).values({
      accountId: A, idempotencyKey: "edge", draftId: d!.id,
      mintedMessageId: "<edge-1@lichtgrat.example>", status: "pending",
      createdAt: new Date(NOW.getTime() - SEND_STALE_AFTER_MS - 1),
    });
    const { factory } = fakeAdapter({ inSent: true });
    expect((await svc.send(ctx, d!.id, "edge", { openSendAdapter: factory })).status).toBe("sent");
  });

  /**
   * THIS CASE USED TO ASSERT THE DEFECT, AND THE EXPECTATION MOVED BY RULING.
   *
   * It read: two drafts from the same fixture, sent under `key-A` and `key-B`, expecting TWO
   * deliveries and two reservation rows. That is not an incidental fixture collision — it is
   * exactly the sequence a duplicate send takes, written down as a passing test: one message, two
   * drafts, two keys, two copies in somebody's inbox. The account now claims a message's CONTENT
   * for `SEND_DUPLICATE_WINDOW_MS`, so the second one is refused whatever key it carries and
   * whatever draft it names.
   *
   * The original intent is worth keeping and is kept: a FRESH KEY IS NOT BLOCKED BY THE KEY GATE.
   * That is now asserted where it is actually true — on a different message — and the case the old
   * one really covered is asserted beside it, so this file is stricter than it was rather than
   * looser. Splitting them is what makes each one able to fail alone.
   */
  it("a DIFFERENT key on a DIFFERENT message sends again (a second outbound_sends row)", async () => {
    const { db, ctx, newDraft } = await setup();
    const d1 = await newDraft();
    const d2 = await newDraft("draft", { body: "Thanks — one more thing." });
    const { factory, state } = fakeAdapter();

    await svc.send(ctx, d1, "key-A", { openSendAdapter: factory });
    await svc.send(ctx, d2, "key-B", { openSendAdapter: factory });

    expect(state.sendCalls).toBe(2);
    const rows = await db.select().from(outboundSends);
    expect(rows).toHaveLength(2);
  });

  it("a DIFFERENT key on the SAME message is refused — one submission, and the second reservation rolls back", async () => {
    const { db, ctx, newDraft } = await setup();
    const d1 = await newDraft();
    const d2 = await newDraft();                     // byte-identical: the measured duplicate shape
    const { factory, state } = fakeAdapter();

    await svc.send(ctx, d1, "key-A", { openSendAdapter: factory });
    const err = await svc.send(ctx, d2, "key-B", { openSendAdapter: factory })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ httpStatus: 409, code: "duplicate_send" });
    // The assertion is the SUBMISSION count, not the row count: the submission is the harm.
    expect(state.sendCalls).toBe(1);
    // And the refusal rolled its own reservation back rather than leaving a spent row behind.
    const rows = await db.select().from(outboundSends);
    expect(rows).toHaveLength(1);
    const [second] = await db.select().from(drafts).where(eq(drafts.id, d2));
    expect(second!.status, "the refused draft is untouched and still sendable").toBe("draft");
  });

  it("SMTP throws but the id IS in Sent → sent (verify-on-throw, no assumption)", async () => {
    const { ctx, newDraft } = await setup();
    const draftId = await newDraft();
    const { factory, state } = fakeAdapter({ throwOnSend: true, inSent: true });

    const res = await svc.send(ctx, draftId, "throw-ok", { openSendAdapter: factory });

    expect(res.status).toBe("sent");
    expect(state.sendCalls).toBe(1);                            // the single (throwing) attempt
    expect(state.probed.length).toBe(1);                       // then verified by Sent
  });

  it("SMTP throws and the id is NOT in Sent → unverified (never blindly failed/resent)", async () => {
    const { ctx, newDraft } = await setup();
    const draftId = await newDraft();
    const { factory, state } = fakeAdapter({ throwOnSend: true, inSent: false });

    const res = await svc.send(ctx, draftId, "throw-amb", { openSendAdapter: factory });

    expect(res.status).toBe("unverified");
    expect(state.sendCalls).toBe(1);
  });

  /**
   * THE SENT COPY FAILED, NOT THE SEND. `ImapAdapter.send` appends to Sent AFTER `sendMail`
   * resolved, and one `catch` over both used to read an append fault as "SMTP threw": probe, miss
   * (nothing was appended), `unverified` — a person sent to look for their own delivered mail.
   * Mutation: drop the `SentCopyAppendFailed` arm in `send()`'s catch → status reads `unverified`.
   */
  it("the Sent APPEND fails after SMTP accepted the message → sent, no probe, the copy's absence logged", async () => {
    const { ctx, newDraft, db } = await setup();
    const draftId = await newDraft();
    const { factory, state } = fakeAdapter({ throwAppendFailed: true, inSent: false });
    const lines: string[] = [];
    const log = { info() {}, warn(ev: string) { lines.push(ev); }, error() {}, debug() {} } as never;

    const res = await svc.send(ctx, draftId, "append-failed", { openSendAdapter: factory, log });

    expect(res.status, "a delivered message was recorded as ambiguous because its Sent copy failed").toBe("sent");
    expect(state.probed.length, "the Sent folder was probed for a message the adapter said it delivered").toBe(0);
    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect(row!.status).toBe("sent");
    expect(row!.providerMessageId).toBe(state.sentIds[0]);
    expect(lines, "the missing copy is not said anywhere").toContain("send_sent_copy_append_failed");
  });

  it("cross-account draft → 404, and the adapter is never opened", async () => {
    const { ctxB, newDraft } = await setup();
    const draftId = await newDraft();                          // belongs to account A
    const { factory, state } = fakeAdapter();
    await expect(svc.send(ctxB, draftId, "x", { openSendAdapter: factory }))
      .rejects.toMatchObject({ httpStatus: 404 });
    expect(state.sendCalls).toBe(0);
  });

  it("an already-sent draft cannot be re-sent into a duplicate under a NEW key → 409, no resend, no orphan row", async () => {
    const { db, ctx, newDraft } = await setup();
    const draftId = await newDraft();
    const { factory, state } = fakeAdapter();
    await svc.send(ctx, draftId, "first", { openSendAdapter: factory });  // draft → sent
    expect(state.sendCalls).toBe(1);

    await expect(svc.send(ctx, draftId, "second", { openSendAdapter: factory }))
      .rejects.toMatchObject({ httpStatus: 409 });
    expect(state.sendCalls).toBe(1);                            // no second send
    const rows = await db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect(rows).toHaveLength(1);                               // the 409 rolled back its reservation
  });

  it("a draft with no recipients → 400", async () => {
    const { db, ctx, mailboxId, A } = await setup();
    const [d] = await db.insert(drafts).values({
      accountId: A, mailboxId, subject: "s", body: "b", status: "draft",
    }).returning();
    const { factory, state } = fakeAdapter();
    await expect(svc.send(ctx, d!.id, "no-to", { openSendAdapter: factory }))
      .rejects.toMatchObject({ httpStatus: 400 });
    expect(state.sendCalls).toBe(0);
    const rows = await db.select().from(outboundSends).where(and(eq(outboundSends.draftId, d!.id)));
    expect(rows).toHaveLength(0);                               // no orphan reservation
  });
});

/**
 * RFC 5322 §3.6.4 — References is the parent's chain PLUS the parent, not the parent alone.
 *
 * The shipped code sent `references: inReplyTo`. A recipient whose client threads on the
 * LEFTMOST reference then anchors the reply mid-chain and mints a second conversation for one
 * exchange — and our own ingest threads on the leftmost entry precisely because that is the
 * behaviour that converges (`threads.rootMessageIdHeader`). We were sending other people mail
 * we would have mis-threaded ourselves.
 *
 * We do not persist the arriving `References` header, so the full chain is unavailable; root +
 * parent is what the data supports and it is what carries the meaning. These guards assert
 * that contract, including its ORDER, which is the half that actually matters.
 */
describe("SendService — reply threading (RFC 5322 §3.6.4)", () => {
  async function replyTo(opts: { root: string | null; parentHeader: string }) {
    const { db, ctx, mailboxId, A } = await setup();
    const [th] = await db.insert(threads)
      .values({ accountId: A, subject: "Re: hi", rootMessageIdHeader: opts.root })
      .returning();
    const [parent] = await db.insert(messages).values({
      accountId: A, mailboxId, subject: "hi", messageIdHeader: opts.parentHeader,
      threadId: th!.id, nativeLocator: `INBOX:${randomUUID()}`,
      bodyHash: randomUUID(), dedupKey: opts.parentHeader,
    }).returning();
    const [d] = await db.insert(drafts).values({
      accountId: A, mailboxId, subject: "Re: hi", body: "Thanks!",
      to: [{ name: null, address: "you@example.com" }], status: "draft",
      inReplyToMessageId: parent!.id,
    }).returning();
    const { factory, state } = fakeAdapter();
    const sent: OutboundMessage[] = [];
    const spy: OpenSendAdapter = async () => {
      const a = await factory();
      return { ...a, async send(m: OutboundMessage) { sent.push(m); return a.send(m); } };
    };
    await svc.send(ctx, d!.id, "k-" + randomUUID(), { openSendAdapter: spy });
    expect(state.sendCalls).toBe(1);
    return sent[0]!;
  }

  it("carries the thread ROOT before the parent — a mid-chain reply keeps its conversation", async () => {
    const msg = await replyTo({ root: "<root@a.invalid>", parentHeader: "<parent@a.invalid>" });
    expect(msg.inReplyTo).toBe("<parent@a.invalid>");
    // Order is the assertion. `<parent> <root>` would anchor leftmost-threading clients on the
    // wrong id, which is the whole defect wearing different clothes.
    expect(msg.references).toBe("<root@a.invalid> <parent@a.invalid>");
  });

  it("does not repeat one id twice when replying to the root itself", async () => {
    const msg = await replyTo({ root: "<root@a.invalid>", parentHeader: "<root@a.invalid>" });
    expect(msg.references).toBe("<root@a.invalid>");
  });

  it("falls back to the parent alone when the thread has no root header", async () => {
    const msg = await replyTo({ root: null, parentHeader: "<parent@a.invalid>" });
    expect(msg.references).toBe("<parent@a.invalid>");
  });

  it("a message that is not a reply carries neither header", async () => {
    const { db, ctx, mailboxId, A } = await setup();
    const [d] = await db.insert(drafts).values({
      accountId: A, mailboxId, subject: "new", body: "b",
      to: [{ name: null, address: "you@example.com" }], status: "draft",
    }).returning();
    const sent: OutboundMessage[] = [];
    const { factory } = fakeAdapter();
    const spy: OpenSendAdapter = async () => {
      const a = await factory();
      return { ...a, async send(m: OutboundMessage) { sent.push(m); return a.send(m); } };
    };
    await svc.send(ctx, d!.id, "k-" + randomUUID(), { openSendAdapter: spy });
    expect(sent[0]!.inReplyTo).toBeUndefined();
    expect(sent[0]!.references).toBeUndefined();
  });
});
