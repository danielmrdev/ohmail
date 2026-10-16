import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { applyRuleRequest, type ValidatedRuleRequest } from "../src/request-apply.js";
import { accounts, rules } from "../src/schema.js";
import type { LedgerTx, Tx } from "../src/change-log.js";
import { carryDialect } from "../src/dialect/index.js";

/**
 * A TRAVELLED RULE REQUEST THAT NAMES WHERE THE RULE FILES MAKES AN INFERRED RULE THE PERSON'S.
 * A twin the Screener promoted (or the sent-mail seed inferred) stays demotable under `people_only`,
 * so a press "all their mail -> Ohbox" over it filed the next newsletter to News. Both arms that
 * meet an existing row write `manual`; an edit that names no place leaves the provenance alone.
 */

const NOW = new Date("2026-10-01T21:00:00.000Z");
const LATER = new Date("2026-10-01T22:00:00.000Z");

async function world(provenance: "promoted" | "seeded-from-sent" = "promoted") {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `rrmt-${accountId.slice(0, 8)}` });
  const key = { kind: "sender" as const, match: `${randomUUID()}@letter.example`, subjectContains: null, bodyContains: null };
  await db.insert(rules).values({
    accountId, kind: key.kind, match: key.match, destination: "ohmail/News", priority: 0, enabled: true, provenance,
  }).returning({ id: rules.id });
  // The store's brand rides the transaction, as the drain carries it (`request-drain.ts`).
  const apply = (payload: ValidatedRuleRequest, now: Date = NOW) => (db as unknown as Tx).transaction((tx) =>
    applyRuleRequest(carryDialect(db, tx as object) as unknown as LedgerTx, { accountId, payload, now }));
  const read = async () => (await db.select().from(rules)
    .where(and(eq(rules.accountId, accountId), eq(rules.match, key.match))))[0]!;
  return { key, apply, read };
}

describe("a travelled rule request that names the place makes the rule the person's", () => {
  it("update to another place: the promoted twin becomes manual and its backlog re-arms", async () => {
    const { key, apply, read } = await world();
    const res = await apply({ op: "update", key, set: { destination: "INBOX" }, applyRetro: true, retroAsked: false });
    expect(res.applied).toBe(true);
    const r = await read();
    expect(r.destination).toBe("INBOX");
    expect(r.provenance, "an inferred rule kept its provenance under the person's press").toBe("manual");
    expect(r.retroRequestedAt).toEqual(NOW);
  });

  it("update to the place it already files (the press's re-arm): manual too", async () => {
    const { key, apply, read } = await world("seeded-from-sent");
    await apply({ op: "update", key, set: { destination: "ohmail/News" }, applyRetro: true, retroAsked: true });
    const r = await read();
    expect(r.destination).toBe("ohmail/News");
    expect(r.provenance).toBe("manual");
  });

  it("an edit that names no place leaves an inferred rule inferred (the positive control)", async () => {
    const { key, apply, read } = await world();
    await apply({ op: "update", key, set: { priority: 3 }, applyRetro: false, retroAsked: false });
    const r = await read();
    expect(r.priority).toBe(3);
    expect(r.provenance).toBe("promoted");
  });

  it("create on the existing key: the inferred twin becomes manual once, and a replay writes nothing", async () => {
    const { key, apply, read } = await world();
    const res = await apply({ op: "create", key, destination: "INBOX", priority: 0, enabled: true, applyRetro: true });
    expect(res).toMatchObject({ applied: true, op: "update" });
    const first = await read();
    expect(first.destination).toBe("INBOX");
    expect(first.provenance).toBe("manual");
    await apply({ op: "create", key, destination: "INBOX", priority: 0, enabled: true, applyRetro: true }, LATER);
    const second = await read();
    expect(second.updatedAt, "an identical replay rewrote the row").toEqual(first.updatedAt);
  });
});
