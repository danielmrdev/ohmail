import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { accounts, mailboxes, messages, folderState, flagState, changeLog, DECISION_BATCH_MAX, type Tx } from "@trafficflow/db";
import { schema, makePooledDb, closePooledDbs } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable, recordPgWire } from "@trafficflow/db/testing";
import { readStateRetroPass } from "../src/read-retro.js";

/**
 * THE READ-RETRO PASS WRITTEN IN SETS, ON REAL POSTGRES. Two things PGlite cannot show: a rival
 * holding the read state of a letter in the page's SECOND set while that set's intent upsert
 * waits (the rival's observed `\Seen` stands and the intent is judged against it, the rest of the
 * set lands, the change rows keep the walk's order), and the production driver's round trips
 * over the runner's loop, read off the wire. Reads are scoped to each case's own account.
 */
const wire = recordPgWire();
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
const made: string[] = [];

/** `letters` unread screened-out letters of one mailbox; their ids in the pass's walk order. */
async function newWorld(letters: number): Promise<{ accountId: string; mailboxId: string; ids: string[] }> {
  const accountId = randomUUID();
  made.push(accountId);
  await db.insert(accounts).values({ id: accountId, name: `rrb-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `rrb-${accountId.slice(0, 8)}@example.test`,
  }).returning();
  const rows = Array.from({ length: letters }, (_x, i) => ({
    id: randomUUID(), accountId, mailboxId: mb!.id, bodyHash: `b${i}`, dedupKey: `rrb:${randomUUID()}`,
    subject: `Note ${i}`, fromAddress: `sender-${i}@corp.test`, unread: true,
    nativeLocator: { folder: "ohmail/Screened", ref: `1:${i}` },
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    await db.insert(messages).values(part);
    await db.insert(folderState).values(part.map((r) => ({
      messageId: r.id, desiredFolder: "ohmail/Screened", observedFolder: "ohmail/Screened",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    })));
  }
  return { accountId, mailboxId: mb!.id, ids: rows.map((r) => r.id).sort() };
}

async function waitForLockWait(deadlineMs = 10_000): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const [row] = await client<Array<{ n: number }>>`
      select count(*)::int as n from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock' and state = 'active'
         and query ilike 'insert into "flag_state"%'`;
    if ((row?.n ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe.skipIf(!PG_UP)("the read-retro pass written in sets, on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterEach(async () => {
    for (const accountId of made.splice(0)) {
      const ids = db.select({ id: messages.id }).from(messages).where(eq(messages.accountId, accountId));
      await db.delete(changeLog).where(eq(changeLog.accountId, accountId));
      await db.delete(flagState).where(inArray(flagState.messageId, ids));
      await db.delete(folderState).where(inArray(folderState.messageId, ids));
      await db.delete(messages).where(eq(messages.accountId, accountId));
    }
  });
  afterAll(async () => { await closePooledDbs(); await client?.end({ timeout: 5 }); });

  it("A: a rival holding a second-set letter's read state: its \\Seen stands, the set lands in order", async () => {
    const w = await newWorld(2 * DECISION_BATCH_MAX);
    const victim = w.ids[DECISION_BATCH_MAX + 9]!;
    await db.insert(flagState).values({
      messageId: victim, desiredSeen: false, observedSeen: false, lastSetBy: "external",
      reconcileStatus: "reconciled", conflict: false,
    });
    const rival = await client.reserve();
    let blocked = false;
    try {
      await rival`begin`;
      await rival`update flag_state set observed_seen = true where message_id = ${victim}::uuid`;
      const pass = readStateRetroPass(db as unknown as Tx, { accountId: w.accountId, mailboxId: w.mailboxId });
      blocked = await waitForLockWait();
      await rival`commit`;
      expect((await pass).marked).toBe(w.ids.length);
    } finally {
      rival.release();
    }
    expect(blocked, "the second set's upsert never waited on the rival, so this proved nothing").toBe(true);

    const flags = new Map((await db.select().from(flagState).where(inArray(flagState.messageId, w.ids)))
      .map((r) => [r.messageId, r]));
    expect(flags.get(victim), "judged against the rival's committed \\Seen").toMatchObject({
      desiredSeen: true, observedSeen: true, reconcileStatus: "reconciled", lastSetBy: "us",
    });
    for (const id of w.ids.filter((x) => x !== victim)) {
      expect(flags.get(id)).toMatchObject({ desiredSeen: true, observedSeen: false, reconcileStatus: "pending" });
    }
    const log = await db.select().from(changeLog)
      .where(eq(changeLog.accountId, w.accountId)).orderBy(asc(changeLog.seq));
    expect(log.map((r) => `${r.op}:${r.entityId}`)).toEqual(w.ids.map((id) => `update:${id}`));
    const seqs = log.map((r) => Number(r.seq));
    expect(seqs[seqs.length - 1]! - seqs[0]!).toBe(seqs.length - 1);
  }, 120_000);

  it("B: on the production driver its round trips grow by set, not by letter", async () => {
    const pooled = makePooledDb(PG_TEST_URL);
    await pooled.execute(sql`select 1`); // the connection's own opening is not the pass's
    const trips = async (letters: number): Promise<number> => {
      const w = await newWorld(letters);
      wire.start();
      for (let runs = 0; runs < 100; runs++) {
        const r = await readStateRetroPass(pooled as unknown as Tx, { accountId: w.accountId, mailboxId: w.mailboxId });
        if (!r.capped) break;
      }
      const n = wire.read().roundTrips;
      const all = await db.select({ u: messages.unread }).from(messages).where(eq(messages.accountId, w.accountId));
      expect(all).toHaveLength(letters);
      expect(all.filter((r) => r.u)).toHaveLength(0);
      return n;
    };
    const small = await trips(200);
    const large = await trips(2000);
    const perSet = (large - small) / (2000 / DECISION_BATCH_MAX - 200 / DECISION_BATCH_MAX);
    console.log(`round trips: 200 -> ${small}, 2000 -> ${large}, ${perSet.toFixed(2)} a set`);
    expect(perSet).toBeLessThanOrEqual(8);
  }, 240_000);
});
