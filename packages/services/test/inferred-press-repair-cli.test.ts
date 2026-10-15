import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, applyScreenerDecision, rules, type Tx } from "@trafficflow/db";
import { carryDialect } from "@trafficflow/db/dialect";
import { applyAll, main, planAll } from "../src/inferred-press-repair-cli.js";

/**
 * THE CLOUD WINDOW'S RUN: plan, apply, plan again reads 0. The output names accounts and rules by
 * id and count, never an address; the variable is its own and nothing ambient is read.
 */
const NOW = new Date("2026-09-20T10:00:00Z");

async function moved(db: Tx, accountId: string, address: string, to: string) {
  await db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx as object) as unknown as Tx, {
    accountId, scope: "sender", address, appliedFolder: "ohmail/News", decision: "yes",
    triggeringActionId: `screener:${randomUUID()}`, now: NOW, decidedBy: "person", overExisting: "converge",
  }));
  await db.update(rules).set({ destination: to, updatedAt: new Date(NOW.getTime() + 60_000) })
    .where(eq(rules.match, address));
}

describe("the inferred-press repair's operator run", () => {
  it("plan, apply, plan reads 0 — ids and counts only", async () => {
    const db = (await makeTestDb()) as unknown as Tx;
    const [a, b] = [randomUUID(), randomUUID()];
    for (const id of [a, b]) await db.insert(accounts).values({ id, name: `cli-${id.slice(0, 8)}` });
    const who = `${randomUUID().slice(0, 8)}@letter.example`;
    await moved(db, a, who, "INBOX");
    await moved(db, b, `${randomUUID().slice(0, 8)}@letter.example`, "ohmail/Receipts");

    const lines: string[] = [];
    expect(await planAll(db, (l) => lines.push(l))).toBe(1);
    const [rule] = await db.select({ id: rules.id }).from(rules).where(eq(rules.match, who));
    expect(lines).toEqual([`account ${a}  rules 1  ${rule!.id}`, "TOTAL  rules 1"]);
    expect(lines.join("\n"), "never an address").not.toMatch(/@/);

    expect(await applyAll(db, (l) => lines.push(l))).toBe(1);
    const again: string[] = [];
    expect(await planAll(db, (l) => again.push(l))).toBe(0);
    expect(again).toEqual(["TOTAL  rules 0"]);
    expect(await applyAll(db, () => undefined), "a second apply writes nothing").toBe(0);
  });

  it("refuses without its own variable, and refuses an unknown argument", async () => {
    const prev = process.env.OHMAIL_INFERRED_PRESS_REPAIR_DB_URL;
    delete process.env.OHMAIL_INFERRED_PRESS_REPAIR_DB_URL;
    try {
      await expect(main(["plan"])).rejects.toThrow(/OHMAIL_INFERRED_PRESS_REPAIR_DB_URL/);
      expect(await main(["plan", "--mailbox", "x"])).toBe(2);
    } finally {
      if (prev !== undefined) process.env.OHMAIL_INFERRED_PRESS_REPAIR_DB_URL = prev;
    }
  });
});
