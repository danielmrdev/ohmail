import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { GIN_PENDING_LIST_KB, openLocalDb, type OpenLocalDb } from "../src/db.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE SEARCH'S GIN PENDING LISTS STAY SMALL. The insert that overflows a GIN pending list merges it
 * inside its own transaction, so the list's size is how long one message's commit can hold the
 * store. Read from the server, and then as the effect: many trigram-heavy rows written one at
 * a time leave at most the bound's pages pending — at Postgres' 4 MB default they leave several
 * times that, all of it merged later by whichever insert tips it over.
 */
const dirs: string[] = [];
const open: OpenLocalDb[] = [];
afterAll(async () => {
  for (const h of open) await h.close().catch(() => undefined);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const first = (res: unknown): string => {
  const r = res as { rows?: Array<Record<string, unknown>> } & Array<Record<string, unknown>>;
  return String(Object.values((r.rows ?? r)[0] ?? {})[0]);
};

describe("the local store's GIN pending lists", () => {
  it("are bounded at GIN_PENDING_LIST_KB, so no commit merges more than that", async () => {
    const dir = await freshDataDir("ohmail-gin-pending-");
    dirs.push(dir);
    const h = await openLocalDb(dir);
    open.push(h);
    expect(first(await h.db.execute("show gin_pending_list_limit")), "the store opened with Postgres' 4 MB pending lists")
      .toBe(`${GIN_PENDING_LIST_KB}kB`);

    await h.db.execute("create table gin_probe (s text)");
    await h.db.execute("create index gin_probe_trgm on gin_probe using gin (s gin_trgm_ops)");
    for (let i = 0; i < 1000; i += 1) {
      const text = Array.from({ length: 40 }, (_, k) => ((i * 7919 + k * 104729) % 1_000_003).toString(36)).join(" ");
      await h.db.execute(`insert into gin_probe values ('${text}')`);
    }
    const pending = Number(first(await h.db.execute("select gin_clean_pending_list('gin_probe_trgm'::regclass)")));
    expect(pending, "the pending list grew past its bound: the commit that merges it holds the store")
      .toBeLessThanOrEqual(Math.ceil(GIN_PENDING_LIST_KB / 8) + 1);
  }, 120_000);
});
