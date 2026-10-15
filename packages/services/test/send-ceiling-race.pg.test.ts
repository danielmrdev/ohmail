import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { drafts, mailboxes, outboundSends } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { SendService } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * THE DOUBLE-SEND BOUNDARY ACROSS THE ATTEMPT CEILING — a retry racing a LATE SUCCESS, on real
 * Postgres.
 *
 * The ceiling introduces a state that did not exist before: an attempt whose caller has been
 * answered (`queued`) while the submission it started is STILL RUNNING and may finalize at any
 * moment. Everything the send path guarantees has to survive that overlap, and the overlap is
 * two connections writing the same `outbound_sends` row — one finalizing a delivery, one
 * resolving a retry.
 *
 * ## Why REAL Postgres, and not PGlite (CLAUDE.md)
 * PGlite is one connection: nothing there can hold a row lock against anything else, so the
 * interleaving under test cannot occur at all and a green run would mean nothing. Three
 * production bugs were invisible to it and every one was this class.
 *
 * ## What must be true, in the reader's terms
 * The recipient gets the message ONCE. Whatever order the two writers land in, exactly one
 * envelope was ever offered, and the row ends in a state that does not invite a second one.
 */
const PG_UP = await realPgAvailable();

const sqlA = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const sqlB = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");
const dbB = brandDialect(drizzle(sqlB, { schema }), "pg");

const NOW = new Date("2026-09-02T12:00:00.000Z");
const sleep = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });

async function seeded() {
  const accountId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const [mb] = await dbA.insert(mailboxes).values({
    accountId, provider: "imap", address: `ceiling-${tag}@race.test`,
  }).returning();
  const [d] = await dbA.insert(drafts).values({
    accountId, mailboxId: mb!.id, subject: "the slow send", body: "words",
    to: [{ name: null, address: "you@example.com" }], status: "draft",
    createdAt: NOW, updatedAt: NOW,
  }).returning();
  const ctxA: ServiceContext = { db: dbA, accountId, userId: null, now: () => NOW, requestId: "a" };
  // The RETRY arrives on its own connection, the way a second HTTP request does.
  const ctxB: ServiceContext = { db: dbB, accountId, userId: null, now: () => NOW, requestId: "b" };
  return { ctxA, ctxB, accountId, draftId: d!.id };
}

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await sqlA.end({ timeout: 5 }); await sqlB.end({ timeout: 5 }); });

describe.skipIf(!PG_UP)("a retry racing a submission that landed after the ceiling", () => {
  it("the late success wins and the retry offers NOTHING — one envelope, one delivery", async () => {
    const w = await seeded();
    const delivered: OutboundMessage[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });

    // The SLOW adapter: it takes the envelope, then waits — this is the submission that is still
    // in flight when its caller is answered.
    const slow: OpenSendAdapter = async () => ({
      async send(msg: OutboundMessage) {
        delivered.push(msg);
        await held;
        return { providerMessageId: msg.messageId! };
      },
      async messageInSent() { return false; },
      async close() { /* nothing to tear down */ },
    });
    // The RETRY's adapter. If the retry ever calls `send` on it, that is a second delivery to a
    // real person — the one outcome the whole reservation design exists to prevent.
    const retryAdapter: OpenSendAdapter = async () => ({
      async send(msg: OutboundMessage) {
        delivered.push(msg);
        return { providerMessageId: msg.messageId! };
      },
      async messageInSent() { return false; },
      async close() { /* nothing to tear down */ },
    });

    // 1 — the press. The ceiling fires while the submission is mid-flight.
    const first = await new SendService().send(
      w.ctxA, w.draftId, "same-key", { openSendAdapter: slow, attemptCeilingMs: 60 },
    );
    expect(first.status, "an abandoned submission is an unknown fate, not an ending").toBe("queued");
    expect(delivered, "one envelope has been offered").toHaveLength(1);

    // 2 — the impatient retry, under the SAME key, on a SECOND connection, while the first
    //     submission is still running. This is the whole race.
    const retryP = new SendService().send(
      w.ctxB, w.draftId, "same-key", { openSendAdapter: retryAdapter, attemptCeilingMs: 60 },
    );
    await sleep(50);

    // 3 — the first submission lands. Both writers are now live against one row.
    release();
    const retry = await retryP;
    await sleep(150); // let the late finalize commit

    expect(delivered, "THE RECIPIENT GOT IT TWICE").toHaveLength(1);
    expect(
      retry.status,
      "a reservation younger than the stale window may still have a live sender behind it",
    ).toBe("in_flight");

    const [row] = await dbA.select().from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
    expect(row!.status, "the late landing settles the row it reserved").toBe("sent");
    expect(row!.providerMessageId).toBe(row!.mintedMessageId);
    const [d] = await dbA.select().from(drafts).where(eq(drafts.id, w.draftId));
    expect(d!.status, "and the draft's own flip is what /sync carries to the client").toBe("sent");
    expect(d!.sendKey, "a terminal outcome ends the bookkeeping").toBeNull();
  });

  it("two presses on ONE draft in the ceiling window reserve ONCE — the second is refused, not sent", async () => {
    const w = await seeded();
    const delivered: OutboundMessage[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const adapter = (): OpenSendAdapter => async () => ({
      async send(msg: OutboundMessage) {
        delivered.push(msg);
        await held;
        return { providerMessageId: msg.messageId! };
      },
      async messageInSent() { return false; },
      async close() { /* nothing */ },
    });

    // Two genuinely concurrent presses on two connections, each with its OWN key — the shape a
    // double-tap takes once the durable client lock is bypassed (a second tab, a scripted caller).
    // `drafts.status` is what arbitrates: `reserve` accepts only a `draft`, and the first press's
    // flip to `sending` is what the second one must lose to.
    const [a, b] = await Promise.allSettled([
      new SendService().send(w.ctxA, w.draftId, "key-a", { openSendAdapter: adapter(), attemptCeilingMs: 60 }),
      new SendService().send(w.ctxB, w.draftId, "key-b", { openSendAdapter: adapter(), attemptCeilingMs: 60 }),
    ]);
    release();
    await sleep(150);

    const outcomes = [a, b].map((r) => (r.status === "fulfilled" ? r.value.status : "refused"));
    expect(
      outcomes.filter((o) => o === "refused"),
      "both presses reserved: one draft was offered to the recipient twice",
    ).toHaveLength(1);
    expect(delivered, "THE RECIPIENT GOT IT TWICE").toHaveLength(1);

    const rows = await dbA.select().from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
    expect(rows, "one draft, one reservation").toHaveLength(1);
  });
});
