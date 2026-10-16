import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { brandDialect } from "../src/dialect/index.js";
import {
  MIGRATION_LOCK_KEY, MigrationSessionLostError, openMigrationSession, runMigrations,
} from "../src/migrate.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * the lock half. The migration lock is session-level, so it dies with its backend;
 * postgres.js then reopened the connection on the next statement and the setup carried on without
 * it. Each case terminates the session's backend from a second connection and reads what the
 * NEXT statement did: the plain client's control shows the defect (a new backend, no lock), the
 * migration session refuses and opens nothing, and `runMigrations` refuses by name.
 */
const PG_UP = await realPgAvailable();
const PROBE_KEY = 4207279777n; // not the migration key: only the runMigrations case contends on that

let admin: ReturnType<typeof postgres>;
beforeAll(async () => {
  if (!PG_UP) return;
  admin = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (PG_UP) await admin.end({ timeout: 5 }); });

/** Backends in this database carrying `name` — the session's reconnect would carry it too. */
const backendsNamed = async (name: string): Promise<number> => {
  const [r] = await admin<{ n: number }[]>`
    select count(*)::int as n from pg_stat_activity
     where datname = current_database() and application_name = ${name}`;
  return r!.n;
};

const until = async (what: string, check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** Call `open` under a unique application_name (postgres.js reads it at construction, synchronously). */
function named<T>(open: () => T): { name: string; value: T } {
  const name = `migration-session-${randomUUID().slice(0, 8)}`;
  const was = process.env.PGAPPNAME;
  process.env.PGAPPNAME = name;
  try { return { name, value: open() }; } finally {
    if (was === undefined) delete process.env.PGAPPNAME; else process.env.PGAPPNAME = was;
  }
}

/** Whether another session can take `key` now — true only once nobody holds it. */
const freeNow = async (key: bigint): Promise<boolean> => {
  const [r] = await admin<{ ok: boolean }[]>`select pg_try_advisory_lock(${key as unknown as number}) as ok`;
  if (r!.ok) await admin`select pg_advisory_unlock(${key as unknown as number})`;
  return r!.ok;
};

describe.skipIf(!PG_UP)("the migration lock's session is never replaced", () => {
  it("CONTROL: a plain max:1 client runs the next statement on a NEW backend, without the lock", async () => {
    const { value: plain } = named(() => postgres(PG_TEST_URL, { max: 1, onnotice: () => {} }));
    try {
      await plain`select pg_advisory_lock(${PROBE_KEY as unknown as number})`;
      const [a] = await plain<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await admin`select pg_terminate_backend(${a!.pid})`;
      await new Promise((r) => setTimeout(r, 300));
      const [b] = await plain<{ pid: number }[]>`select pg_backend_pid() as pid`;
      expect(b!.pid, "the statement ran on a replacement backend").not.toBe(a!.pid);
      expect(await freeNow(PROBE_KEY), "and the lock the client believes it holds is free").toBe(true);
    } finally {
      await plain.end({ timeout: 5 });
    }
  });

  it("a lost session refuses every later statement, opens no second backend, and frees the lock (B then A)", async () => {
    const { name, value: opening } = named(() => openMigrationSession(PG_TEST_URL));
    const session = await opening;
    try {
      await session.sql`select pg_advisory_lock(${PROBE_KEY as unknown as number})`;
      const [a] = await session.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      expect(await backendsNamed(name)).toBe(1);
      await admin`select pg_terminate_backend(${a!.pid})`;
      await until("the session to notice its backend closed", () => session.lost() !== null);

      // B: the lock went with A's backend, so another session takes it at once…
      expect(await freeNow(PROBE_KEY)).toBe(true);
      // …and A, which believed it held it, runs nothing through any door.
      expect(() => session.sql`select 1`).toThrow(MigrationSessionLostError);
      expect(() => session.sql.unsafe("select 1")).toThrow(MigrationSessionLostError);
      await expect(brandDialect(drizzle(session.sql), "pg").execute(sql`select 1`)).rejects.toBeInstanceOf(MigrationSessionLostError);
      await expect(session.sql.begin(async () => undefined)).rejects.toBeInstanceOf(MigrationSessionLostError);
      expect(await backendsNamed(name), "no statement reopened the connection").toBe(0);
    } finally {
      await session.end();
    }
  });

  it("a backend lost INSIDE a transaction refuses by name, with no rollback onto the dead socket", async () => {
    const session = await openMigrationSession(PG_TEST_URL);
    try {
      const [a] = await session.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const kill = setTimeout(() => { void admin`select pg_terminate_backend(${a!.pid})`.catch(() => {}); }, 300);
      await expect(
        session.sql.begin(async (tx) => { await tx`select pg_sleep(5)`; await tx`select 1`; }),
      ).rejects.toBeInstanceOf(MigrationSessionLostError);
      clearTimeout(kill);
      // postgres.js `begin` answered the same loss with an uncaught TypeError a tick later; give it one.
      await new Promise((r) => setTimeout(r, 300));
      expect(session.lost()).toBeInstanceOf(MigrationSessionLostError);
    } finally {
      await session.end();
    }
  });

  it("an ordinary session commits a transaction and ends without calling itself lost", async () => {
    const session = await openMigrationSession(PG_TEST_URL);
    const table = `migration_session_probe_${randomUUID().slice(0, 8)}`;
    try {
      await session.sql.begin(async (tx) => { await tx.unsafe(`create table public."${table}" (v int)`); });
      const [r] = await admin<{ n: number }[]>`select count(*)::int as n from pg_tables where tablename = ${table}`;
      expect(r!.n, "BEGIN/COMMIT on the session's one connection committed").toBe(1);
      await expect(session.sql.begin(async (tx) => {
        await tx.unsafe(`insert into public."${table}" values (1)`);
        throw new Error("abandon");
      })).rejects.toThrow("abandon");
      const [c] = await admin<{ n: number }[]>`select count(*)::int as n from ${admin(table)}`;
      expect(c!.n, "a throwing callback rolled back").toBe(0);
    } finally {
      await admin.unsafe(`drop table if exists public."${table}"`);
      await session.end();
    }
    expect(session.lost()).toBeNull();
  });

  it("runMigrations whose session is lost while it waits on the lock refuses by name", async () => {
    // Hold the real key so the migrator parks in pg_advisory_lock, then take its backend away.
    const key = MIGRATION_LOCK_KEY as unknown as number;
    const holder = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    await holder`select pg_advisory_lock(${key})`;
    try {
      const { name, value: running } = named(() => runMigrations(PG_TEST_URL));
      const run = running.then(() => "resolved", (err: unknown) => err);
      let waiter = 0;
      await until("the migrator to wait on the lock", async () => {
        const [w] = await admin<{ pid: number | null }[]>`
          select max(pid) as pid from pg_stat_activity
           where datname = current_database() and application_name = ${name}
             and wait_event_type = 'Lock' and wait_event = 'advisory'`;
        waiter = w?.pid ?? 0;
        return waiter > 0;
      });
      await admin`select pg_terminate_backend(${waiter})`;
      const outcome = await run;
      expect(outcome).toBeInstanceOf(MigrationSessionLostError);
    } finally {
      await holder.end({ timeout: 5 });
    }
  }, 150_000);

  it("and runMigrations over an up-to-date database still applies nothing and resolves", async () => {
    await expect(runMigrations(PG_TEST_URL)).resolves.toBeUndefined();
  }, 150_000);
});
