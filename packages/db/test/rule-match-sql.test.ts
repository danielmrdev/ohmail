import { describe, expect, it } from "vitest";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import { sql } from "drizzle-orm";
import {
  ruleMatchKey, SHARED_PROVIDER_DOMAINS as CORE_SHARED, sharedProviderAllowRefusal as coreRefusal,
} from "@trafficflow/core/rule-order";
import { rules as pgRules } from "../src/schema-mail.js";
import { rules as deviceRules } from "../src/schema-mail-sqlite.js";
import { makeTestDb, TEST_DIALECT_ENV } from "../src/testing.js";
import { dialect, dialectOf } from "../src/dialect/index.js";
import {
  ruleMatchKeySql, ruleNamesSenderSql, SHARED_PROVIDER_DOMAINS, sharedProviderAllowRefusal,
} from "../src/rule-match-sql.js";

/**
 * THE SQL KEY IS THE ROUTER'S KEY, ON BOTH STORES. `ruleMatchKey` trims spaces and nothing else;
 * the builder every SQL reader takes must answer the same for every match a row can hold, or a
 * padded rule decides a sender on one reader and nobody on the next. Run by both projects.
 */
const ON_SQLITE = process.env[TEST_DIALECT_ENV] === "sqlite";
const rules = (ON_SQLITE ? deviceRules : pgRules) as unknown as typeof pgRules;
const ACCOUNT = "11111111-2222-3333-4444-5555555555aa";
const SENDER = "anna@x.test";

/** Every shape a stored match can take, with the rule kind it is stored under. */
const ROWS: ReadonlyArray<readonly [string, string]> = [
  ["sender", SENDER], ["sender", ` ${SENDER}  `], ["sender", "ANNA@X.test"], ["sender", `\t${SENDER}`],
  ["sender", `${SENDER}\n`], ["sender", "other@x.test"], ["domain", "x.test"], ["domain", "  X.TEST "],
  ["domain", "\tx.test"], ["domain", "y.test"], ["header", SENDER],
];

describe("ruleMatchKeySql and ruleNamesSenderSql, on whichever store the project runs", () => {
  it("the SQL key of every stored shape equals ruleMatchKey's", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    for (const [, match] of ROWS) {
      const [row] = await d.exec(db, sql`select ${ruleMatchKeySql(sql`${match}`)}`);
      expect(String(row![0]), `${JSON.stringify(match)} on ${dialectOf(db)}`).toBe(ruleMatchKey(match));
    }
  });

  it("names the sender by space-padded and cased rules, never by a tab or a newline", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    for (const [kind, match] of ROWS) {
      await db.insert(rules).values({
        accountId: ACCOUNT, kind, match, destination: "INBOX", enabled: true, priority: 0, provenance: "manual",
      } as never);
    }
    const found = await d.exec(db, sql`
      select r.kind, r.match from rules r
       where r.account_id = ${d.castUuid(ACCOUNT)}
         and ${ruleNamesSenderSql(d, { kind: sql`r.kind`, match: sql`r.match`, destination: sql`r.destination` }, sql`lower(${SENDER})`)}`);
    const named = found.map((r) => `${String(r[0])}:${JSON.stringify(String(r[1]))}`).sort();
    expect(named).toEqual([
      `domain:${JSON.stringify("  X.TEST ")}`, `domain:${JSON.stringify("x.test")}`,
      `sender:${JSON.stringify(` ${SENDER}  `)}`, `sender:${JSON.stringify("ANNA@X.test")}`,
      `sender:${JSON.stringify(SENDER)}`,
    ].sort());
    // …which is the router's answer, row by row.
    const router = ROWS.filter(([kind, match]) =>
      (kind === "sender" && ruleMatchKey(match) === SENDER) || (kind === "domain" && ruleMatchKey(match) === "x.test"))
      .map(([kind, match]) => `${kind}:${JSON.stringify(match)}`).sort();
    expect(named).toEqual(router);
  });
});

describe("the shared-provider twin (mail 0148): one list, one question, in SQL as in core", () => {
  it("the pinned list is core's list, entry for entry", () => {
    expect([...SHARED_PROVIDER_DOMAINS].sort()).toEqual([...CORE_SHARED].sort());
  });

  it("the db predicate answers as core's for every kind, side and spelling", () => {
    const cases = [
      ["domain", "gmail.com", "INBOX"], ["domain", " GMAIL.com ", "ohmail/News"], ["domain", "gmail.com", "ohmail/Screened"],
      ["domain", "gmail.com", "ohmail/Quarantine"], ["domain", "firma.example", "INBOX"], ["sender", personalAt("fixture.reto", "gmail.com"), "INBOX"],
      ["header", "list-id", "INBOX"], ["domain", "bluewin.ch", "ohmail/Receipts"], ["domain", "gmail.com", "ohmail/Screener"],
    ] as const;
    for (const [kind, match, destination] of cases) {
      expect(sharedProviderAllowRefusal({ kind, match, destination }), `${kind} ${match} ${destination}`)
        .toBe(coreRefusal({ kind, match, destination }));
    }
    // …and it reads `effect` as core does: a deny names everyone, whatever the destination says.
    for (const [destination, effect] of [["INBOX", "deny"], ["INBOX", "allow"], ["ohmail/Screened", "allow"]] as const) {
      const r = { kind: "domain", match: "gmail.com", destination, effect };
      expect(sharedProviderAllowRefusal(r), `${destination} ${effect}`).toBe(coreRefusal(r));
    }
    expect(sharedProviderAllowRefusal({ kind: "domain", match: "gmail.com", destination: "INBOX", effect: "deny" })).toBeNull();
  });

  it("in SQL an allow rule at gmail.com names nobody there, a deny names everyone, a firm's allow names its people", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    const account = "11111111-2222-3333-4444-5555555555bb";
    const rows: ReadonlyArray<readonly [string, string]> = [
      ["gmail.com", "INBOX"], ["gmail.com", "ohmail/Screened"], ["firma.test", "INBOX"],
    ];
    for (const [match, destination] of rows) {
      await db.insert(rules).values({
        accountId: account, kind: "domain", match, destination, enabled: true, priority: 0, provenance: "manual",
      } as never);
    }
    const naming = async (sender: string) => (await d.exec(db, sql`
      select r.match, r.destination from rules r
       where r.account_id = ${d.castUuid(account)}
         and ${ruleNamesSenderSql(d, { kind: sql`r.kind`, match: sql`r.match`, destination: sql`r.destination` }, sql`lower(${sender})`)}`))
      .map((r) => `${String(r[0])}>${String(r[1])}`).sort();
    expect(await naming(personalAt("fixture.nadja", "gmail.com"))).toEqual(["gmail.com>ohmail/Screened"]);
    expect(await naming("anna@firma.test")).toEqual(["firma.test>INBOX"]);
  });
});

