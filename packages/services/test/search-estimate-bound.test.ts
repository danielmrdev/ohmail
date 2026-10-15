import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { messageBodies } from "@trafficflow/db";
import { SearchService } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * "ABOUT N MATCHED" NEVER EXCEEDS THE MAILBOX (SEARCH-ABOUT-COUNT-PAST-THE-MAILBOX). A cut arm's
 * estimate is the planner's rows for a join, which can exceed the table it reads: an "about N" past
 * the store's own size on the desktop and on the self-hosted server alike. The
 * estimate is now bounded by the planner's reading of the mailbox under the same filters, asked in the
 * arms' one plan. The planner answers here with those figures, so the bound is exercised at a size a
 * test can seed; `estimate-rows-each.test.ts` reads the one plan against the real planner.
 */
const MAILBOX_READING = 74_003;
let armReading = 75_054;
let calls: string[][] = [];
vi.mock("@trafficflow/db/dialect", async (importOriginal) => {
  const m = await importOriginal<typeof import("@trafficflow/db/dialect")>();
  const text = (st: SQL) => new PgDialect().sqlToQuery(st).sql;
  return {
    ...m,
    dialect: (db: unknown) => {
      const d = m.dialect(db);
      if (d.name !== "pg") return d;
      // A statement over the search document is an arm's; the mailbox's reads no document.
      const estimateRowsEach = async (_db: unknown, sts: readonly SQL[]): Promise<Array<number | null>> => {
        calls.push(sts.map(text));
        return sts.map((st) => (/message_search/.test(text(st)) ? armReading : MAILBOX_READING));
      };
      return { ...d, search: { ...d.search, estimateRowsEach } };
    },
  };
});

const TERM = "kingfisher";

async function corpus() {
  const { db, ctx, accountId, mailboxId } = await makeCtx();
  for (let i = 0; i < 30; i++) {
    const id = await seedMessage(db, accountId, mailboxId, { subject: `${TERM} report ${i}`, date: new Date(Date.parse("2026-07-01T09:00:00Z") + i * 3_600_000) });
    await db.insert(messageBodies).values({ messageId: id, text: `a ${TERM} at the weir, number ${i}` });
  }
  return ctx;
}

describe("the estimate is bounded by the mailbox it counts in", () => {
  it("a cut arm whose planner reading exceeds the mailbox answers about the mailbox's reading", async () => {
    const ctx = await corpus();
    armReading = 75_054;
    calls = [];
    const e = await new SearchService().search(ctx, { q: TERM, parts: "estimate", limit: 2 });
    expect(e.totalExact, "two a page cuts every arm under the thirty that match").toBe(false);
    expect(calls, "one plan for every cut arm and the mailbox").toHaveLength(1);
    expect(calls[0]!.length, "the cut arms, then the mailbox").toBeGreaterThan(1);
    expect(calls[0]!.at(-1), "the mailbox's statement reads no document").not.toMatch(/message_search/);
    expect(e.totalEstimate).toBe(MAILBOX_READING);
  });

  it("the control: a cut arm under the mailbox's reading keeps its own estimate", async () => {
    const ctx = await corpus();
    armReading = 40_000;
    const e = await new SearchService().search(ctx, { q: TERM, parts: "estimate", limit: 2 });
    expect(e.totalExact).toBe(false);
    expect(e.totalEstimate).toBe(40_000);
  });
});
