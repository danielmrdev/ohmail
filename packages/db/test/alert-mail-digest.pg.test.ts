import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { like, or, eq } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { schema, alertState } from "../src/schema.js";
import { runAlertPass, type AlertSink } from "../src/alerts.js";
import type { AlertDigest } from "../src/alert-mail-policy.js";

/**
 * TWO DRIVERS, ONE DIGEST (review 026). Both passes find the day's digest due over the same
 * window; the digest row's lock is what makes one of them send. An outside transaction holds the
 * row while both start, so the race is forced. PGlite has one session and cannot express it.
 */
const AVAILABLE = await realPgAvailable();
const NOW = new Date("2026-12-01T12:00:00.000Z");
const HOUR = 3_600_000;

describe.skipIf(!AVAILABLE)("the daily digest under two drivers, on real Postgres", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 5, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);
  const cleanup = () => db.delete(alertState).where(or(like(alertState.alertKey, "mail:%"), eq(alertState.alertKey, "digest-race:old")));
  afterAll(async () => { await cleanup(); await sql?.end(); });

  for (const order of ["worker-first", "api-first"] as const) {
    it(`${order}: exactly one digest`, async () => {
      await cleanup();
      await db.insert(alertState).values({
        alertKey: "digest-race:old", kind: "sends_stuck", severity: "critical", cls: "incident",
        openedAt: new Date(NOW.getTime() - 3 * HOUR), lastSeenAt: new Date(NOW.getTime() - 2 * HOUR),
        resolvedAt: new Date(NOW.getTime() - 2 * HOUR), notifyCount: 0,
      });
      await db.insert(alertState).values({
        alertKey: "mail:digest", kind: "mail_policy", severity: "warning", cls: "signal",
        resolvedAt: new Date(0), notifyCount: 0,
      });
      let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
      let held!: () => void; const locked = new Promise<void>((r) => { held = r; });
      const holder = sql.begin(async (tx) => {
        await tx`select 1 from alert_state where alert_key = 'mail:digest' for update`;
        held(); await gate;
      });
      await locked;
      const digests: AlertDigest[] = [];
      const sink = (): AlertSink => ({
        name: "mail", channel: "mail", async notify() { return true; },
        async notifyDigest(d) { digests.push(d); await new Promise((r) => setTimeout(r, 200)); return true; },
      });
      const w = () => runAlertPass(db, { now: NOW, shards: [], sinks: [sink()], source: "worker" });
      const a = () => runAlertPass(db, { now: NOW, shards: [], sinks: [sink()], source: "api" });
      const p = order === "worker-first" ? Promise.all([w(), a()]) : Promise.all([a(), w()]);
      await new Promise((r) => setTimeout(r, 750));
      release(); await holder; await p;
      expect(digests.filter((d) => d.lines.some((l) => l.key === "digest-race:old"))).toHaveLength(1);
    });
  }
});
