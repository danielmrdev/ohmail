import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomInt } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { schema } from "../src/schema.js";
import { runAlertPass } from "../src/alerts.js";

/**
 * THE FALSE-OPEN CLOSE ON REAL POSTGRES. The close re-asks the confirmation under the write with
 * a raw `last_seen_at <= $n::timestamptz`, the parameter class PGlite binds happily and
 * postgres-js refuses as a bare Date. Keys live in their own shard range, NOW sits before every
 * other alert pg file's (so the fence keeps this pass off their rows), and the pass names no
 * driver, so it records no pass row; the rows it wrote are removed after.
 */
const AVAILABLE = await realPgAvailable();
const NOW = new Date("2026-01-15T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const nowIso = NOW.toISOString();

describe.skipIf(!AVAILABLE)("the false-open close on real Postgres", () => {
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const base = 940_000 + randomInt(0, 50_000) * 4;
  let next = 0;
  const seeded: string[] = [];
  const key = (): string => { const k = `worker_down:${base + next++}`; seeded.push(k); return k; };

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);

  afterAll(async () => {
    // What this file's passes wrote carries its NOW; what it seeded carries its key range.
    await sql`delete from alert_state where last_seen_at = ${nowIso}::timestamptz
      or alert_key = any(${seeded})`;
    await sql.end({ timeout: 5 });
  });

  const seed = async (k: string, seenAgo: number): Promise<void> => {
    await sql`insert into alert_state (alert_key, kind, severity, opened_at, last_seen_at, notified_at,
        notify_count, detail, cls, title, count)
      values (${k}, 'worker_down', 'critical', ${ago(4 * HOUR)}::timestamptz, ${ago(seenAgo)}::timestamptz,
        ${ago(4 * HOUR)}::timestamptz, 2, 'seeded', 'incident', 'seeded', 1)`;
  };
  const row = async (k: string) => {
    const [r] = await sql`select resolved_at, notify_count from alert_state where alert_key = ${k}`;
    return r!;
  };
  const pass = () => runAlertPass(db, { now: NOW, sinks: [], shards: [] });

  const caseA = async () => {
    const k = key();
    await seed(k, 3 * HOUR);
    const p = await pass();
    const r = await row(k);
    expect(r.resolved_at, "closed by the evaluation").not.toBeNull();
    expect(new Date(r.resolved_at as string).toISOString()).toBe(nowIso);
    expect(Number(r.notify_count), "no resolution notice owed").toBe(0);
    expect(p.closedUnconfirmed).toContain(k);
    expect(p.resolved).not.toContain(k);
  };
  const caseB = async () => {
    const k = key();
    await seed(k, MIN);
    const p = await pass();
    expect((await row(k)).resolved_at, "confirmed a minute ago: still open").toBeNull();
    expect(p.closedUnconfirmed).not.toContain(k);
  };

  it("A: a row nothing confirmed for the dark threshold closes, unannounced", caseA);
  it("B: a row confirmed a minute ago stays open", caseB);
  it("B-then-A: the order of the two changes neither outcome", async () => {
    await caseB();
    await caseA();
  });
});
