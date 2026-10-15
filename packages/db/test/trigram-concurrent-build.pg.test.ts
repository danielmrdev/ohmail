import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { PgDialect } from "drizzle-orm/pg-core";
import { brandDialect } from "../src/dialect/index.js";
import { openMigrationSession, runMigrations } from "../src/migrate.js";
import { ensureSearchExtensions, TRIGRAM_INDEX_SPECS } from "../src/search-setup.js";
import { TRIGRAM_INDEXES } from "../src/setup-prod.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * the index half. `ensureSearchExtensions` runs on the live database over `messages`,
 * and built its two trigram indexes with a plain CREATE INDEX, which takes a SHARE lock and holds
 * every write for the length of the scan. A writer holding ROW EXCLUSIVE tells the two apart: a
 * plain build waits on the RELATION lock, a concurrent one is granted its lock and waits only on
 * the writer's transaction (`virtualxid`) — the state read from `pg_stat_activity` below.
 */
const PG_UP = await realPgAvailable();

let admin: ReturnType<typeof postgres>;
beforeAll(async () => {
  if (!PG_UP) return;
  admin = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
  await runMigrations(PG_TEST_URL);
}, 150_000);
afterAll(async () => { if (PG_UP) await admin.end({ timeout: 5 }); });

const validIndexes = async (): Promise<string[]> => {
  const rows = await admin<{ name: string }[]>`
    select c.relname as name from pg_index i join pg_class c on c.oid = i.indexrelid
     where i.indrelid in ('public.messages'::regclass, 'public.message_search'::regclass) and i.indisvalid
       and c.relname in ${admin(TRIGRAM_INDEXES as unknown as string[])} order by 1`;
  return rows.map((r) => r.name);
};

describe.skipIf(!PG_UP)("the trigram indexes are built without holding writes", () => {
  it("the build specs are exactly the indexes setup verifies, and each is CONCURRENT", () => {
    expect(TRIGRAM_INDEX_SPECS.map((s) => s.name).sort()).toEqual([...TRIGRAM_INDEXES].sort());
    const dialect = new PgDialect();
    for (const spec of TRIGRAM_INDEX_SPECS) {
      expect(dialect.sqlToQuery(spec.ddl).sql).toMatch(/^create index concurrently if not exists /);
    }
  });

  it("under a live writer the build waits on the writer's transaction, never on the table lock", async () => {
    for (const name of TRIGRAM_INDEXES) await admin.unsafe(`drop index concurrently if exists public."${name}"`);
    const writer = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    const appName = `trigram-build-${randomUUID().slice(0, 8)}`;
    const was = process.env.PGAPPNAME;
    process.env.PGAPPNAME = appName;
    const opening = openMigrationSession(PG_TEST_URL);
    if (was === undefined) delete process.env.PGAPPNAME; else process.env.PGAPPNAME = was;
    const session = await opening;
    try {
      const held = writer.begin(async (tx) => {
        await tx`lock table public.messages in row exclusive mode`;
        let waitEvent = "";
        const build = ensureSearchExtensions(brandDialect(drizzle(session.sql), "pg"));
        const until = Date.now() + 20_000;
        while (waitEvent === "" && Date.now() < until) {
          const [r] = await admin<{ ev: string | null }[]>`
            select max(wait_event) as ev from pg_stat_activity
             where datname = current_database() and application_name = ${appName}
               and wait_event_type = 'Lock'`;
          waitEvent = r?.ev ?? "";
          if (waitEvent === "") await new Promise((res) => setTimeout(res, 25));
        }
        return { waitEvent, build };
      });
      const { waitEvent, build } = await held;   // the writer's transaction ends here
      expect(waitEvent, "a plain CREATE INDEX waits on 'relation' behind the writer").toBe("virtualxid");
      await build;
      expect(await validIndexes()).toEqual([...TRIGRAM_INDEXES].sort());
    } finally {
      await writer.end({ timeout: 5 });
      await session.end();
    }
  }, 60_000);
});
