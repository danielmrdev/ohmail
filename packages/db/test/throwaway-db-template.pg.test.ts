import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  MIGRATED_DB_SETUP_BUDGET_MS, PG_TEMPLATE_NAME, PG_TEST_URL, cloneFromTemplate, dropPgTemplate, pgJournalMismatch,
  realPgAvailable, throwawayDb,
} from "../src/testing.js";

/**
 * THE SERVER ARM OF THE TEMPLATE: `createFromTemplate` clones this tree's SEALED template and
 * verifies the clone row for row; a mismatch drops the clone and the template and rebuilds once,
 * and a second throws with nothing left behind. The rebuild arms run on a SALTED key, so the
 * template they drop is this file's own and never the one every other checkout clones.
 */
const PG_UP = await realPgAvailable();
const salted: string[] = [];

async function admin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const u = new URL(PG_TEST_URL);
  u.pathname = "/postgres";
  const sql = postgres(u.toString(), { max: 1, onnotice: () => {}, connection: { statement_timeout: 0, lock_timeout: 0 } });
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}
const stateOf = (name: string) => admin(async (sql) =>
  (await sql`SELECT datistemplate, datallowconn FROM pg_database WHERE datname = ${name}`)[0] ?? null);
const target = (tag: string) => `tf_tpl_${tag}_${randomBytes(6).toString("hex")}`;

afterAll(async () => {
  if (!PG_UP) return;
  for (const t of salted) await dropPgTemplate(PG_TEST_URL, t);
});

describe.skipIf(!PG_UP)("a throwaway database cloned from the sealed template", () => {
  it("is this tree's schema, and the template it came from is sealed", async () => {
    const db = throwawayDb("tf_tpl_clone");
    try {
      await db.createFromTemplate();
      expect(await pgJournalMismatch(db.url)).toBeNull();
      const client = postgres(db.url, { max: 1, onnotice: () => {} });
      try {
        expect(((await client`SELECT count(*)::int AS n FROM accounts`)[0] as { n: number }).n).toBe(0);
      } finally {
        await client.end({ timeout: 5 });
      }
      const templates = await admin((sql) => sql`SELECT datname, datistemplate, datallowconn FROM pg_database
        WHERE datname LIKE 'trafficflow\\_tpl\\_%'`);
      expect(templates.length).toBeGreaterThan(0);
      for (const t of templates) {
        expect(t.datname).toMatch(PG_TEMPLATE_NAME);
        expect([t.datistemplate, t.datallowconn]).toEqual([true, false]);
      }
    } finally {
      await db.drop();
    }
    expect(await stateOf(db.name)).toBeNull();
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  it("the verify on the clone names a migration the clone does not carry", async () => {
    const db = throwawayDb("tf_tpl_short");
    try {
      await db.createFromTemplate();
      const client = postgres(db.url, { max: 1, onnotice: () => {} });
      try {
        await client.unsafe(`DELETE FROM drizzle_cloud.__drizzle_migrations
          WHERE id = (SELECT max(id) FROM drizzle_cloud.__drizzle_migrations)`);
      } finally {
        await client.end({ timeout: 5 });
      }
      expect(await pgJournalMismatch(db.url)).toMatch(/^cloud: .* not applied: \d+/);
    } finally {
      await db.drop();
    }
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  it("a mismatch drops the clone and the template and rebuilds once; the rebuild is what stays", async () => {
    const salt = [`test:${randomBytes(6).toString("hex")}`];
    const name = target("rebuilt");
    const said: string[] = [];
    let asked = 0;
    const verify = async (url: string) => (asked++ === 0 ? "planted: first read disagrees" : pgJournalMismatch(url));
    try {
      const tpl = await cloneFromTemplate(PG_TEST_URL, name, { say: (l) => said.push(l), verify, salt });
      salted.push(tpl);
      expect(asked).toBe(2);
      expect(said.filter((l) => /\bbuilding\b/.test(l))).toHaveLength(2);
      expect(said.some((l) => l.includes("planted: first read disagrees") && l.includes("rebuilding once"))).toBe(true);
      expect(await stateOf(tpl)).toEqual({ datistemplate: true, datallowconn: false });
      expect(await stateOf(name)).not.toBeNull();
    } finally {
      await admin((sql) => sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    }
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  it("a second mismatch throws by name and leaves neither the clone nor the template", async () => {
    const salt = [`test:${randomBytes(6).toString("hex")}`];
    const name = target("refused");
    const said: string[] = [];
    const thrown = await cloneFromTemplate(PG_TEST_URL, name, {
      say: (l) => said.push(l), verify: async () => "planted: always disagrees", salt,
    }).then(() => null, (e: unknown) => e);
    expect(String((thrown as Error)?.message)).toMatch(/failed its verify twice/);
    expect(await stateOf(name)).toBeNull();
    const built = said.map((l) => /building (trafficflow_tpl_[0-9a-f]{16})/.exec(l)?.[1]).filter(Boolean) as string[];
    expect(built).toHaveLength(2);
    expect(await stateOf(built[0]!)).toBeNull();
  }, MIGRATED_DB_SETUP_BUDGET_MS);
});
