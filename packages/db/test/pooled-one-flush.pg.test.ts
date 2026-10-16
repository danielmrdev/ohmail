import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, sql, type SQL } from "drizzle-orm";
import { accounts } from "../src/index.js";
import { closePooledDbs, DbParameterTypeError, makePooledDb } from "../src/cloud.js";
import { runMigrations } from "../src/admin.js";
import { brandDialect } from "../src/dialect/index.js";
import { PG_TEST_URL, realPgAvailable, recordPgWire } from "../src/testing.js";

/**
 * THE POOLED CLIENT SENDS A PARAMETERIZED STATEMENT IN ONE FLUSH and binds exactly what the
 * driver's describe would have: every parameter kind drizzle hands the driver, compared with a
 * door-less client on the same database — the answer and the Bind message's bytes — inside a
 * transaction and a savepoint too. A position the describe would have bound otherwise is refused;
 * a kind the door does not know keeps its describe; a statement still holds its connection alone.
 */
const wire = recordPgWire();
const PG_UP = await realPgAvailable();
const variant = (name: string): string => {
  const u = new URL(PG_TEST_URL);
  u.searchParams.set("application_name", name);
  return u.toString();
};

describe.skipIf(!PG_UP)("the pooled client: one flush a statement (real Postgres)", () => {
  let reference: ReturnType<typeof postgres>;
  let db: ReturnType<typeof makePooledDb>;
  let plain: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    db = makePooledDb(variant("one-flush"));
    reference = postgres(PG_TEST_URL, { max: 1, prepare: false, onnotice: () => {} });
    plain = brandDialect(drizzle(reference), "pg");
    await db.execute(sql`select 1`);
    await plain.execute(sql`select 1`);
  }, 120_000);

  afterAll(async () => {
    await reference.end({ timeout: 5 });
    await closePooledDbs();
  });

  async function read(run: () => Promise<unknown>): Promise<{ rows: unknown; statements: number; roundTrips: number; binds: string[] }> {
    wire.start();
    const rows = await run();
    const r = wire.read();
    return { rows, statements: r.statements, roundTrips: r.roundTrips, binds: r.binds.map((b) => b.toString("hex")) };
  }

  const kinds: Array<[string, SQL]> = [
    ["a boolean", sql`select ${true} as v`],
    ["text", sql`select ${"heron"}::text as v`],
    ["text a column decides", sql`select 'x' = ${"x"} as v`],
    ["a number", sql`select 1 + ${41} as v`],
    ["null", sql`select ${null}::text as v`],
    ["a bigint", sql`select ${9007199254740993n}::int8 as v`],
    ["bytes", sql`select length(${new Uint8Array([1, 2, 3])}::bytea) as v`],
    ["a text array", sql`select array_length(${sql.param(["a", "b\"c", "d\\e", null])}::text[], 1) as v`],
    ["a number array", sql`select ${sql.param([3, 1, 2])}::int[] as v`],
    ["jsonb as text", sql`select (${JSON.stringify({ a: 1 })}::jsonb ->> 'a') as v`],
    ["a timestamp as ISO", sql`select ${"2026-09-24T12:00:00.000Z"}::timestamptz as v`],
    ["two uuids", sql`select ${"00000000-0000-0000-0000-000000000001"}::uuid = ${"00000000-0000-0000-0000-000000000001"}::uuid as v`],
  ];

  for (const [name, statement] of kinds) {
    it(`${name}: one round trip, the describe's answer and its Bind bytes`, async () => {
      const door = await read(() => db.execute(statement));
      const bare = await read(() => plain.execute(statement));
      expect(bare.roundTrips, "the reference pays the describe").toBe(2);
      expect(door.statements).toBe(1);
      expect(door.roundTrips).toBe(1);
      expect(door.rows).toEqual(bare.rows);
      expect(door.binds).toEqual(bare.binds);
    });
  }

  it("inside a transaction and a savepoint: begin, each statement, commit — one round trip apiece", async () => {
    const r = await read(() => db.transaction(async (tx) => {
      await tx.execute(sql`select ${"a"}::text`);
      await tx.transaction(async (inner) => { await inner.execute(sql`select ${2}::int`); });
      return tx.execute(sql`select ${"b"}::text as v`);
    }));
    // begin · a · savepoint · 2 · b · commit: the driver's own savepoint and commit are one flush too.
    expect(r.statements).toBe(6);
    expect(r.roundTrips).toBe(6);
  });

  it("text the server types boolean is refused: the describe would have bound false", async () => {
    const bare = await plain.execute(sql`select ${"t"}::boolean as v`);
    expect(bare).toEqual([{ v: false }]);
    const refused = await db.execute(sql`select ${"t"}::boolean as v`).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(DbParameterTypeError);
    expect(refused).toMatchObject({ position: 1, oid: 16, code: "db_parameter_type" });
    const number = await db.execute(sql`select ${1}::boolean as v`).then(() => null, (e: unknown) => e);
    expect(number).toMatchObject({ position: 1, oid: 16 });
  });

  it("an array the server types as text is refused: the describe would have sent it unbracketed", async () => {
    const refused = await db.execute(sql`select ${sql.param(["a", "b"])}::text as v`).then(() => null, (e: unknown) => e);
    expect(refused).toMatchObject({ position: 1, oid: 25 });
  });

  it("a refusal inside a transaction rolls it back; a lone write has run, and each refusal says which", async () => {
    const name = `one-flush-${randomUUID()}`;
    const inTx = await db.transaction(async (tx) => {
      await tx.insert(accounts).values({ name });
      await tx.execute(sql`select ${"t"}::boolean`);
    }).then(() => null, (e: unknown) => e);
    expect(inTx).toBeInstanceOf(DbParameterTypeError);
    expect(inTx).toMatchObject({ committed: false });
    expect(await db.select().from(accounts).where(eq(accounts.name, name))).toHaveLength(0);
    const inSavepoint = await db.transaction((tx) => tx.transaction((inner) => inner.execute(sql`select ${"t"}::boolean`)))
      .then(() => null, (e: unknown) => e);
    expect(inSavepoint).toMatchObject({ committed: false });
    const lone = await db.execute(sql`insert into accounts (name) select ${name} where ${"t"}::boolean`)
      .then(() => null, (e: unknown) => e);
    expect(lone).toBeInstanceOf(DbParameterTypeError);
    // The write stood before the refusal arrived, and the refusal says so: a retry would repeat it.
    expect(lone).toMatchObject({ committed: true });
    expect((lone as Error).message).toMatch(/committed — do not retry it/);
    expect(await db.select().from(accounts).where(eq(accounts.name, name))).toHaveLength(1);
    await db.delete(accounts).where(eq(accounts.name, name));
  });

  it("a nested array keeps the describe: two round trips and the reference's answer", async () => {
    const statement = sql`select ${sql.param([["a", "b"], ["c", "d"]])}::text[][] as v`;
    const door = await read(() => db.execute(statement));
    const bare = await read(() => plain.execute(statement));
    expect(door.roundTrips).toBe(2);
    expect(door.rows).toEqual(bare.rows);
  });

  it("a statement holds its connection alone, as the describe made it: the next one waits", async () => {
    const one = makePooledDb(variant("one-flush-single"), { max: 1 });
    await one.execute(sql`select 1`);
    wire.start();
    // `.then` dispatches: a drizzle query is lazy until awaited.
    const slow = one.execute(sql`select pg_sleep(${0.2})`).then((x) => x);
    const next = one.execute(sql`select ${1}::int`).then((x) => x);
    await new Promise((r) => setTimeout(r, 100));
    const during = wire.read().statements;
    await Promise.all([slow, next]);
    expect(during, "the second statement was pipelined behind the first").toBe(1);
    expect(wire.read().statements).toBe(2);
  });
});
