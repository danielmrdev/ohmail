import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { SearchService, type ServiceContext } from "@trafficflow/services";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { freshDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { seedTypoMailbox, typoOracle, TYPO_CASES, typoPages } from "../../../packages/services/test/_typo-read-fixture.js";

/**
 * THE TYPO READ ON PGlite, the server twin's fixture over the desktop's own store (pg_trgm and
 * btree_gin loaded): the server's search shape walks a dense typo, reads a sparse one off its GIN
 * and does both for one its walk holds too few of, and every relevance page equals the newest cut
 * of `q <% terms` ranked by similarity. `search-typo-read.pg.test.ts` reads which path ran.
 */
const svc = new SearchService();
let dir = "";
let o: OpenLocalDb;
let accountId = "";
const ctx = (): ServiceContext => ({ db: o.db, accountId, userId: null, now: () => new Date("2026-08-20T12:00:00Z"), requestId: "typo-local" }) as ServiceContext;

beforeAll(async () => {
  dir = await freshDataDir("ohmail-typo-read-");
  o = await openLocalDb(dir);
  const made = (await o.db.execute(sql`insert into accounts (name) values ('typo') returning id`)) as unknown as { rows: Array<{ id: string }> };
  accountId = made.rows[0]!.id;
  await seedTypoMailbox(o.db, accountId);
}, PGLITE_STANDUP_BUDGET_MS * 2);

afterAll(async () => {
  await o?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("the typo arm's read on the desktop's store (PGlite, pg_trgm)", () => {
  it.each(TYPO_CASES)("$q $filters: every relevance page equals the newest cut of the operator's matches", async ({ q, filters }) => {
    const want = await typoOracle(o.db, accountId, q, filters);
    const got = await typoPages(svc, ctx(), q, filters);
    expect(want.length, `${q}: the oracle found nothing, so the case measures nothing`).toBeGreaterThan(0);
    expect(got.tier).toBe("similar");
    expect(got.ids).toEqual(want);
  }, 60_000);
});
