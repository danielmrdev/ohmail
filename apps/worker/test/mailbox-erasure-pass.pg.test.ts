import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, erasureRemaining, mailboxes, messageBodies, messages, stampMailboxErasure, type Tx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { MAILBOX_ERASURE_PASS_BUDGET_MS, mailboxErasurePass } from "../src/mailbox-erasure-pass.js";

/**
 * THE ERASURE PASS — the sweep a "Remove and erase" press owes, driven the way the worker cycle
 * drives it. One mailbox at a time per account, oldest stamp first; the wall-clock bound ends a
 * pass between steps and the next pass resumes from the stamp alone. Real Postgres: every step
 * takes the account row FOR SHARE and the mailbox row FOR UPDATE. Scoped to its own accounts
 * through the pass's `shard` slot, since other files leave stamps on the same database.
 */

const PG_UP = await realPgAvailable();
const NOW = new Date("2026-09-23T10:00:00.000Z");
let client: ReturnType<typeof postgres>;
let db: Tx;

async function mailbox(accountId: string, label: string, n: number): Promise<string> {
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${label}-${randomUUID().slice(0, 6)}@example.test`,
  }).returning();
  for (let i = 0; i < n; i += 1) {
    const k = `${mb!.id}:${i}`;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: k, dedupKey: k, subject: `m${i}`, fromAddress: "a@example.test",
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "body" });
  }
  return mb!.id;
}

async function stamp(accountId: string, mailboxId: string, at: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await stampMailboxErasure(tx as unknown as Tx, { accountId, mailboxId, now: at });
  });
}

const owedIn = (ids: string[]) => inArray(mailboxes.accountId, ids);
const done = async (id: string) =>
  (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!.erasureDoneAt !== null;

describe.skipIf(!PG_UP)("mailboxErasurePass — the worker's half of the per-mailbox erase", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg") as unknown as Tx;
  }, 180_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("one mailbox at a time per account, oldest stamp first, each finished and stamped", async () => {
    const x = randomUUID(); const y = randomUUID();
    await db.insert(accounts).values([{ id: x, name: "erase-x" }, { id: y, name: "erase-y" }]);
    const x1 = await mailbox(x, "x1", 3);
    const x2 = await mailbox(x, "x2", 3);
    const y1 = await mailbox(y, "y1", 2);
    const kept = await mailbox(x, "kept", 2);
    await stamp(x, x1, new Date(NOW.getTime() - 60_000));
    await stamp(x, x2, NOW);
    await stamp(y, y1, NOW);

    const first = await mailboxErasurePass(db, { now: () => NOW, shard: owedIn([x, y]) });
    expect(first.finished, "the pass did not finish one mailbox per account").toBe(2);
    expect(await done(x1)).toBe(true);
    expect(await done(y1)).toBe(true);
    expect(await done(x2), "a second mailbox of one account ran in the same pass").toBe(false);
    expect(await erasureRemaining(db, x, x2)).toBe(3);

    const second = await mailboxErasurePass(db, { now: () => NOW, shard: owedIn([x, y]) });
    expect(second.finished).toBe(1);
    expect(await done(x2)).toBe(true);
    expect(await erasureRemaining(db, x, x2)).toBe(0);
    // POSITIVE CONTROL: the account's mailbox nobody asked to erase keeps every message.
    expect(await erasureRemaining(db, x, kept)).toBe(2);
    expect(await done(kept)).toBe(false);
    const third = await mailboxErasurePass(db, { now: () => NOW, shard: owedIn([x, y]) });
    expect(third, "a pass with nothing owed did work").toMatchObject({ steps: 0, finished: 0 });
  });

  it("the wall-clock bound ends a pass between steps, and the next pass resumes from the stamp", async () => {
    const z = randomUUID();
    await db.insert(accounts).values({ id: z, name: "erase-z" });
    const z1 = await mailbox(z, "z1", 4);
    await stamp(z, z1, NOW);
    let reads = 0;
    // The pass's start, its check before the mailbox, the check before step one — then past it.
    const clock = () => (reads++ < 3 ? 0 : MAILBOX_ERASURE_PASS_BUDGET_MS);
    const cut = await mailboxErasurePass(db, { now: () => NOW, shard: owedIn([z]), clock });
    expect(cut.steps, "the bound did not stop the pass after one step").toBe(1);
    expect(await done(z1)).toBe(false);
    expect(await erasureRemaining(db, z, z1)).toBe(0);

    const resumed = await mailboxErasurePass(db, { now: () => NOW, shard: owedIn([z]) });
    expect(resumed.finished).toBe(1);
    expect(await done(z1)).toBe(true);
  });
});
