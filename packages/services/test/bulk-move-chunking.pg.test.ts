import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { accounts, mailboxes, messages, OrganizedElsewhereError, type Tx } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { planBulkMoveOnReader } from "../src/reader-request.js";
import { brandDialect } from "@trafficflow/db/dialect";

/**
 * THE BULK-MOVE PLAN AT SCALE — real Postgres, because the ceiling is Postgres's.
 *
 * `planBulkMoveOnReader` asks which mailbox each of a list of message ids sits on, and neither
 * caller's list is bounded: the Hey migration's re-route names every matching message in the
 * account, a workflow undo one id per recorded step. The failure it guards is the server refusing
 * a statement over the bind-parameter ceiling, and it happens at BIND — before a row is read — so a
 * PGlite twin would assert the arithmetic against an implementation sharing the assumption. That
 * is also why the first case matches NOTHING: the limit counts parameters sent, not rows found.
 */
const PG_UP = await realPgAvailable();

const sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
const db = brandDialect(drizzle(sql, { schema }), "pg");
const tx = db as unknown as Tx;

/** The slice width in `reader-request.ts`. Named here so the second-chunk case cannot drift off it. */
const READ_CHUNK = 500;

interface World { accountId: string; organized: string; reader: string }

/** An account with one mailbox this install ORGANIZES and one it only READS. */
async function world(): Promise<World> {
  const accountId = randomUUID();
  const tag = accountId.slice(0, 8);
  await db.insert(accounts).values({ id: accountId, name: `bmc-${tag}` });
  const [own] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `own-${tag}@chunk.test`,
  }).returning();
  const [held] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `held-${tag}@chunk.test`,
    organizerRole: "reader", organizerState: "held",
    organizedByCapabilities: "requests,moves",
    organizedByKind: "local", organizedByName: "the other machine",
  }).returning();
  return { accountId, organized: own!.id, reader: held!.id };
}

async function seed(w: World, mailboxId: string): Promise<string> {
  const [row] = await db.insert(messages).values({
    accountId: w.accountId, mailboxId,
    bodyHash: randomUUID(), dedupKey: randomUUID(),
  }).returning({ id: messages.id });
  return row!.id;
}

/**
 * A ONE-WORD VERDICT, deliberately.
 *
 * `expect(promise).rejects` pretty-prints whatever it received when the assertion fails, and this
 * call's operand is a live database handle — a failed assertion would print the pool rather than
 * the defect, and has exhausted a worker's heap doing it. So the outcome is reduced to a string
 * here and the string is what gets compared.
 */
async function verdictOf(ids: readonly string[], accountId: string): Promise<string> {
  return planBulkMoveOnReader(tx, accountId, ids).then(
    (plan) => (plan.requestTo.length === 0
      ? "admitted"
      : plan.requestTo.map((t) => `travels:${t.mailboxId}`).sort().join(",")),
    (e: unknown) => (e instanceof OrganizedElsewhereError
      ? `refused:${e.mailboxId}`
      : `threw:${(e as Error).name}:${(e as Error).message.slice(0, 60)}`),
  );
}

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await sql.end({ timeout: 5 }); });

describe.skipIf(!PG_UP)("planBulkMoveOnReader against real Postgres", () => {
  it("takes 70 000 ids without reaching the bind-parameter ceiling", async () => {
    const w = await world();
    // Random uuids, so nothing matches: the ceiling is counted on parameters SENT, and a version
    // that binds them all is refused before it looks at a row.
    const ids = Array.from({ length: 70_000 }, () => randomUUID());
    expect(await verdictOf(ids, w.accountId)).toBe("admitted");
  }, 120_000);

  /* The slicing turns one answer into a union of N, and a union that stops early loses a held
     mailbox — the press then moves that mail from the wrong machine instead of asking the install
     that holds it. Mutating the loop to `return` after the first chunk reddens this and nothing
     else. */
  it("sees the reader's only message when it sits in the SECOND chunk", async () => {
    const w = await world();
    const onReader = await seed(w, w.reader);
    // One past the first slice's last index, so a walk that answers from chunk one alone sees
    // nothing on a reader and admits an operation that moves somebody's mail from the wrong machine.
    const ids: string[] = Array.from({ length: READ_CHUNK }, () => randomUUID());
    ids.push(onReader);
    expect(ids.indexOf(onReader)).toBe(READ_CHUNK);
    expect(await verdictOf(ids, w.accountId)).toBe(`travels:${w.reader}`);
  }, 60_000);

  /* THE ACCOUNT FENCE IS INSIDE EVERY CHUNK, and the ordinary foreign-account arm does NOT watch
     it: with the fence removed the walk finds the foreign row, reads its `mailbox_id`, and asks
     `readRequestEligibility`, which is itself account-scoped, returns null, and the loop skips it.
     Measured green. The arm that tells the two mechanisms apart is a `messages` row naming another
     account while its `mailbox_id` names THIS account's reader mailbox — the next case, where mail
     0116's composite key has since made that row unwritable. */
  it("a message this account does not own names no mailbox, in any chunk", async () => {
    const mine = await world();
    const theirs = await world();
    const onTheirReader = await seed(theirs, theirs.reader);

    // The positive control FIRST: the row is live and does name a mailbox for the account that
    // holds it. Without this, the isolation assertion below is satisfied by a fixture that never
    // existed.
    expect(await verdictOf([onTheirReader], theirs.accountId)).toBe(`travels:${theirs.reader}`);

    // Same id, our account. It must name no mailbox — in the first chunk and past it. Both of
    // these stay green with the fence removed, because eligibility is account-scoped too; they are
    // here for the behaviour, and the arm below is the one that watches the fence.
    expect(await verdictOf([onTheirReader], mine.accountId)).toBe("admitted");
    const padded: string[] = Array.from({ length: READ_CHUNK }, () => randomUUID());
    padded.push(onTheirReader);
    expect(await verdictOf(padded, mine.accountId)).toBe("admitted");
  }, 60_000);

  it("the row this fence was written for CANNOT BE WRITTEN any more — the store refuses it", async () => {
    // It used to be representable: `messages.account_id` was tied to nothing, so a row could point
    // at OUR reader mailbox while claiming somebody else's account, and planting one was the only
    // way to watch the fence work. Mail 0116's composite key refuses it at the door, so the state
    // the fence answers about is now unreachable — and a condition whose contrary state cannot
    // exist cannot be watched fail. What is asserted here is the refusal itself.
    const mine = await world();
    const stranger = await world();
    let code: string | null = null;
    try {
      await db.insert(messages).values({
        accountId: stranger.accountId, mailboxId: mine.reader,
        bodyHash: randomUUID(), dedupKey: randomUUID(),
      });
    } catch (err) { code = String((err as { code?: unknown }).code ?? "unknown"); }
    expect(code).toBe("23503");

    // And the ordinary shape still is: the fence answers from the CALLER'S account, so a message
    // that genuinely belongs to the stranger decides nothing about our mailboxes.
    const [row] = await db.insert(messages).values({
      accountId: stranger.accountId, mailboxId: stranger.reader,
      bodyHash: randomUUID(), dedupKey: randomUUID(),
    }).returning({ id: messages.id });
    expect(await verdictOf([row!.id], mine.accountId)).toBe("admitted");
    const padded: string[] = Array.from({ length: READ_CHUNK }, () => randomUUID());
    padded.push(row!.id);
    expect(await verdictOf(padded, mine.accountId)).toBe("admitted");
  }, 60_000);

  it("an id on a mailbox this install organizes is admitted at any size", async () => {
    const w = await world();
    const onOwn = await seed(w, w.organized);
    const ids: string[] = Array.from({ length: READ_CHUNK * 3 }, () => randomUUID());
    ids[READ_CHUNK * 2 + 7] = onOwn;
    expect(await verdictOf(ids, w.accountId)).toBe("admitted");
    // …and it comes back as work for THIS install, which "admitted" alone does not say.
    const plan = await planBulkMoveOnReader(tx, w.accountId, ids);
    expect(plan.organized).toEqual([onOwn]);
  }, 60_000);

  it("a holder that will not take moves is refused, at any chunk", async () => {
    /* The one answer that did not become a plan. Measured past the first slice too, because the
       eligibility read happens per MAILBOX after the walk — a refusal that only fired for a
       first-chunk hit would be a union bug wearing a refusal's clothes. */
    const w = await world();
    await db.update(mailboxes).set({ organizedByCapabilities: "requests" })
      .where(eq(mailboxes.id, w.reader));
    const onReader = await seed(w, w.reader);
    expect(await verdictOf([onReader], w.accountId)).toBe(`refused:${w.reader}`);
    const padded: string[] = Array.from({ length: READ_CHUNK }, () => randomUUID());
    padded.push(onReader);
    expect(await verdictOf(padded, w.accountId)).toBe(`refused:${w.reader}`);
  }, 60_000);
});
