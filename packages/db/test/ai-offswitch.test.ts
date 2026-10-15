import { describe, it, expect } from "vitest";
import { asc, eq } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import { accounts, auditLog, type Tx } from "@trafficflow/db";
import { getAiEnabled, setAiEnabled } from "../src/ai-settings.js";

/**
 * THE ACCOUNT'S OWN AI SWITCH (migration 0022) — the setting, its audit trail, and its undo.
 *
 * What this file USED to also cover was the SPEND the switch gates: a paid-up account, a real
 * ledger, and a gate that answered `refused` rather than `insufficient` so a funded customer who
 * had turned AI off was never shown a payment demand. That distinction survives — it is two of
 * the entitlements port's five verdicts — but the gate that makes it is the entitlements
 * program's, and it is proven there. The switch is product on every deployment, so it stays here.
 */
type Db = Awaited<ReturnType<typeof makeTestDb>>;

/** An account, and nothing else: the switch is the only thing under test. */
async function seed(): Promise<{ db: Db; accountId: string }> {
  const db = await makeTestDb();
  const [acct] = await db.insert(accounts).values({ name: "off-switch" }).returning();
  return { db, accountId: acct!.id };
}

describe("the setting itself", () => {
  it("defaults to ON, so migration 0022 changes nothing for anybody", async () => {
    const { db, accountId } = await seed();
    expect(await getAiEnabled(db as unknown as Tx, accountId)).toBe(true);
  });

  it("round-trips, and records WHO changed it and what the undo is", async () => {
    const { db, accountId } = await seed();

    const off = await db.transaction((tx) =>
      setAiEnabled(tx as unknown as Tx, accountId, false, { userId: "user-7", requestId: "req-9" }));
    expect(off).toEqual({ aiEnabled: false, changed: true });
    expect(await getAiEnabled(db as unknown as Tx, accountId)).toBe(false);

    const [audit] = await db.select().from(auditLog)
      .where(eq(auditLog.accountId, accountId)).orderBy(asc(auditLog.createdAt));
    expect(audit!.action).toBe("account.ai_enabled");
    expect(audit!.payload).toMatchObject({ aiEnabled: false, userId: "user-7", requestId: "req-9" });
    // "Why is AI off for this customer" is asked once, months later, by someone who was not
    // there — and the inverse is the whole undo.
    expect(audit!.inverse).toEqual({ aiEnabled: true });
  });

  it("a no-op write writes NO audit row — the trail records changes, not requests", async () => {
    const { db, accountId } = await seed();
    const result = await db.transaction((tx) => setAiEnabled(tx as unknown as Tx, accountId, true));

    expect(result).toEqual({ aiEnabled: true, changed: false });
    expect(await db.select().from(auditLog).where(eq(auditLog.accountId, accountId))).toHaveLength(0);
  });
});
