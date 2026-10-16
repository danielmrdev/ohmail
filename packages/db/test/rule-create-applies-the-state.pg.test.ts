import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { applyRuleRequest, type ValidatedRuleCreate } from "../src/request-apply.js";
import { accounts, rules } from "../src/schema-mail.js";
import { brandDialect } from "../src/dialect/index.js";
import type { LedgerTx, Tx } from "../src/change-log.js";

/**
 * ═══ "ALREADY APPLIED" MEANS THE REQUESTED STATE HOLDS ══════════════════════════════════════
 *
 * A reader with a stale profile creates a rule on a key the organizer already has a rule for, and
 * asks for a different destination. `findRuleByKey` matches on the four key fields alone, so the
 * drain found the row, wrote nothing, and answered `applied`. The person's mail kept going where
 * the old rule sent it and they had been told their new rule was in force — a false state, not a
 * lost write.
 *
 * WHY POSTGRES. The comparison and the write it implies are one transaction: the row is read,
 * the difference is computed from it, and the update lands before the delta is appended. PGlite
 * serializes a single connection and would green a drain that read one row and wrote another.
 *
 * The positive control is the reason the lookup exists at all: a genuinely identical request
 * still writes NOTHING. A fix that reconciles by rewriting every row on every replay would pass
 * every difference arm here and fail that one.
 */
const PG_UP = await realPgAvailable();

const client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
const db = brandDialect(drizzle(client), "pg");

const SEED_AT = new Date("2026-09-14T09:00:00.000Z");
const APPLY_AT = new Date("2026-09-14T11:00:00.000Z");
const READS = "ohmail/News";
const RECEIPTS = "ohmail/Receipts";

async function freshAccount(): Promise<string> {
  const id = randomUUID();
  await db.insert(accounts).values({ id, name: `rcas-${id.slice(0, 8)}` });
  return id;
}

/** One key per case, so no two cases can read each other's rule. */
function freshKey(): ValidatedRuleCreate["key"] {
  return { kind: "sender", match: `${randomUUID()}@applied.example`, subjectContains: null, bodyContains: null };
}

function create(
  key: ValidatedRuleCreate["key"], over: Partial<Omit<ValidatedRuleCreate, "op" | "key">> = {},
): ValidatedRuleCreate {
  return {
    op: "create", key,
    destination: READS, priority: 0, enabled: true, applyRetro: false,
    ...over,
  };
}

async function apply(accountId: string, payload: ValidatedRuleCreate, now: Date) {
  return (db as unknown as Tx).transaction((tx) =>
    applyRuleRequest(tx as unknown as LedgerTx, { accountId, payload, now }));
}

async function rowsFor(accountId: string, key: ValidatedRuleCreate["key"]) {
  return db.select().from(rules)
    .where(and(eq(rules.accountId, accountId), eq(rules.match, key.match)));
}

/** Seed through the applier itself: the organizer's own create is how these rows arrive. */
async function seed(accountId: string, key: ValidatedRuleCreate["key"], over: Partial<Omit<ValidatedRuleCreate, "op" | "key">> = {}) {
  const res = await apply(accountId, create(key, over), SEED_AT);
  expect(res.applied).toBe(true);
  return (await rowsFor(accountId, key))[0]!;
}

afterAll(async () => { await client.end({ timeout: 5 }); });

describe.skipIf(!PG_UP)("a rule.create on an existing key applies the state it asked for", () => {
  it("DESTINATION — the rule is the requested one, and the ack is about the world", async () => {
    const accountId = await freshAccount();
    const key = freshKey();
    const before = await seed(accountId, key, { destination: READS });
    expect(before.destination).toBe(READS);

    const res = await apply(accountId, create(key, { destination: RECEIPTS }), APPLY_AT);

    const after = await rowsFor(accountId, key);
    expect(after).toHaveLength(1);              // never a second row for one key
    expect(after[0]!.destination).toBe(RECEIPTS);
    expect(res.applied).toBe(true);
    expect(res.applied && res.ruleId).toBe(before.id);
  });

  it("PRIORITY — the field the first fix would have missed", async () => {
    const accountId = await freshAccount();
    const key = freshKey();
    await seed(accountId, key, { priority: 0 });

    await apply(accountId, create(key, { priority: 7 }), APPLY_AT);

    const after = await rowsFor(accountId, key);
    expect(after).toHaveLength(1);
    expect(after[0]!.priority).toBe(7);
  });

  it("ENABLED — a rule asked for off is off", async () => {
    const accountId = await freshAccount();
    const key = freshKey();
    await seed(accountId, key, { enabled: true });

    await apply(accountId, create(key, { enabled: false }), APPLY_AT);

    const after = await rowsFor(accountId, key);
    expect(after).toHaveLength(1);
    expect(after[0]!.enabled).toBe(false);
  });

  it("ALL THREE AT ONCE — one transaction, one row, every field the request carried", async () => {
    const accountId = await freshAccount();
    const key = freshKey();
    await seed(accountId, key, { destination: READS, priority: 0, enabled: true });

    await apply(accountId, create(key, { destination: RECEIPTS, priority: 3, enabled: false }), APPLY_AT);

    const after = await rowsFor(accountId, key);
    expect(after).toHaveLength(1);
    expect({
      destination: after[0]!.destination, priority: after[0]!.priority, enabled: after[0]!.enabled,
    }).toEqual({ destination: RECEIPTS, priority: 3, enabled: false });
  });

  it("POSITIVE CONTROL — an identical request writes nothing at all", async () => {
    const accountId = await freshAccount();
    const key = freshKey();
    const before = await seed(accountId, key, { destination: READS, priority: 2, enabled: true });

    const res = await apply(accountId, create(key, { destination: READS, priority: 2, enabled: true }), APPLY_AT);

    const after = await rowsFor(accountId, key);
    expect(after).toHaveLength(1);
    expect(res.applied).toBe(true);
    // The row was not touched: `updated_at` still the seed's, and the retro walk not re-armed.
    expect(after[0]!.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after[0]!.retroRequestedAt).toBeNull();
  });

  it("RETRO — a create that retargets an existing rule re-opens the backlog, a reorder does not", async () => {
    const accountId = await freshAccount();
    const retarget = freshKey();
    await seed(accountId, retarget, { destination: READS });
    await apply(accountId, create(retarget, { destination: RECEIPTS, applyRetro: true }), APPLY_AT);
    const moved = (await rowsFor(accountId, retarget))[0]!;
    expect(moved.retroRequestedAt?.getTime()).toBe(APPLY_AT.getTime());
    expect(moved.retroDoneAt).toBeNull();
    expect(moved.retroCursor).toBeNull();

    const reorder = freshKey();
    await seed(accountId, reorder, { destination: READS, priority: 0 });
    await apply(accountId, create(reorder, { destination: READS, priority: 5, applyRetro: true }), APPLY_AT);
    const same = (await rowsFor(accountId, reorder))[0]!;
    expect(same.priority).toBe(5);
    expect(same.retroRequestedAt).toBeNull();   // nothing about where its mail goes moved
  });

  /**
   * THE WORD THE SEAM ANSWERS. A create that meets a row under the same key RECONCILES it — it
   * writes the difference and records an `update` delta — and it used to answer `op: "create"`,
   * the word the REQUEST used rather than the one for what happened. Nothing was told the wrong
   * word (`request-drain.ts` reduces the result to `applied`), and a seam that answers what it
   * was asked is one reader away from saying "created" about a rule that already existed.
   */
  it("a reconciled create answers what it DID, not the word it was asked with", async () => {
    const accountId = await freshAccount();
    const key = freshKey();
    await seed(accountId, key, { destination: RECEIPTS });

    const res = await apply(accountId, create(key, { destination: READS }), APPLY_AT);

    expect(res.applied && res.op, "a request that edited an existing rule answered \"create\"").toBe("update");
    const after = await rowsFor(accountId, key);
    expect(after, "the reconcile wrote a second row").toHaveLength(1);
    expect(after[0]!.destination).toBe(READS);
  });

  it("POSITIVE CONTROL — a key with no row is still an ordinary create", async () => {
    const accountId = await freshAccount();
    const key = freshKey();

    const res = await apply(accountId, create(key, { destination: RECEIPTS, priority: 4, enabled: false }), APPLY_AT);

    const after = await rowsFor(accountId, key);
    expect(after).toHaveLength(1);
    expect(res.applied && res.op).toBe("create");
    expect({
      destination: after[0]!.destination, priority: after[0]!.priority, enabled: after[0]!.enabled,
      provenance: after[0]!.provenance,
    }).toEqual({ destination: RECEIPTS, priority: 4, enabled: false, provenance: "manual" });
  });
});
