import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, rules as rulesTbl } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "../src/adapters/drizzle-repo.js";
import { compareRules } from "../src/rules.js";

/**
 * THE KIND BEFORE THE EFFECT, IN BOTH STATEMENTS OF THE ORDER (FIX-024).
 *
 * `listRules`' ORDER BY and `compareRules` must rank one rule set identically, or `psql` shows a
 * winner the router does not pick. The set crosses every clause the order moved: a higher
 * priority, an address rule against a domain rule of the opposite effect, and deny against allow
 * within one kind — with ids nudged so the id tie-break wants the opposite of each clause.
 */

const AVAILABLE = await realPgAvailable();
const PERSON = "person@shop.example";

/** A valid v4 UUID whose FIRST hex digit is forced, so a set of them has a known relative order. */
const nudged = (first: string): string => first + randomUUID().slice(1);

describe.skipIf(!AVAILABLE)("the order over rules, in SQL and in TypeScript", () => {
  let owned: OwnedDb;
  beforeAll(async () => { await runMigrations(PG_TEST_URL); owned = makeOwnedDb(PG_TEST_URL); }, 120_000);
  afterAll(async () => { await owned?.close().catch(() => {}); });

  it.each(["as written", "reversed"] as const)("ranks the set one way — inserted %s", async (insertion) => {
    const accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `ro-${accountId.slice(0, 8)}` });
    const loud = { id: nudged("f"), kind: "domain", match: "shop.example", destination: "ohmail/News", priority: 3 };
    const hold = { id: nudged("e"), kind: "sender", match: PERSON, destination: "ohmail/Screened", priority: 0, subjectContains: "invoice" };
    const allow = { id: nudged("8"), kind: "sender", match: PERSON, destination: "INBOX", priority: 0 };
    const domainDeny = { id: nudged("0"), kind: "domain", match: "shop.example", destination: "ohmail/Screened", priority: 0 };
    const set = [loud, hold, allow, domainDeny];
    for (const r of insertion === "as written" ? set : [...set].reverse()) {
      await owned.db.insert(rulesTbl).values({ accountId, provenance: "manual", enabled: true, ...r });
    }
    const listed = await makeDrizzleRepo(owned.db).listRules(accountId);
    // Priority, then the address rules (the deny before the allow), then the domain's deny.
    expect(listed.map((r) => r.id)).toEqual([loud.id, hold.id, allow.id, domainDeny.id]);
    expect([...listed].sort(compareRules).map((r) => r.id)).toEqual(listed.map((r) => r.id));
  }, 120_000);
});
