import { describe, it, expect, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql as dsql } from "drizzle-orm";
import { brandDialect } from "../src/dialect/index.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import {
  acquireCeilingHandle, BindLimitError, boundCount, closeDb, closePooledDbs, makeDb, makeOwnedDb, makePooledDb,
  MAX_BIND_PARAMETERS, withBindLimit,
} from "../src/client.js";

/**
 * A STATEMENT OVER THE DRIVER'S LIMIT IS REFUSED IN ITS OWN CALL, never on someone else's. postgres.js
 * 3.4.9 refuses an over-limit statement only after queueing it behind the query in flight on a busy
 * connection, rejects THAT query, and leaves every later reply one query out of step. Both arms run
 * on one connection with a query in flight: the bare driver shows the defect, the guarded one does not.
 */
const PG_UP = await realPgAvailable();
const OVER = MAX_BIND_PARAMETERS + 1;
const ids = Array.from({ length: OVER }, (_, i) => `r${i}@x`);
const clients: Array<ReturnType<typeof postgres>> = [];

type Settled = { ok: unknown } | { err: string } | { pending: true };
const settle = (p: Promise<unknown>, ms: number): Promise<Settled> => Promise.race([
  p.then((v) => ({ ok: v }), (e: unknown) => ({ err: String((e as { code?: unknown })?.code ?? (e as Error)?.name) })),
  new Promise<Settled>((r) => setTimeout(() => r({ pending: true }), ms)),
]);
const tags = (s: Settled): unknown =>
  "ok" in s ? (s.ok as Array<{ tag: string }>).map((r) => r.tag) : "err" in s ? s.err : "PENDING";

/** One innocent query in flight, the over-limit statement behind it, then four ordinary queries. */
async function round(client: ReturnType<typeof postgres>) {
  const db = brandDialect(drizzle(client), "pg");
  await db.execute(dsql`select 1`);
  const x = settle(db.execute(dsql`select pg_sleep(0.3), 'X' as tag`) as Promise<unknown>, 3000);
  await new Promise((r) => setTimeout(r, 30));
  const y = settle(Promise.resolve().then(() =>
    db.execute(dsql`select 'Y' as tag where 'q' in (${dsql.join(ids.map((i) => dsql`${i}`), dsql`, `)})`)), 3000);
  const xr = await x;
  const yr = await y;
  const z1 = await settle(db.execute(dsql`select tag from (values ('Z1a'), ('Z1b')) v(tag)`) as Promise<unknown>, 3000);
  const z2 = await settle(db.execute(dsql`select 'Z2' as tag`) as Promise<unknown>, 3000);
  return { x: tags(xr), y: tags(yr), z1: tags(z1), z2: tags(z2) };
}

afterAll(async () => {
  for (const c of clients) await Promise.race([c.end({ timeout: 1 }), new Promise((r) => setTimeout(r, 2000))]);
});

describe.skipIf(!PG_UP)("the bind-count guard", () => {
  it("the bare driver rejects the query in flight and answers the next one with the wrong rows", async () => {
    const bare = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    clients.push(bare);
    const r = await round(bare);
    // The control the guard exists for: the innocent query X takes the over-limit statement's refusal.
    expect(r.x).toBe("MAX_PARAMETERS_EXCEEDED");
    expect(r.z1).not.toEqual(["Z1a", "Z1b"]);
  }, 20_000);

  it("the guarded client refuses the statement itself, and every other query gets its own rows", async () => {
    const guarded = withBindLimit(postgres(PG_TEST_URL, { max: 1, onnotice: () => {} }));
    clients.push(guarded);
    expect(await round(guarded)).toEqual({ x: ["X"], y: "OHMAIL_BIND_LIMIT", z1: ["Z1a", "Z1b"], z2: ["Z2"] });
  }, 20_000);

  it("refuses in the caller's own call, at the limit and not under it, inside a transaction too", async () => {
    const guarded = withBindLimit(postgres(PG_TEST_URL, { max: 1, onnotice: () => {} }));
    clients.push(guarded);
    expect(() => guarded.unsafe("select 1", Array.from({ length: OVER }, () => 1))).toThrow(BindLimitError);
    const at = await guarded.unsafe(`select ${Array.from({ length: 2 }, (_, i) => `$${i + 1}::int`).join(" + ")} as n`, [1, 2]);
    expect(at[0]!.n).toBe(3);
    const inTx = await guarded.begin(async (tx) => {
      const refused = await Promise.resolve().then(() => tx.unsafe("select 1", Array.from({ length: OVER }, () => 1))).then(() => "sent", (e: unknown) => (e as BindLimitError).code);
      const after = await tx`select 'still mine' as tag`;
      return [refused, after[0]!.tag];
    });
    expect(inTx).toEqual(["OHMAIL_BIND_LIMIT", "still mine"]);
  }, 20_000);

  it("every constructor hands drizzle the guarded client, and drizzle's own doors meet it, in a transaction too", async () => {
    const over = Array.from({ length: OVER }, () => 1);
    const owned = makeOwnedDb(PG_TEST_URL);
    try {
      const handles = [
        ["makeOwnedDb", owned.db], ["makePooledDb", makePooledDb(PG_TEST_URL, { max: 1 })],
        ["makeDb", makeDb(PG_TEST_URL)], ["acquireCeilingHandle", acquireCeilingHandle(owned.db, 5_000)],
      ] as const;
      for (const [name, db] of handles) {
        const client = (db as unknown as { $client: ReturnType<typeof postgres> }).$client;
        const raw = await Promise.resolve().then(() => client.unsafe("select 1", over))
          .then(() => "sent", (e: unknown) => (e as { code?: unknown }).code);
        const viaDrizzle = await db.execute(dsql`select 1 where 1 in (${dsql.join(over.map((v) => dsql`${v}`), dsql`, `)})`)
          .then(() => "sent", (e: unknown) => (e as { code?: unknown }).code);
        const ordinary = await db.execute(dsql`select 7 as n`);
        // drizzle's transaction and savepoint doors hand on scoped handles the outer one never sees.
        const overLimit = dsql`select 1 where 1 in (${dsql.join(over.map((v) => dsql`${v}`), dsql`, `)})`;
        const inTx = await db.transaction(async (tx) => {
          const refused = await tx.execute(overLimit).then(() => "sent", (e: unknown) => (e as { code?: unknown }).code);
          const nested = await tx.transaction(async (sp) => sp.execute(overLimit)).then(() => "sent", (e: unknown) => (e as { code?: unknown }).code);
          const after = await tx.execute(dsql`select 8 as n`);
          return [refused, nested, (after as unknown as Array<{ n: number }>)[0]?.n];
        });
        expect([name, raw, viaDrizzle, (ordinary as unknown as Array<{ n: number }>)[0]?.n, ...inTx])
          .toEqual([name, "OHMAIL_BIND_LIMIT", "OHMAIL_BIND_LIMIT", 7, "OHMAIL_BIND_LIMIT", "OHMAIL_BIND_LIMIT", 8]);
      }
    } finally {
      await owned.close();
      await closePooledDbs();
      await closeDb();
    }
  }, 30_000);

  it("counts a tagged call at least as high as the driver binds it", async () => {
    const seen: number[] = [];
    const raw = postgres(PG_TEST_URL, { max: 1, onnotice: () => {}, debug: (_c, _t, params) => { seen.push(params.length); } });
    clients.push(raw);
    const guarded = withBindLimit(raw);
    // Each shape's interpolations, captured, then run: the guard's count is never under the driver's.
    const args = (_s: TemplateStringsArray, ...a: unknown[]) => a;
    const shapes: Array<[string, unknown[], () => Promise<unknown>]> = [
      ["values", args`${1}${2}`, () => guarded`select ${1}::int + ${2}::int as n`],
      ["an in-list helper", args`${raw(["a", "b", "c"])}`, () => guarded`select 1 where 'a' in ${guarded(["a", "b", "c"])}`],
      ["a row helper", args`${raw([[1, 2], [3, 4]])}`, () => guarded`select * from (values ${guarded([[1, 2], [3, 4]])}) v(a, b)`],
      ["a nested fragment", args`${raw`${1}::int + ${2}::int`}`, () => guarded`select ${guarded`${1}::int + ${2}::int`} as n`],
    ];
    for (const [name, captured, run] of shapes) {
      seen.length = 0;
      await run();
      // The hook fires per build (a describe, then the bind), so the driver's count is the largest.
      expect(seen.length, name).toBeGreaterThan(0);
      expect(boundCount(captured), name).toBeGreaterThanOrEqual(Math.max(...seen));
    }
    // And over the limit through a helper, the tagged form refuses before the driver builds it.
    const big = Array.from({ length: OVER }, (_, i) => `v${i}`);
    seen.length = 0;
    expect(() => guarded`select 1 where 'a' in ${guarded(big)}`).toThrow(BindLimitError);
    expect(seen).toEqual([]);
  }, 30_000);
});
