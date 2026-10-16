import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { applyRuleRequest, type ValidatedRuleRequest } from "../src/request-apply.js";
import { accounts, rules } from "../src/schema-mail.js";
import type { LedgerTx, Tx } from "../src/change-log.js";

/**
 * The organizer applies a travelled rule request by PLACE, not spelling: a rule stored before the
 * News rename says `ohmail/Reads`, and a request naming News (the word `reads` maps there) is the
 * same place — the row keeps its spelling and no backlog walk re-arms. A move elsewhere still does.
 */

const DONE = new Date("2026-09-25T09:00:00.000Z");
const NOW = new Date("2026-09-25T12:00:00.000Z");

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `rrkp-${accountId.slice(0, 8)}` });
  const key = { kind: "sender" as const, match: `${randomUUID()}@digest.example`, subjectContains: null, bodyContains: null };
  await db.insert(rules).values({
    accountId, kind: key.kind, match: key.match, destination: "ohmail/Reads", priority: 0, enabled: true,
    provenance: "manual", retroRequestedAt: DONE, retroDoneAt: DONE, retroMoved: 7,
  });
  const apply = (payload: ValidatedRuleRequest) => (db as unknown as Tx).transaction((tx) =>
    applyRuleRequest(tx as unknown as LedgerTx, { accountId, payload, now: NOW }));
  const read = async () => (await db.select().from(rules)
    .where(and(eq(rules.accountId, accountId), eq(rules.match, key.match))))[0]!;
  return { key, apply, read };
}

describe("a travelled rule request compares the place, not the spelling", () => {
  it("update: News for a rule stored as Reads keeps Reads and re-arms nothing", async () => {
    const { key, apply, read } = await world();
    const res = await apply({ op: "update", key, set: { destination: "ohmail/News" }, applyRetro: true, retroAsked: false });
    expect(res.applied).toBe(true);
    const r = await read();
    expect.soft(r.destination).toBe("ohmail/Reads");
    expect.soft(r.retroDoneAt, "a same-place request re-walked the backlog").toEqual(DONE);
  });

  it("update: an explicit ask re-arms the same place and keeps Reads", async () => {
    const { key, apply, read } = await world();
    await apply({ op: "update", key, set: { destination: "ohmail/News" }, applyRetro: true, retroAsked: true });
    const r = await read();
    expect(r.destination).toBe("ohmail/Reads");
    expect(r.retroRequestedAt).toEqual(NOW);
    expect(r.retroDoneAt).toBeNull();
  });

  it("create on the existing key: News for a Reads rule writes nothing", async () => {
    const { key, apply, read } = await world();
    const res = await apply({ op: "create", key, destination: "ohmail/News", priority: 0, enabled: true, applyRetro: true });
    expect(res).toMatchObject({ applied: true, op: "unchanged", lastSeq: null });
    const r = await read();
    expect.soft(r.destination).toBe("ohmail/Reads");
    expect.soft(r.retroDoneAt).toEqual(DONE);
  });

  it("update: a move to another place still retargets (control)", async () => {
    const { key, apply, read } = await world();
    await apply({ op: "update", key, set: { destination: "ohmail/Receipts" }, applyRetro: true, retroAsked: false });
    const r = await read();
    expect(r.destination).toBe("ohmail/Receipts");
    expect(r.retroRequestedAt).toEqual(NOW);
    expect(r.retroDoneAt).toBeNull();
  });
});
