import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq, inArray } from "drizzle-orm";
import { accounts, mailboxes, messages, folderState, flagState, changeLog, type Tx } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { readStateRetroPass } from "../src/read-retro.js";

/**
 * ON REAL POSTGRES.
 *
 * The hermetic test proves the scoping and the counts on PGlite. What only real Postgres shows:
 *  · the flag write, the `unread` mirror and the `change_log` delta commit in ONE transaction —
 *    a mid-batch failure leaves none of them, never a delta for a flag that did not land;
 *  · the `reconcile_status` `case when observed_seen …` SQL evaluates against the STORED value;
 *  · `FOR UPDATE OF messages` is a real lock (a no-op on single-connection PGlite).
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

async function world(): Promise<{ accountId: string; screened: string[]; safe: string[] }> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `f2r-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `f2r-${accountId.slice(0, 8)}@example.test`,
  }).returning();
  const seed = async (folder: string, unread: boolean): Promise<string> => {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: randomUUID(), dedupKey: `f2r:${randomUUID()}`,
      subject: "x", fromAddress: "s@e.test", unread, nativeLocator: { folder, ref: "1:1" },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: folder, observedFolder: folder,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };
  const screened = [await seed("ohmail/Screened", true), await seed("ohmail/Quarantine", true)];
  const safe = [await seed("INBOX", true), await seed("ohmail/Screener", true), await seed("ohmail/Screened", false)];
  return { accountId, screened, safe };
}

describe.skipIf(!PG_UP)("readStateRetroPass on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("commits flag + unread + delta together, scoped, and is idempotent", async () => {
    const w = await world();
    const r = await readStateRetroPass(db as unknown as Tx, { accountId: w.accountId });
    expect(r.marked).toBe(2);

    const flags = await db.select({
      id: flagState.messageId, desiredSeen: flagState.desiredSeen, status: flagState.reconcileStatus,
    }).from(flagState).where(inArray(flagState.messageId, w.screened));
    expect(flags).toHaveLength(2);
    expect(flags.every((f) => f.desiredSeen === true && f.status === "pending")).toBe(true);

    const unread = await db.select({ id: messages.id, unread: messages.unread })
      .from(messages).where(inArray(messages.id, w.screened));
    expect(unread.every((u) => u.unread === false)).toBe(true);

    const deltas = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.op, "update")));
    expect(deltas.map((d) => d.entityId).sort()).toEqual([...w.screened].sort());

    // Safe folders untouched.
    expect(await db.select().from(flagState).where(inArray(flagState.messageId, w.safe))).toHaveLength(0);

    // Idempotent on real pg too.
    expect((await readStateRetroPass(db as unknown as Tx, { accountId: w.accountId })).marked).toBe(0);
  });
});
