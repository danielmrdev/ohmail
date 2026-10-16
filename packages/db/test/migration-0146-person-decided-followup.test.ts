import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { asc, sql } from "drizzle-orm";
import {
  contacts as pgContacts, graduations as pgGraduations, learningSignals as pgSignals, rules as pgRules,
} from "../src/schema-mail.js";
import {
  contacts as liteContacts, graduations as liteGraduations, learningSignals as liteSignals, rules as liteRules,
} from "../src/schema-mail-sqlite.js";
import { makeTestDb, TEST_DIALECT_ENV } from "../src/testing.js";
import { dialect } from "../src/dialect/index.js";

/**
 * MAIL 0146 ON SEEDED HISTORY, on whichever store the project runs, with the store's own file. Arm
 * I: an allow an older settings copy brought in after 0144 ran (promoted, unstamped, no trail here)
 * is stamped where the store has the sender as a contact, and stays `promoted`. Arm D: the allow's
 * own INBOX row created after the person's spam or screen-out decision on the sender's whole domain
 * becomes `manual` and stamped. The act's rows, learned rows, screen-outs and another account's
 * history stay as they were, and a second application changes nothing.
 */
const ON_SQLITE = process.env[TEST_DIALECT_ENV] === "sqlite";
const rules = (ON_SQLITE ? liteRules : pgRules) as unknown as typeof pgRules;
const contacts = (ON_SQLITE ? liteContacts : pgContacts) as unknown as typeof pgContacts;
const learningSignals = (ON_SQLITE ? liteSignals : pgSignals) as unknown as typeof pgSignals;
const graduations = (ON_SQLITE ? liteGraduations : pgGraduations) as unknown as typeof pgGraduations;
const FILE = ON_SQLITE
  ? "../../db-mail/drizzle-sqlite/0146_rule_person_decided_followup.sql"
  : "../../db-mail/drizzle/0146_rule_person_decided_followup.sql";
const STATEMENTS = readFileSync(fileURLToPath(new URL(FILE, import.meta.url)), "utf8")
  .split("--> statement-breakpoint").map((s) => s.replace(/^\s*--[^\n]*$/gm, "").trim()).filter(Boolean);
const CREATED = new Date("2026-06-01T10:00:00.000Z");
const ADMIT = new Date("2026-09-10T10:00:00.000Z");
const OUT = new Date("2026-09-20T10:00:00.000Z");
const ALLOW = new Date("2026-09-21T10:00:00.000Z");

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function rule(db: Db, accountId: string, match: string, destination: string, more: Partial<typeof pgRules.$inferInsert> = {}) {
  await db.insert(rules).values({ accountId, kind: "sender", match, destination, provenance: "promoted", enabled: true, createdAt: CREATED, ...more });
}
const contact = (db: Db, accountId: string, address: string) => db.insert(contacts).values({ accountId, address });
async function signal(db: Db, accountId: string, sender: string, destination: string, by: "person" | "act", createdAt: Date = CREATED) {
  await db.insert(learningSignals).values({
    accountId, triggeringActionId: `${by === "act" ? "screener:auto:" : "screener:"}${randomUUID()}`, kind: "screener",
    senderAddress: sender, destination, label: "positive", createdAt,
  });
}
/** A Screener decision on a whole domain, as shipped: a domain rule and a signal with no sender address. */
async function domainDecision(db: Db, accountId: string, domain: string, destination: string, by: "person" | "act", at: Date) {
  await db.insert(rules).values({ accountId, kind: "domain", match: domain, destination, provenance: "promoted", enabled: true, createdAt: at });
  await db.insert(learningSignals).values({
    accountId, triggeringActionId: `${by === "act" ? "screener:auto:" : "screener:"}${randomUUID()}`, kind: "screener",
    senderAddress: null, senderDomain: domain, destination, label: "positive", createdAt: at,
  });
}
async function graduation(db: Db, accountId: string, patternKey: string, graduatedAt: Date | null, graduated = graduatedAt !== null) {
  await db.insert(graduations).values({ accountId, patternKey, action: "route", positives: 3, negatives: 0, graduated, graduatedAt });
}

async function seeded() {
  const db = await makeTestDb();
  const a = randomUUID();
  const b = randomUUID();
  // ── ARM I: rules an older copy brought in after 0144 ran; the store's contact is the copy's Screener entry.
  for (const [match, destination] of [["imported@x.test", "INBOX"], ["news@x.test", "ohmail/News"],
    ["reads@x.test", "ohmail/Reads"], ["receipts@x.test", "ohmail/Receipts"]] as const) {
    await rule(db, a, match, destination);
    await contact(db, a, match);
  }
  await rule(db, a, " Padded@X.test ", "INBOX");                  // padded and cased, keyed as every reader keys it
  await contact(db, a, "padded@x.test");
  await rule(db, a, "counter@x.test", "INBOX");                   // a counter that never graduated is no trail
  await contact(db, a, "counter@x.test");
  await graduation(db, a, "sender:counter@x.test→INBOX", null);
  // Its controls: each keeps the row ohmail's, or a person's already.
  await rule(db, a, "nocontact@x.test", "INBOX");                 // no contact here
  await rule(db, a, "act@x.test", "INBOX");                       // the act's admit
  await contact(db, a, "act@x.test");
  await signal(db, a, "act@x.test", "INBOX", "act");
  await rule(db, a, "actnews@x.test", "ohmail/News");             // the act's admit into News: ANY signal counts
  await contact(db, a, "actnews@x.test");
  await signal(db, a, "actnews@x.test", "ohmail/News", "act");
  await rule(db, a, "learned@x.test", "INBOX");                   // a graduated route for the key, in another place
  await contact(db, a, "learned@x.test");
  await graduation(db, a, "sender:learned@x.test→ohmail/Receipts", CREATED);
  await rule(db, a, "demoted@x.test", "INBOX");                   // a demoted route keeps its graduated_at
  await contact(db, a, "demoted@x.test");
  await graduation(db, a, "sender:demoted@x.test→INBOX", CREATED, false);
  await rule(db, a, "out@x.test", "ohmail/Quarantine");           // a screen-out: no stamp, it licenses unsubscribing
  await contact(db, a, "out@x.test");
  await rule(db, a, "termed@x.test", "INBOX", { subjectContains: "invoice" });
  await contact(db, a, "termed@x.test");
  await rule(db, a, "manual@x.test", "INBOX", { provenance: "manual" });
  await contact(db, a, "manual@x.test");
  await rule(db, b, "imported@x.test", "INBOX");                  // another account: a's contact is not b's
  // ── ARM D: the person decided on the whole domain; the allow wrote its own INBOX row (and its contact).
  await graduation(db, a, "sender:x@learned.test→INBOX", ADMIT);   // ohmail had learned the sender
  await domainDecision(db, a, "learned.test", "ohmail/Quarantine", "person", OUT);
  await rule(db, a, "x@learned.test", "INBOX", { createdAt: ALLOW });
  await contact(db, a, "x@learned.test");
  await rule(db, a, "x@act.test", "ohmail/Quarantine", { enabled: false, createdAt: ADMIT }); // the act had admitted it
  await signal(db, a, "x@act.test", "INBOX", "act", ADMIT);
  await domainDecision(db, a, "act.test", "ohmail/Quarantine", "person", OUT);
  await rule(db, a, "x@act.test", "INBOX", { createdAt: ALLOW });
  await contact(db, a, "x@act.test");
  await graduation(db, a, "sender:x@screened.test→INBOX", ADMIT);  // a screen-out of the domain counts the same
  await domainDecision(db, a, "screened.test", "ohmail/Screened", "person", OUT);
  await rule(db, a, "x@screened.test", "INBOX", { createdAt: ALLOW });
  // Its controls, one domain each so no history reads another's decision.
  await graduation(db, a, "sender:x@before.test→INBOX", ADMIT);    // ohmail's own row, created before the decision
  await rule(db, a, "x@before.test", "INBOX", { createdAt: ADMIT });
  await domainDecision(db, a, "before.test", "ohmail/Quarantine", "person", OUT);
  await graduation(db, a, "sender:x@at.test→INBOX", ADMIT);        // a row created at the decision's instant
  await domainDecision(db, a, "at.test", "ohmail/Quarantine", "person", OUT);
  await rule(db, a, "x@at.test", "INBOX", { createdAt: OUT });
  await domainDecision(db, a, "readmit.test", "ohmail/Quarantine", "person", OUT); // the act's admit after it
  await signal(db, a, "x@readmit.test", "INBOX", "act", ALLOW);
  await rule(db, a, "x@readmit.test", "INBOX", { createdAt: ALLOW });
  await domainDecision(db, a, "relearned.test", "ohmail/Quarantine", "person", OUT); // a graduation after it
  await graduation(db, a, "sender:x@relearned.test→INBOX", ALLOW);
  await rule(db, a, "x@relearned.test", "INBOX", { createdAt: ALLOW });
  await graduation(db, a, "sender:x@actspam.test→INBOX", ADMIT);   // the act's decision on the domain, not the person's
  await domainDecision(db, a, "actspam.test", "ohmail/Quarantine", "act", OUT);
  await rule(db, a, "x@actspam.test", "INBOX", { createdAt: ALLOW });
  await graduation(db, a, "sender:x@other.test→INBOX", ADMIT);     // a decision on another domain
  await domainDecision(db, a, "elsewhere.test", "ohmail/Quarantine", "person", OUT);
  await rule(db, a, "x@other.test", "INBOX", { createdAt: ALLOW });
  await graduation(db, b, "sender:x@learned.test→INBOX", ADMIT);   // another account: a's decision is not b's
  await rule(db, b, "x@learned.test", "INBOX", { createdAt: ALLOW });
  return { db, a, b };
}

async function snapshot(db: Db) {
  return (await db.select({
    accountId: rules.accountId, kind: rules.kind, match: rules.match, destination: rules.destination,
    provenance: rules.provenance, stamp: rules.personDecidedAt,
  }).from(rules).orderBy(asc(rules.accountId), asc(rules.kind), asc(rules.match), asc(rules.destination)))
    .map((r) => ({ ...r, stamp: r.stamp === null ? null : new Date(r.stamp).toISOString() }));
}

async function run(db: Db): Promise<void> {
  const d = dialect(db);
  for (const s of STATEMENTS) await d.exec(db, sql.raw(s));
}

describe("mail 0146: the person's decisions 0144 left unstamped", () => {
  it("carries arm I, then arm D, and nothing else", () => {
    expect(STATEMENTS).toHaveLength(2);
    expect(STATEMENTS[0]).toMatch(/^UPDATE "rules" SET "person_decided_at" = "created_at"\s+WHERE "kind" = 'sender'/);
    expect(STATEMENTS[1]).toMatch(/^UPDATE "rules" SET "provenance" = 'manual', "person_decided_at" = "rules"\."created_at"\s+FROM/);
    // The places each arm stamps, exactly: an admitting place, never a screen-out.
    expect(STATEMENTS[0]).toContain(`"destination" IN ('INBOX', 'ohmail/News', 'ohmail/Reads', 'ohmail/Receipts')`);
    expect(STATEMENTS[1]).toContain(`"rules"."destination" = 'INBOX'`);
  });

  it("stamps both arms and leaves every control as it was", async () => {
    const { db, a, b } = await seeded();
    await run(db);
    const all = await snapshot(db);
    const of = (account: string, match: string) => all.filter((r) => r.accountId === account && r.kind === "sender" && r.match === match)
      .map((r) => [r.destination, r.provenance, r.stamp]);
    const at = CREATED.toISOString();
    const allowAt = ALLOW.toISOString();
    for (const [match, destination] of [["imported@x.test", "INBOX"], ["news@x.test", "ohmail/News"],
      ["reads@x.test", "ohmail/Reads"], ["receipts@x.test", "ohmail/Receipts"], [" Padded@X.test ", "INBOX"],
      ["counter@x.test", "INBOX"]] as const) {
      expect(of(a, match), `arm I: ${match}`).toEqual([[destination, "promoted", at]]);
    }
    expect(of(a, "nocontact@x.test"), "no contact here").toEqual([["INBOX", "promoted", null]]);
    expect(of(a, "act@x.test"), "the act's admit").toEqual([["INBOX", "promoted", null]]);
    expect(of(a, "actnews@x.test"), "the act's admit into News").toEqual([["ohmail/News", "promoted", null]]);
    expect(of(a, "learned@x.test"), "a graduated route for the key").toEqual([["INBOX", "promoted", null]]);
    expect(of(a, "demoted@x.test"), "a demoted route").toEqual([["INBOX", "promoted", null]]);
    expect(of(a, "out@x.test"), "a screen-out").toEqual([["ohmail/Quarantine", "promoted", null]]);
    expect(of(a, "termed@x.test")).toEqual([["INBOX", "promoted", null]]);
    expect(of(a, "manual@x.test")).toEqual([["INBOX", "manual", null]]);
    expect(of(b, "imported@x.test"), "another account's contact decided this one").toEqual([["INBOX", "promoted", null]]);
    expect(of(a, "x@learned.test"), "arm D over a learned admit").toEqual([["INBOX", "manual", allowAt]]);
    expect(of(a, "x@act.test"), "arm D over the act's old admit").toEqual([["INBOX", "manual", allowAt], ["ohmail/Quarantine", "promoted", null]]);
    expect(of(a, "x@screened.test"), "arm D after a screen-out of the domain").toEqual([["INBOX", "manual", allowAt]]);
    expect(of(a, "x@before.test"), "a row created before the decision").toEqual([["INBOX", "promoted", null]]);
    expect(of(a, "x@at.test"), "a row created at the decision's instant").toEqual([["INBOX", "promoted", null]]);
    expect(of(a, "x@readmit.test"), "the act's admit after the decision").toEqual([["INBOX", "promoted", null]]);
    expect(of(a, "x@relearned.test"), "a graduation after the decision").toEqual([["INBOX", "promoted", null]]);
    expect(of(a, "x@actspam.test"), "the act's decision on the domain").toEqual([["INBOX", "promoted", null]]);
    expect(of(a, "x@other.test"), "a decision on another domain").toEqual([["INBOX", "promoted", null]]);
    expect(of(b, "x@learned.test"), "another account's decision decided this one").toEqual([["INBOX", "promoted", null]]);
    expect(all.filter((r) => r.kind === "domain").every((r) => r.stamp === null && r.provenance === "promoted"), "a domain rule moved").toBe(true);
  });

  it("a second application changes nothing (the desktop replays the journal)", async () => {
    const { db } = await seeded();
    await run(db);
    const once = await snapshot(db);
    await run(db);
    expect(await snapshot(db)).toEqual(once);
    expect(once.filter((r) => r.provenance === "manual" && r.stamp !== null)).toHaveLength(3);
    expect(once.filter((r) => r.provenance === "promoted" && r.stamp !== null)).toHaveLength(6);
  });
});
