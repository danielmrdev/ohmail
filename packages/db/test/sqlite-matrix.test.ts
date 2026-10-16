import { describe, it, expect } from "vitest";
import { eq, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
// The barrel, imported EXACTLY as a service imports it — see the substitution test below. Thirty
// eight of the engine's own files reach their tables this way and one reaches them by the subpath
// the design named, so the barrel is the specifier the second run has to answer for.
import { mailboxes as barrelMailboxes, messages as barrelMessages } from "@trafficflow/db";
import { makeTestDb, TEST_DIALECT_ENV } from "../src/testing.js";
import { dialectOf, dialect } from "../src/dialect/index.js";
import { mailboxes as deviceMailboxes, messages as deviceMessages } from "../src/schema-mail-sqlite.js";

/**
 * THE ONE CAST, and it is the substitution this file exists to exercise.
 *
 * `makeTestDb()` hands back a handle typed against the SERVER — that is what every service is
 * typed against, and the whole point of the second run is that neither changes for the other
 * store. The objects here ARE the device twin's; only the TYPES are the server's, so the
 * statements below compile once here rather than at every call site. What the cast cannot prove is
 * object identity, and the substitution case above proves that separately by comparing the barrel's
 * export with the device module's.
 */
const mailboxes = deviceMailboxes as unknown as typeof barrelMailboxes;
const messages = deviceMessages as unknown as typeof barrelMessages;

/**
 * THE FIRST THING THE SECOND RUN CHECKS IS THAT IT IS THE SECOND RUN.
 *
 * The matrix is two runs of the same files, told apart by one environment variable. If that
 * variable is unset — a shell that forgot it, a runner that dropped it, a config that stopped
 * passing it — the second run silently becomes a duplicate of the first and reports green for a
 * store it never opened. Nothing else in the suite can notice, because every other assertion is
 * true on both stores. So this file asserts the dialect itself, and it is the only file allowed
 * to: a test that branches on which store it is running against has stopped checking the thing
 * both stores must do.
 */
const RUNNING_ON_SQLITE = process.env[TEST_DIALECT_ENV] === "sqlite";

/**
 * Set by the second project's config. Read SEPARATELY from the dialect variable, because the two
 * questions are different: "was this run meant to be the SQLite one" and "was it". A guard that
 * asks only the second, under a condition derived from it, cannot fail — it skips.
 */
const MATRIX_EXPECTED = process.env.OHMAIL_EXPECT_DIALECT;

describe("which store this run opened", () => {
  it("is the one the runner asked for, or this run proves nothing", async () => {
    // OUTSIDE any condition derived from the variable under test. Inside `runIf`, an unset
    // variable made this SKIP — reported as a pass — and the second project silently became a
    // duplicate of the first, green for a store it never opened. Every other assertion in the
    // suite is true on both, so nothing else could have noticed.
    // NOT a skip. Both projects declare an expectation, so an absent one means a config lost its
    // `env` block — which is exactly the edit that turns the second run into a copy of the first.
    expect(
      MATRIX_EXPECTED,
      "no run may be without a declared dialect: check the `env` block of the config that started this run",
    ).toBeDefined();
    // An absent variable means the DEFAULT store — that is what "default" is. Which is also why
    // the second run cannot be told apart by this variable alone: unset reads as the first run,
    // exactly as a dropped `env` block would, and only the declared expectation makes the two
    // distinguishable.
    const opened = process.env[TEST_DIALECT_ENV] ?? "pg";
    expect(
      opened,
      `this run was configured to be the ${MATRIX_EXPECTED} run and ${TEST_DIALECT_ENV} says ` +
      `${process.env[TEST_DIALECT_ENV] ?? "nothing"}`,
    ).toBe(MATRIX_EXPECTED);
    const db = await makeTestDb();
    expect(dialectOf(db)).toBe(MATRIX_EXPECTED);
    expect(dialect(db).name).toBe(MATRIX_EXPECTED);
  });
});

/**
 * DOES THE CODE UNDER TEST ACTUALLY SEE THE SECOND STORE'S SCHEMA?
 *
 * Everything else in this file imports the SQLite twin by its own name, so every one of those
 * assertions would hold with the substitution completely absent — and it WAS absent: the second
 * project carried no alias at all, and the design's own sentence names a specifier that exactly
 * one file in forty uses. A run can open the right store and still hand every service the other
 * store's column types, which fails at a query on a device rather than here.
 *
 * So this asks the question through the specifier the services actually write. It belongs in this
 * file because it must know which run it is, and this is the file licensed to know that.
 */
describe("the schema a service imports", () => {
  it("belongs to the store this run opened, not to the one the types were written against", () => {
    const expected = process.env.OHMAIL_EXPECT_DIALECT;
    expect(expected, "this run declared no dialect: check the `env` block of its config").toBeDefined();

    // Asked of the CLASS the query builder dispatches on, because that is what decides how a
    // statement is rendered and how a value is mapped — not a property name a twin could copy.
    const kindOf = (t: unknown): string =>
      is(t, SQLiteTable) ? "sqlite" : is(t, PgTable) ? "pg" : "neither";
    expect(kindOf(barrelMessages),
      `@trafficflow/db handed the ${expected} run a ${kindOf(barrelMessages)} table`).toBe(expected);
    expect(kindOf(barrelMailboxes)).toBe(expected);

    // And it is the SAME OBJECT the store's own module exports, not a second copy of the twin —
    // two module instances would each carry their own column objects, and a value mapper read
    // from one while the statement was built from the other is a difference nothing else shows.
    expect(barrelMailboxes === mailboxes).toBe(expected === "sqlite");
    expect(barrelMessages === messages).toBe(expected === "sqlite");
  });
});

describe.runIf(RUNNING_ON_SQLITE)("the SQLite run is running on SQLite", () => {
  it("has the schema in front of it, migrated, and writes and reads a row back", async () => {
    const db = await makeTestDb();
    const now = new Date("2026-03-04T05:06:07.008Z");
    await db.insert(mailboxes).values({
      id: "mb-1", accountId: "acc-1", provider: "imap", address: "reader@example.test",
      createdAt: now,
    });
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, "mb-1"));
    expect(row?.address).toBe("reader@example.test");
    // The instant survives the round trip as an instant, which is what lets one service read
    // both stores: the storage differs and the value does not.
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.createdAt?.getTime()).toBe(now.getTime());
    // Defaults declared in the schema are applied by the store, not by the caller.
    expect(row?.status).toBe("connected");
    expect(row?.organizerRole).toBe("organizer");
  });

  it("keeps JSON as JSON, and applies the empty default the schema declares", async () => {
    const db = await makeTestDb();
    await db.insert(mailboxes).values({
      id: "mb-2", accountId: "acc-1", provider: "imap", address: "json@example.test",
    });
    await db.insert(messages).values({
      id: "m-1", accountId: "acc-1", mailboxId: "mb-2", bodyHash: "h", dedupKey: "d",
      subject: "hello", fromAddress: "s@example.test",
      toAddresses: ["a@example.test", "b@example.test"],
    });
    const [row] = await db.select().from(messages).where(eq(messages.id, "m-1"));
    expect(row?.toAddresses).toEqual(["a@example.test", "b@example.test"]);
    expect(row?.ccAddresses).toEqual([]);
  });

  it("refuses a value outside a closed set, the way the server's constraint does", async () => {
    const db = await makeTestDb();
    await expect(db.insert(mailboxes).values({
      id: "mb-3", accountId: "acc-1", provider: "imap", address: "bad@example.test",
      organizerRole: "captain" as never,
    })).rejects.toThrow(/CHECK constraint failed/);
  });
});

describe("a construct the seam renders differently, EXECUTED on whichever store this is", () => {
  // Rendering a fragment proves it was composed; only running it proves the store accepts it.
  // This one was composed correctly on both arms and valid SQL on neither — an array handed to
  // the builder as a single parameter renders as a placeholder, so the server saw `?| $1` and
  // refused it. Nothing noticed, because nothing had ever run it.
  it("answers whether a JSON object holds any of these keys", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    const doc = d.name === "pg" ? sql`'{"alpha":1,"beta":2}'::jsonb` : sql`'{"alpha":1,"beta":2}'`;

    const hit = await d.exec(db, sql`select ${d.jsonHasAny(doc, ["beta", "gamma"])} as answer`);
    expect(String(hit[0]?.[0])).toMatch(/^(true|1)$/);

    const miss = await d.exec(db, sql`select ${d.jsonHasAny(doc, ["gamma"])} as answer`);
    expect(String(miss[0]?.[0])).toMatch(/^(false|0)$/);

    // An empty list asks nothing and must answer no, rather than composing `IN ()`.
    const none = await d.exec(db, sql`select ${d.jsonHasAny(doc, [])} as answer`);
    expect(String(none[0]?.[0])).toMatch(/^(false|0)$/);
  });
});

/**
 * THE THREE MEMBERS WHOSE TWO SPELLINGS SHARE NO SYNTAX — executed, not rendered.
 *
 * `greatest`/`max`, `position(… in …)`/`instr`, `substring(… from … for …)`/`substr`. Two of the
 * three are SQL SYNTAX on the server, with keywords where the device has commas, and the third
 * puts its arguments in the opposite order. Rendering them proves they were composed; running
 * them on both stores and comparing the ANSWERS is the only thing that proves they mean the same.
 *
 * The `jsonHasAny` case above is why this is worded that way: it was composed correctly on both
 * arms and was valid SQL on neither, and nothing noticed because nothing had ever run it.
 */
describe("the constructs the two stores spell with different syntax, ANSWERED by each", () => {
  it("takes the largest of several values", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    const [row] = await d.exec(db, sql`select ${d.greatest(sql`3`, sql`11`, sql`7`)} as n`);
    expect(Number(row?.[0])).toBe(11);
  });

  it("refuses ONE value, because on the device store that word is the aggregate", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    // Not a style rule. `max(x)` on the device store collapses the result set instead of
    // comparing within a row — it runs, answers a different question, and reports nothing.
    expect(() => d.greatest(sql`3`)).toThrow(/at least two values/);
  });

  it("finds where one string starts inside another, 1-based, and 0 when it is absent", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    const [hit] = await d.exec(db, sql`select ${d.strpos(sql`'a@b.test'`, sql`'@'`)} as n`);
    expect(Number(hit?.[0])).toBe(2);
    const [miss] = await d.exec(db, sql`select ${d.strpos(sql`'nobody'`, sql`'@'`)} as n`);
    expect(Number(miss?.[0])).toBe(0);
  });

  it("takes a substring from an index, with and without a length", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    const [tail] = await d.exec(db, sql`select ${d.substr(sql`'a@b.test'`, sql`3`)} as s`);
    expect(String(tail?.[0])).toBe("b.test");
    const [some] = await d.exec(db, sql`select ${d.substr(sql`'a@b.test'`, sql`3`, sql`1`)} as s`);
    expect(String(some?.[0])).toBe("b");
  });

  it("composes the three into the address's domain, which is what the callers want them for", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    const addr = sql`'Reader@Example.test'`;
    const domain = d.substr(addr, sql`${d.strpos(addr, sql`'@'`)} + 1`);
    const [row] = await d.exec(db, sql`select lower(${domain}) as d`);
    expect(String(row?.[0])).toBe("example.test");
  });
});

describe("rows come back in the order the statement selected", () => {
  // A row is an object, and JavaScript enumerates integer-like keys NUMERICALLY before the rest —
  // so a statement whose aliases happen to look like numbers came back reordered, silently, on
  // both stores. One column was all the previous test exercised, and one column cannot show it.
  it("keeps selection order even when the aliases look like numbers", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    const rows = await d.exec(db, sql`select 'left' as "2", 'right' as "1"`);
    expect(rows[0]).toEqual(["left", "right"]);
  });

  it("keeps selection order for an ordinary multi-column read", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    const rows = await d.exec(db, sql`select 'a' as alpha, 'b' as beta, 'c' as gamma`);
    expect(rows[0]).toEqual(["a", "b", "c"]);
  });

  it("refuses a statement whose columns cannot be told apart, rather than returning a short row", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    // BOTH ARMS. This used to return early for anything but the server, which meant the case ran on
    // one dialect and reported as covered on two — and the other arm did not refuse at all, it
    // returned a row with the same value in both positions.
    await expect(d.exec(db, sql`select 1 as dup, 2 as dup`)).rejects.toThrow(/more than one column named/);
  });
});

describe.runIf(!RUNNING_ON_SQLITE)("the Postgres run", () => {
  it("is branded for the server, so an unset variable cannot pass for the other run", async () => {
    const db = await makeTestDb();
    expect(dialectOf(db)).toBe("pg");
  });

});

/**
 * THE RULE ROUTER'S "IS THIS TERM PRESENT" QUESTION, ASKED OF BOTH STORES.
 *
 * A rule whose term is `'  '` must rank as bare, or the narrow rule wins the tie in SQL and then
 * declines to fire in the evaluator — a rule matching everything. The server asks with a regex
 * match; this store has no regex operator, so the two are spelled completely differently and the
 * only thing that keeps them honest is a case that runs on both and compares the ANSWERS.
 *
 * Every character of the evaluator's trim class is listed. A class that agrees on five of six is
 * a router that disagrees with itself on the sixth, and nothing else in the suite would show it.
 */
describe("whether a term counts as present", () => {
  const TRIM_CLASS = [" ", "\t", "\n", "\r", "\f", "\v"];
  const cases: [string, boolean][] = [
    ...TRIM_CLASS.map((c) => [c, false] as [string, boolean]),
    ["", false],
    [TRIM_CLASS.join(""), false],
    ["a", true],
    [" a ", true],
    ["\ta\n", true],
    ["  .  ", true],
  ];

  for (const [value, present] of cases) {
    it(`says ${JSON.stringify(value)} is ${present ? "present" : "bare"}`, async () => {
      const db = await makeTestDb();
      const d = dialect(db);
      const [row] = await d.exec(db, sql`select case when ${d.hasNonBlank(sql`${value}`)} then 1 else 0 end`);
      expect(Number(row[0])).toBe(present ? 1 : 0);
    });
  }
});

