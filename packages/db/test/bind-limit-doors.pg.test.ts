import { describe, it, expect, afterAll } from "vitest";
import postgres from "postgres";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { boundCount, MAX_BIND_PARAMETERS, withBindLimit } from "../src/client.js";

/**
 * EVERY DOOR OF A GUARDED CLIENT REFUSES A STATEMENT OVER THE DRIVER'S LIMIT IN ITS OWN CALL. Each
 * handle's function-valued properties are listed and each must be classified below: a statement door
 * is driven with MAX_BIND_PARAMETERS + 1 values and must answer OHMAIL_BIND_LIMIT, then an ordinary
 * query on the same handle must get its own rows. A door the driver grows is unclassified and refused.
 */
const PG_UP = await realPgAvailable();
const OVER = MAX_BIND_PARAMETERS + 1;
const over = Array.from({ length: OVER }, (_, i) => i);
const clients: Array<ReturnType<typeof postgres>> = [];
type Sql = ReturnType<typeof postgres>;

/** Doors that bind no caller value, or a fixed few: each named with what it binds. */
const NOT_A_STATEMENT: Record<string, string> = {
  array: "builds a parameter", json: "builds a parameter", typed: "builds a parameter", types: "builds a parameter",
  end: "closes the pool", close: "closes the pool", release: "returns a reserved connection", prepare: "names a two-phase commit",
  PostgresError: "the error class",
  notify: "binds exactly 2 (channel, payload)", listen: "its own connection; the channel is escaped text, nothing bound",
  subscribe: "its own replication connection; binds nothing from the caller", largeObject: "binds its own fixed arguments",
};
/** Doors that hand on a scoped handle: guarded when that handle's own doors are (driven below). */
const SCOPES = new Set(["begin", "reserve", "savepoint"]);
/** Statement doors, each driven over the limit. `tag` is the tagged call itself. */
const STATEMENT = new Set(["tag", "call", "apply", "bind", "unsafe", "file"]);

const strings = ((s: TemplateStringsArray, ..._v: unknown[]) => s)`select 1 where 1 in ${0}`;
const sqlFile = join(mkdtempSync(join(tmpdir(), "bind-doors-")), "q.sql");
writeFileSync(sqlFile, "select 1");

const outcome = (run: () => unknown): Promise<string> => Promise.race([
  Promise.resolve().then(run).then(() => "sent", (e: unknown) => String((e as { code?: unknown })?.code ?? e)),
  new Promise<string>((r) => setTimeout(() => r("PENDING"), 5000)),
]);

/** An ordinary query after the refusal: its own tag back, or what it got instead. */
const ownRows = (h: Sql, tag: string): Promise<string> => Promise.race([
  Promise.resolve().then(() => h`select ${tag}::text as tag`)
    .then((r) => String(r[0]?.tag), (e: unknown) => `ERR ${String((e as { code?: unknown })?.code ?? e)}`),
  new Promise<string>((r) => setTimeout(() => r("PENDING"), 5000)),
]);

function drive(h: Sql, door: string): () => unknown {
  switch (door) {
    case "tag": return () => h`select 1 where 1 in ${h(over)}`;
    case "call": return () => (h as unknown as (...a: unknown[]) => unknown).call(null, strings, h(over));
    case "apply": return () => (h as unknown as (...a: unknown[]) => unknown).apply(null, [strings, h(over)]);
    case "bind": return () => (h as unknown as (...a: unknown[]) => unknown).bind(null)(strings, h(over));
    case "unsafe": return () => h.unsafe("select 1", over);
    case "file": return () => h.file(sqlFile, over);
    case "savepoint-tag": return () => (h as unknown as { savepoint: Sql }).savepoint`select 1 where 1 in ${h(over)}`;
    default: throw new Error(`no driver for ${door}`);
  }
}

const doorsOf = (h: Sql): string[] =>
  Object.keys(h).filter((k) => typeof (h as unknown as Record<string, unknown>)[k] === "function");
const unclassified = (keys: string[]): string[] =>
  keys.filter((k) => !(k in NOT_A_STATEMENT) && !SCOPES.has(k) && !STATEMENT.has(k));
const listed: Record<string, string[]> = {};

/** Classify every function-valued property of a handle, then drive each statement door on it. */
async function census(h: Sql, where: string, extra: string[] = []): Promise<Record<string, string>> {
  const keys = doorsOf(h);
  listed[where] = keys;
  expect(unclassified(keys), `${where}: doors nobody classified`).toEqual([]);
  const read: Record<string, string> = {};
  for (const door of [...STATEMENT].filter((d) => d === "tag" || d === "call" || d === "apply" || d === "bind" || keys.includes(d)).concat(extra)) {
    read[door] = await outcome(drive(h, door));
    read[`${door}:after`] = await ownRows(h, `${where}:${door}`);
  }
  return read;
}
const refusedEverywhere = (read: Record<string, string>, where: string) =>
  Object.fromEntries(Object.keys(read).map((k) => [k, k.endsWith(":after") ? `${where}:${k.slice(0, -6)}` : "OHMAIL_BIND_LIMIT"]));

afterAll(async () => {
  for (const c of clients) await Promise.race([c.end({ timeout: 1 }), new Promise((r) => setTimeout(r, 2000))]);
});

describe.skipIf(!PG_UP)("every door of the guarded client", () => {
  it("counts an array of fragments as every value its fragments bind", async () => {
    const seen: number[] = [];
    const raw = postgres(PG_TEST_URL, { max: 1, onnotice: () => {}, debug: (_c, _t, p) => { seen.push(p.length); } });
    clients.push(raw);
    const guarded = withBindLimit(raw);
    const frags = [guarded`${1}::int`, ...[2, 3, 4, 5].map((v) => guarded`+ ${v}::int`)];
    const rows = await guarded`select ${frags} as n`;
    expect(rows[0]!.n).toBe(15);
    expect(Math.max(...seen)).toBe(5);
    expect(boundCount([frags])).toBeGreaterThanOrEqual(5);
    // A row helper whose cells are fragments is counted cell by cell, fragments included.
    expect(boundCount([(raw as unknown as (v: unknown) => unknown)([{ a: raw`${1} + ${2}`, b: 3 }])])).toBeGreaterThanOrEqual(3);
    // An insert helper binds every row under the first row's columns.
    await guarded.unsafe("create temp table bind_doors (a int, b int)");
    seen.length = 0;
    const objects = [{ a: 1, b: 2 }, { a: 3, b: 4 }, { a: 5, b: 6 }];
    await guarded`insert into bind_doors ${guarded(objects)}`;
    expect(boundCount([raw(objects)])).toBeGreaterThanOrEqual(Math.max(...seen));
    expect(Math.max(...seen)).toBe(6);
    // A value that merely carries `strings` and `args` is one parameter, not a fragment of none.
    expect(boundCount([{ strings: ["x"], args: [] }])).toBe(1);
    // Over the limit as fragments, the statement refuses itself before the driver builds it.
    const many = [guarded`${0}`, ...Array.from({ length: OVER - 1 }, (_, i) => guarded`, ${i + 1}`)];
    seen.length = 0;
    expect(await outcome(() => guarded`select 1 where 1 in (${many})`)).toBe("OHMAIL_BIND_LIMIT");
    expect(seen).toEqual([]);
  }, 30_000);

  it("refuses the tagged savepoint form in its own call, and the transaction stays the caller's", async () => {
    const guarded = withBindLimit(postgres(PG_TEST_URL, { max: 1, onnotice: () => {} }));
    clients.push(guarded);
    const read = await guarded.begin(async (tx) => {
      const refused = await outcome(drive(tx as unknown as Sql, "savepoint-tag"));
      const after = await tx`select 'still mine' as tag`;
      return [refused, after[0]!.tag];
    });
    expect(read).toEqual(["OHMAIL_BIND_LIMIT", "still mine"]);
  }, 30_000);

  it("refuses at every door of the pool, a transaction, a savepoint and a reserved connection", async () => {
    const guarded = withBindLimit(postgres(PG_TEST_URL, { max: 2, onnotice: () => {} }));
    clients.push(guarded);
    const root = await census(guarded, "root");
    expect(root).toEqual(refusedEverywhere(root, "root"));
    expect(Object.keys(root)).toContain("file");

    const [tx, sp] = await guarded.begin(async (t) => {
      const inTx = await census(t as unknown as Sql, "tx", ["savepoint-tag"]);
      const inSp = await (t as unknown as { savepoint: (fn: (s: Sql) => Promise<unknown>) => Promise<Record<string, string>> })
        .savepoint((s) => census(s, "savepoint", ["savepoint-tag"]));
      return [inTx, inSp];
    });
    expect(tx).toEqual(refusedEverywhere(tx!, "tx"));
    expect(sp).toEqual(refusedEverywhere(sp!, "savepoint"));
    expect(Object.keys(tx!)).toContain("savepoint-tag");

    const reserved = await guarded.reserve();
    try {
      const r = await census(reserved, "reserved");
      expect(r).toEqual(refusedEverywhere(r, "reserved"));
    } finally { reserved.release(); }
    // The listing read real handles: each carries the doors this census was written against.
    expect(listed.root).toEqual(expect.arrayContaining(["begin", "reserve", "unsafe", "file", "notify", "listen"]));
    expect(listed.tx).toEqual(expect.arrayContaining(["savepoint", "prepare", "unsafe", "file"]));
    expect(listed.savepoint).toEqual(expect.arrayContaining(["savepoint", "unsafe"]));
    expect(listed.reserved).toEqual(expect.arrayContaining(["release", "unsafe", "file"]));
  }, 60_000);

  it("refuses a door nobody classified", () => {
    const raw = Object.assign(postgres(PG_TEST_URL, { max: 1, onnotice: () => {} }), { sneak: () => "sent" });
    clients.push(raw);
    expect(unclassified(doorsOf(withBindLimit(raw)))).toEqual(["sneak"]);
    const plain = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    clients.push(plain);
    expect(unclassified(doorsOf(withBindLimit(plain)))).toEqual([]);
  });

  it("notify binds the two values it names", async () => {
    const seen: number[] = [];
    const guarded = withBindLimit(postgres(PG_TEST_URL, { max: 1, onnotice: () => {}, debug: (_c, _t, p) => { seen.push(p.length); } }));
    clients.push(guarded);
    await guarded.notify("bind_doors_census", "x".repeat(10));
    expect(Math.max(...seen)).toBe(2);
  }, 30_000);
});
