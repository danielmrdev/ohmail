import fs, { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGDATA } from "@electric-sql/pglite/basefs";
import { afterAll, describe, expect, it } from "vitest";
import { PGDATA_SUBDIR, openLocalDb, type OpenLocalDb } from "../src/db.js";
import { PGLITE_TRANSPORT_NAMES } from "../src/pglite-transport.js";
import { inStoreLane } from "../src/store-lanes.js";
import { freshDataDir } from "./_datadir.js";

/**
 * PGLITE'S PROTOCOL TRANSPORT NEVER REACHES THE DISK, AND EVERYTHING ELSE STILL DOES.
 *
 * At the base every round trip cost seven host calls on `.s.PGSQL.5432.*` in the data directory —
 * most of the file operations an imported message made on Linux, and most of the far more on Windows.
 * Counted at the `node:fs` seam PGlite's NodeFS calls into; the positive control is the same work
 * through PGlite's stock filesystem, which must read the calls this store no longer makes.
 */

const dirs: string[] = [];
const open: OpenLocalDb[] = [];
afterAll(async () => {
  for (const h of open) await h.close().catch(() => { /* a closed handle is fine */ });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const PATH_CALLS = ["openSync", "truncateSync", "lstatSync", "statSync", "existsSync", "writeFileSync", "renameSync", "unlinkSync"];

/** Every path-taking `node:fs` call made while `work` runs, and how many named a transport file. */
async function hostCalls(work: () => Promise<void>): Promise<{ transport: number; all: number }> {
  const f = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
  const saved = PATH_CALLS.map((name) => [name, f[name]!] as const);
  let transport = 0, all = 0;
  for (const [name, orig] of saved) {
    f[name] = function (this: unknown, ...a: unknown[]) {
      if (typeof a[0] === "string") { all += 1; if (a[0].includes(".s.PGSQL.")) transport += 1; }
      return orig.apply(this, a);
    };
  }
  try { await work(); } finally { for (const [name, orig] of saved) f[name] = orig; }
  return { transport, all };
}

const ROUND_TRIPS = 40;

describe("the local store's protocol transport", () => {
  it("makes no host call on the transport files, and leaves a stale one on disk untouched", async () => {
    const dir = await freshDataDir("ohmail-transport-");
    dirs.push(dir);
    /* What a store an older build ran holds: the empty `.lock.out` it truncated at every round trip. */
    const stale = join(dir, PGDATA_SUBDIR, ".s.PGSQL.5432.lock.out");
    writeFileSync(stale, "left by an older build");
    const h = await openLocalDb(dir);
    open.push(h);
    const calls = await hostCalls(async () => {
      for (let i = 0; i < ROUND_TRIPS; i += 1) await h.db.execute(`select ${i}::int as n`);
    });
    expect(calls.transport, "a statement reached the transport files on disk").toBe(0);
    expect(readFileSync(stale, "utf8"), "the stale transport file was opened and truncated").toBe("left by an older build");
    expect(readdirSync(join(dir, PGDATA_SUBDIR)).filter((n) => n.startsWith(".s.PGSQL.") && n !== ".s.PGSQL.5432.lock.out"),
      "a transport file was created on disk").toEqual([]);
  }, 120_000);

  /* THE POSITIVE CONTROL: the same statements through PGlite's stock NodeFS make the calls. */
  it("…where PGlite's own filesystem makes them at every round trip", async () => {
    const dir = await freshDataDir("ohmail-transport-stock-");
    dirs.push(dir);
    const client = new PGlite(join(dir, PGDATA_SUBDIR));
    await client.waitReady;
    try {
      const calls = await hostCalls(async () => {
        for (let i = 0; i < ROUND_TRIPS; i += 1) await client.exec(`select ${i}::int as n`);
      });
      expect(calls.transport, "the stock filesystem no longer writes the transport, so the case above says nothing")
        .toBeGreaterThanOrEqual(ROUND_TRIPS * 3);
    } finally {
      await client.close();
    }
  }, 120_000);

  /* The set is the one compiled into the WASM, under the root it is applied to: an upgrade that
     renames or adds one would send it back to the disk with every other case still green. */
  it("names exactly the transport paths compiled into postgres.wasm", () => {
    const pkg = dirname(createRequire(import.meta.url).resolve("@electric-sql/pglite"));
    const wasm = readFileSync(join(pkg, "postgres.wasm")).toString("latin1");
    const prefix = `${PGDATA}/`.replace(/[.]/g, "\\.");
    const compiled = new Set([...wasm.matchAll(new RegExp(`${prefix}(\\.s\\.PGSQL\\.[0-9A-Za-z.]+)`, "g"))].map((m) => m[1]!));
    expect(compiled.size, "no transport path found in the WASM — the reading is blind").toBeGreaterThan(0);
    expect([...PGLITE_TRANSPORT_NAMES].sort()).toEqual([...compiled].sort());
  });

  /* The durability half: the log still takes the commit on disk (`local-store-durability` and the
     kill cells in `slow/` say what that buys). */
  it("still writes the log to disk at a commit", async () => {
    const dir = await freshDataDir("ohmail-transport-wal-");
    dirs.push(dir);
    const h = await openLocalDb(dir);
    open.push(h);
    const wal = join(dir, PGDATA_SUBDIR, "pg_wal");
    const digest = () => {
      const hash = createHash("sha256");
      for (const n of readdirSync(wal).filter((x) => /^[0-9A-F]{24}$/.test(x)).sort()) hash.update(readFileSync(join(wal, n)));
      return hash.digest("hex");
    };
    await h.db.execute("create table transport_probe (n int)");
    const before = digest();
    await inStoreLane("ingest", () => h.db.transaction(async (tx) => { await tx.execute("insert into transport_probe values (1)"); }));
    await h.db.transaction(async (tx) => { await tx.execute("insert into transport_probe values (2)"); });
    expect(digest(), "a durable commit left the log on disk unchanged").not.toBe(before);
  }, 120_000);
});
