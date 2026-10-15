import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { graduations as pgGraduations, learningSignals as pgSignals, rules as pgRules } from "../src/schema-mail.js";
import {
  graduations as liteGraduations, learningSignals as liteSignals, rules as liteRules,
} from "../src/schema-mail-sqlite.js";
import { makeTestDb, TEST_DIALECT_ENV } from "../src/testing.js";
import { dialect } from "../src/dialect/index.js";

/**
 * MAIL 0144 ON SEEDED HISTORY, on whichever store the project runs, with the store's own file. A
 * pre-K97 "always allow" (class C) becomes `manual` and stamped, also where ohmail had once let the
 * sender in, if the allow's row came after the person's newest spam decision; a person's pre-0128
 * Screener press into an admitting place (class A) is stamped and stays `promoted`. The act's rows,
 * a learned promotion or retarget, screen-outs and another account's history stay as they were.
 */
const ON_SQLITE = process.env[TEST_DIALECT_ENV] === "sqlite";
const rules = (ON_SQLITE ? liteRules : pgRules) as unknown as typeof pgRules;
const learningSignals = (ON_SQLITE ? liteSignals : pgSignals) as unknown as typeof pgSignals;
const graduations = (ON_SQLITE ? liteGraduations : pgGraduations) as unknown as typeof pgGraduations;
const FILE = ON_SQLITE
  ? "../../db-mail/drizzle-sqlite/0144_rule_person_decided_backfill.sql"
  : "../../db-mail/drizzle/0144_rule_person_decided_backfill.sql";
const STATEMENTS = readFileSync(fileURLToPath(new URL(FILE, import.meta.url)), "utf8")
  .split("--> statement-breakpoint").map((s) => s.replace(/^\s*--[^\n]*$/gm, "").trim()).filter(Boolean);
const CREATED = new Date("2026-06-01T10:00:00.000Z");

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function rule(db: Db, accountId: string, match: string, destination: string, more: Partial<typeof pgRules.$inferInsert> = {}) {
  await db.insert(rules).values({ accountId, kind: "sender", match, destination, provenance: "promoted", enabled: true, createdAt: CREATED, ...more });
}
async function signal(db: Db, accountId: string, sender: string, destination: string, by: "person" | "act", createdAt?: Date) {
  const id = by === "act" ? `screener:auto:${randomUUID()}` : `screener:${randomUUID()}`;
  await db.insert(learningSignals).values({
    accountId, triggeringActionId: id, kind: "screener", senderAddress: sender, destination, label: "positive",
    ...(createdAt ? { createdAt } : {}),
  });
}
/** The person's pre-0128 spam decision, as shipped: its Quarantine row, then its signal, one instant. */
async function personSpam(db: Db, accountId: string, sender: string) {
  await rule(db, accountId, sender, "ohmail/Quarantine", { enabled: false, createdAt: OUT });
  await signal(db, accountId, sender, "ohmail/Quarantine", "person", OUT);
}
const ADMIT = new Date("2026-09-10T10:00:00.000Z");
const OUT = new Date("2026-09-20T10:00:00.000Z");
const ALLOW = new Date("2026-09-21T10:00:00.000Z");

async function seeded() {
  const db = await makeTestDb();
  const a = randomUUID();
  const b = randomUUID();
  await rule(db, a, "allow@x.test", "INBOX");                     // C: a legacy always-allow
  await rule(db, a, " Padded@X.test ", "INBOX");                  // C: padded and cased
  await rule(db, a, "act@x.test", "INBOX");                       // the act's row
  await signal(db, a, "act@x.test", "INBOX", "act");
  await rule(db, a, "learned@x.test", "INBOX");                   // a promotion with its trail
  await db.insert(graduations).values({ accountId: a, patternKey: "sender:learned@x.test→INBOX", action: "route", positives: 3, negatives: 0, graduated: true, graduatedAt: CREATED });
  await rule(db, a, "pressed@x.test", "ohmail/Reads");            // A: a person's press, old spelling
  await signal(db, a, "pressed@x.test", "ohmail/News", "person");
  await rule(db, a, "actnews@x.test", "ohmail/News");             // the act's admit, untouched
  await signal(db, a, "actnews@x.test", "ohmail/News", "act");
  await rule(db, a, "out@x.test", "ohmail/Screened");             // a person's screen-out: no stamp
  await signal(db, a, "out@x.test", "ohmail/Screened", "person");
  await rule(db, a, "moved@x.test", "ohmail/Receipts");           // a press into another place
  await signal(db, a, "moved@x.test", "ohmail/News", "person");
  await rule(db, a, "stamped@x.test", "INBOX", { personDecidedAt: CREATED });
  await rule(db, a, "termed@x.test", "INBOX", { subjectContains: "invoice" });
  await db.insert(rules).values({ accountId: a, kind: "domain", match: "x.test", destination: "INBOX", provenance: "promoted", enabled: true, createdAt: CREATED });
  await rule(db, b, "act@x.test", "INBOX");                       // C in another account: a's signal is not b's
  // THE TWO SHIPPED ALLOW SHAPES the history had: the spam rule the allow switched off beside the
  // INBOX row it inserted, and a screen-out the allow converged onto (the act's and a person's).
  await rule(db, a, "spam@x.test", "ohmail/Quarantine", { enabled: false });
  await signal(db, a, "spam@x.test", "ohmail/Quarantine", "person");
  await rule(db, a, "spam@x.test", "INBOX");
  await rule(db, a, "actout@x.test", "INBOX");
  await signal(db, a, "actout@x.test", "ohmail/Screened", "act");
  await rule(db, a, "personout@x.test", "INBOX");
  await signal(db, a, "personout@x.test", "ohmail/Screened", "person");
  // HIGH-1'S REMAINDER: ohmail had once let the sender in (the act, or a graduation), the person
  // marked it spam (its row and ohmail's moved to Quarantine), and the allow wrote its own row.
  await rule(db, a, "actadmit@x.test", "ohmail/Quarantine", { enabled: false, createdAt: ADMIT });
  await signal(db, a, "actadmit@x.test", "INBOX", "act", ADMIT);
  await personSpam(db, a, "actadmit@x.test");
  await rule(db, a, "actadmit@x.test", "INBOX", { createdAt: ALLOW });
  await rule(db, a, "learnedadmit@x.test", "ohmail/Quarantine", { enabled: false, createdAt: ADMIT });
  await db.insert(graduations).values({ accountId: a, patternKey: "sender:learnedadmit@x.test→INBOX", action: "route", positives: 3, negatives: 0, graduated: true, graduatedAt: ADMIT });
  await personSpam(db, a, "learnedadmit@x.test");
  await rule(db, a, "learnedadmit@x.test", "INBOX", { createdAt: ALLOW });
  // Its controls: a learned retarget of the person's spam row keeps that row's creation, the
  // instant of the spam signal; and the act's admit AFTER the person's spam is the act's row.
  await db.insert(graduations).values({ accountId: a, patternKey: "sender:retarget@x.test→INBOX", action: "route", positives: 3, negatives: 0, graduated: true, graduatedAt: ADMIT });
  await signal(db, a, "retarget@x.test", "ohmail/Quarantine", "person", OUT);
  await rule(db, a, "retarget@x.test", "INBOX", { createdAt: OUT });
  await personSpam(db, a, "readmit@x.test");
  await signal(db, a, "readmit@x.test", "INBOX", "act", ALLOW);
  await rule(db, a, "readmit@x.test", "INBOX", { createdAt: ALLOW });
  await personSpam(db, a, "relearned@x.test");                    // ...and so is a graduation after it
  await db.insert(graduations).values({ accountId: a, patternKey: "sender:relearned@x.test→INBOX", action: "route", positives: 3, negatives: 0, graduated: true, graduatedAt: ALLOW });
  await rule(db, a, "relearned@x.test", "INBOX", { createdAt: ALLOW });
  return { db, a, b };
}

async function snapshot(db: Db) {
  return (await db.select({
    accountId: rules.accountId, kind: rules.kind, match: rules.match, destination: rules.destination,
    provenance: rules.provenance, stamp: rules.personDecidedAt,
  }).from(rules).orderBy(asc(rules.accountId), asc(rules.kind), asc(rules.match)))
    .map((r) => ({ ...r, stamp: r.stamp === null ? null : new Date(r.stamp).toISOString() }));
}

async function run(db: Db): Promise<void> {
  const d = dialect(db);
  for (const s of STATEMENTS) await d.exec(db, sql.raw(s));
}

describe("mail 0144: the person's decisions made before their stamp", () => {
  it("carries class C, its second arm, class A and then the index, in that order", () => {
    expect(STATEMENTS).toHaveLength(4);
    expect(STATEMENTS[0]).toMatch(/SET "provenance" = 'manual', "person_decided_at" = "created_at"/);
    expect(STATEMENTS[1]).toMatch(/SET "provenance" = 'manual'[\s\S]*"rules"\."created_at" > "o"\."last_out"/);
    expect(STATEMENTS[2]).toMatch(/SET "person_decided_at" = "created_at"/);
    expect(STATEMENTS[3]).toMatch(/^CREATE INDEX IF NOT EXISTS "rules_account_key_idx"/);
  });

  it("relabels class C, stamps class A, and leaves every control as it was", async () => {
    const { db, a, b } = await seeded();
    await run(db);
    const by = new Map((await snapshot(db)).map((r) => [`${r.accountId === a ? "a" : "b"}:${r.kind}:${r.match}`, r]));
    const at = CREATED.toISOString();
    const state = (k: string) => { const r = by.get(k)!; return [r.provenance, r.stamp]; };
    expect(state("a:sender:allow@x.test"), "a legacy allow").toEqual(["manual", at]);
    expect(state("a:sender: Padded@X.test "), "a padded legacy allow").toEqual(["manual", at]);
    expect(state("b:sender:act@x.test"), "another account's signal decided this one").toEqual(["manual", at]);
    expect(state("a:sender:pressed@x.test"), "a person's press, News spellings folded").toEqual(["promoted", at]);
    // RISK 5's controls: the act's row and a learned promotion with its trail stay promoted, unstamped.
    expect(state("a:sender:act@x.test"), "the act's row").toEqual(["promoted", null]);
    expect(state("a:sender:learned@x.test"), "a promotion with its trail").toEqual(["promoted", null]);
    expect(state("a:sender:actnews@x.test")).toEqual(["promoted", null]);
    expect(state("a:sender:out@x.test"), "a screen-out was stamped: an unsubscribe licence").toEqual(["promoted", null]);
    expect(state("a:sender:moved@x.test")).toEqual(["promoted", null]);
    expect(state("a:sender:stamped@x.test")).toEqual(["promoted", at]);
    expect(state("a:sender:termed@x.test")).toEqual(["promoted", null]);
    expect(state("a:domain:x.test")).toEqual(["promoted", null]);
    // The shipped shapes: a decision into Quarantine or Screened is the history the allow overrode.
    const spam = (await snapshot(db)).filter((r) => r.accountId === a && r.match === "spam@x.test");
    expect(spam.map((r) => [r.destination, r.provenance, r.stamp]).sort(), "the allow beside the spam rule it switched off")
      .toEqual([["INBOX", "manual", at], ["ohmail/Quarantine", "promoted", null]]);
    expect(state("a:sender:actout@x.test"), "an allow over the act's screen-out").toEqual(["manual", at]);
    expect(state("a:sender:personout@x.test"), "an allow over a person's screen-out").toEqual(["manual", at]);
    // HIGH-1's remainder and its controls, read row by row.
    const rows = async (match: string) => (await snapshot(db)).filter((r) => r.accountId === a && r.match === match)
      .map((r) => [r.destination, r.provenance, r.stamp]).sort();
    const allowAt = ALLOW.toISOString();
    expect(await rows("actadmit@x.test"), "the allow after the person's spam, over the act's old admit").toEqual([
      ["INBOX", "manual", allowAt], ["ohmail/Quarantine", "promoted", null], ["ohmail/Quarantine", "promoted", null]]);
    expect(await rows("learnedadmit@x.test"), "the allow after the person's spam, over a learned admit").toEqual([
      ["INBOX", "manual", allowAt], ["ohmail/Quarantine", "promoted", null], ["ohmail/Quarantine", "promoted", null]]);
    expect(await rows("retarget@x.test"), "a learned retarget of the person's spam row is ohmail's").toEqual([
      ["INBOX", "promoted", null]]);
    expect(await rows("readmit@x.test"), "the act's admit after the person's spam is the act's").toEqual([
      ["INBOX", "promoted", null], ["ohmail/Quarantine", "promoted", null]]);
    expect(await rows("relearned@x.test"), "a graduation after the person's spam is the learning's").toEqual([
      ["INBOX", "promoted", null], ["ohmail/Quarantine", "promoted", null]]);
  });

  it("a second application changes nothing (the desktop replays the journal)", async () => {
    const { db } = await seeded();
    await run(db);
    const once = await snapshot(db);
    await run(db);
    expect(await snapshot(db)).toEqual(once);
    const stamped = await db.select({ id: rules.id }).from(rules).where(eq(rules.provenance, "manual"));
    expect(stamped).toHaveLength(8);
  });
});
