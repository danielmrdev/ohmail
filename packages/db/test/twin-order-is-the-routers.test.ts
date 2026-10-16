import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { compareTwins, effectForDestination } from "@trafficflow/core/rule-order";
import { makeTestDb } from "../src/testing.js";
import { applyRuleRequest, validateRulePayload, type ValidatedRuleRequest } from "../src/request-apply.js";
import { accounts, rules } from "../src/schema-mail.js";
import type { LedgerTx, Tx } from "../src/change-log.js";

/**
 * THE ORGANIZER'S ACTING TWIN IS THE ONE THE ROUTER RUNS (REVIEW-026 H3). `findRulesByKey` states
 * core's `compareTwins` in SQL — on before paused, then the router's order — and this file holds
 * the two to one answer over a matrix, plus the presses the review measured.
 */
const NOW = new Date("2026-10-02T12:00:00.000Z");
type Seed = { match: string; destination: string; priority: number; enabled: boolean; provenance?: string };

async function world(seeds: Seed[]) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `tw-${accountId.slice(0, 8)}` });
  const rows: Array<Seed & { id: string }> = [];
  for (const r of seeds) {
    const [row] = await db.insert(rules).values({
      accountId, kind: "sender", match: r.match, destination: r.destination, priority: r.priority,
      enabled: r.enabled, provenance: r.provenance ?? "manual",
    }).returning({ id: rules.id });
    rows.push({ ...r, id: row!.id });
  }
  const apply = (payload: ValidatedRuleRequest) => (db as unknown as Tx).transaction((tx) =>
    applyRuleRequest(tx as unknown as LedgerTx, { accountId, payload, now: NOW }));
  const left = async () => db.select({ id: rules.id }).from(rules).where(eq(rules.accountId, accountId));
  return { rows, apply, left };
}

/** The twin core's order picks: what the Rules page shows and the router runs. */
const coreActing = (rows: Array<Seed & { id: string }>) => [...rows].sort((a, b) => compareTwins(
  { ...a, kind: "sender", effect: effectForDestination(a.destination), provenance: a.provenance ?? "manual" },
  { ...b, kind: "sender", effect: effectForDestination(b.destination), provenance: b.provenance ?? "manual" },
))[0]!.id;

const MATRIX: Array<{ name: string; seeds: Seed[] }> = [
  { name: "a paused twin at a higher priority", seeds: [
    { match: "Ann@Shop.example", destination: "ohmail/Receipts", priority: 5, enabled: false },
    { match: "ann@shop.example", destination: "ohmail/News", priority: 0, enabled: true }] },
  { name: "both on, priorities differ", seeds: [
    { match: "ann@shop.example", destination: "ohmail/News", priority: 0, enabled: true },
    { match: " ANN@shop.example", destination: "ohmail/Receipts", priority: 3, enabled: true }] },
  { name: "both on, a screen-out beside an allow at one priority", seeds: [
    { match: "ann@shop.example", destination: "INBOX", priority: 0, enabled: true },
    { match: "Ann@shop.example", destination: "ohmail/Screened", priority: 0, enabled: true }] },
  { name: "both on, provenance decides", seeds: [
    { match: "ann@shop.example", destination: "ohmail/News", priority: 0, enabled: true, provenance: "promoted" },
    { match: "ann@Shop.example", destination: "ohmail/Receipts", priority: 0, enabled: true, provenance: "manual" }] },
  { name: "both paused", seeds: [
    { match: "ann@shop.example", destination: "ohmail/News", priority: 1, enabled: false },
    { match: "Ann@shop.example", destination: "ohmail/Receipts", priority: 0, enabled: false }] },
];

describe("the organizer's acting twin is the one the router runs", () => {
  it.each(MATRIX)("$name: the organizer edits the twin core's order picks", async ({ seeds }) => {
    const w = await world(seeds);
    const r = await w.apply(validateRulePayload("rule.update", {
      key: { kind: "sender", match: "ann@shop.example" }, set: { priority: 9 },
    })!);
    expect(r).toMatchObject({ applied: true, ruleId: coreActing(w.rows) });
  });

  it("a paused twin that sorts first by id is still not the acting one", async () => {
    // Equal priority, effect and provenance: only the id separates them, and the paused row is
    // made to win that comparison in both orders the database may hand out.
    for (const pausedFirst of [true, false]) {
      const seeds: Seed[] = [
        { match: "ann@shop.example", destination: "ohmail/Receipts", priority: 0, enabled: false },
        { match: "Ann@shop.example", destination: "ohmail/News", priority: 0, enabled: true },
      ];
      const w = await world(pausedFirst ? seeds : [...seeds].reverse());
      const on = w.rows.find((x) => x.enabled)!.id;
      const r = await w.apply(validateRulePayload("rule.update", {
        key: { kind: "sender", match: "ann@shop.example" }, set: { destination: "reads" },
      })!);
      expect(r).toMatchObject({ applied: true, ruleId: on });
    }
  });
});
