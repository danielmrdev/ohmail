import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import { messages, mailboxes } from "../src/index.js";
import { dialect, sqliteDialect } from "../src/dialect/index.js";

/**
 * SEVERAL ESTIMATES IN ONE PLAN. A search's estimate asks the planner about each cut arm and about
 * the mailbox; one EXPLAIN over their `union all` reads each branch's own estimate off the Append,
 * so the answer costs one statement where it cost one per arm. Real planner (PGlite): the one-plan
 * readings equal each statement asked apart, in order; a single statement is asked as itself.
 */
describe("estimateRowsEach reads each statement's estimate from one plan", () => {
  it("equals the statements asked apart, in their order", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "each@estimate.example" }).returning();
    for (let i = 0; i < 40; i++) {
      await db.insert(messages).values({
        accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `each:${randomUUID()}`, subject: `note ${i}`,
        fromAddress: `s${i % 4}@estimate.example`, date: new Date(Date.UTC(2026, 8, 1, i)), unread: i % 3 === 0,
        hasAttachments: false, nativeLocator: { folder: "INBOX", ref: `1:${i}` },
      });
    }
    await db.execute(sql`analyze messages`);
    const d = dialect(db);
    const statements = [
      sql`select m.id from messages m where m.account_id = ${accountId}`,
      sql`select m.id from messages m where m.account_id = ${accountId} and m.unread = true`,
      sql`select m.id from messages m where m.account_id = ${accountId} and lower(m.from_address) = ${"s1@estimate.example"}`,
    ];
    const apart = await Promise.all(statements.map((s) => d.search.estimateRows(db, s)));
    expect(apart.every((n) => typeof n === "number" && n > 0), "the planner answers each").toBe(true);
    expect(new Set(apart).size, "three different readings, so an order mix-up would show").toBe(3);
    let asked = 0;
    const counted = new Proxy(db, {
      get(t, p, r) {
        if (p === "execute") return (...a: unknown[]) => { asked++; return (t.execute as (...x: unknown[]) => unknown)(...a); };
        return Reflect.get(t, p, r);
      },
    });
    expect(await d.search.estimateRowsEach(counted, statements)).toEqual(apart);
    expect(asked, "one statement for the three").toBe(1);
    expect(await d.search.estimateRowsEach(db, statements.slice(0, 1))).toEqual(apart.slice(0, 1));
    expect(await d.search.estimateRowsEach(db, [])).toEqual([]);
  });

  it("a store that keeps no statistics answers null for each", async () => {
    expect(await sqliteDialect().search.estimateRowsEach({}, [sql`select 1`, sql`select 2`])).toEqual([null, null]);
  });
});
