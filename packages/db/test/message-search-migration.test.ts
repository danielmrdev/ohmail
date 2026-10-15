import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PgDialect } from "drizzle-orm/pg-core";
import { HOT_PATH_INDEX_SPECS } from "../src/hot-path-indexes.js";
import { HISTORY_ORDER_PREBUILD_SPEC, TRIGRAM_INDEX_SPECS } from "../src/search-setup.js";

/**
 * MAIL 0125's HISTORY INDEX HAS THREE SPELLINGS AND THEY ARE ONE INDEX: the hot-path build after
 * the migrator, the prebuild ahead of it (0071's pattern), and the journal statement a PGlite store
 * replays. A drift between them is two indexes under one name — the `if not exists` would keep
 * whichever came first, and the plan the History page was measured on would not be the one served.
 */
const MIGRATION = fileURLToPath(new URL("../../db-mail/drizzle/0125_message_search.sql", import.meta.url));
const render = (spec: { ddl: Parameters<PgDialect["sqlToQuery"]>[0] }): string =>
  new PgDialect().sqlToQuery(spec.ddl).sql;
const canon = (s: string): string => s.replace(/\bconcurrently\s+/i, "").replace(/\s+/g, " ").trim().replace(/;$/, "").toLowerCase();

describe("mail 0125's History index is one index", () => {
  const hot = HOT_PATH_INDEX_SPECS.find((s) => s.name === "messages_account_msg_order_idx");
  const journal = readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint")
    .map((s) => s.replace(/^\s*--[^\n]*\n/gm, "").trim())
    .find((s) => s.includes("messages_account_msg_order_idx"));

  it("finds all three spellings", () => {
    expect(hot).toBeDefined();
    expect(journal).toBeDefined();
    expect(render(HISTORY_ORDER_PREBUILD_SPEC)).toMatch(/concurrently/i);
  });

  it("the hot-path spec, the prebuild and the journal statement agree, minus CONCURRENTLY", () => {
    expect(canon(render(HISTORY_ORDER_PREBUILD_SPEC))).toBe(canon(render(hot!)));
    expect(canon(journal!)).toBe(canon(render(hot!)));
  });

  it("the comparison can tell them apart — a different column order is refused", () => {
    expect(canon(journal!.replace('"date" desc nulls last,"id" desc', '"id" desc,"date" desc nulls last')))
      .not.toBe(canon(render(hot!)));
  });

  it("the header corpus's trigram index is built beside the other two, concurrently", () => {
    const terms = TRIGRAM_INDEX_SPECS.find((s) => s.name === "message_search_terms_trgm_idx");
    expect(terms?.table).toBe("message_search");
    expect(render(terms!)).toMatch(/concurrently if not exists "message_search_terms_trgm_idx"[\s\S]*gin_trgm_ops/);
  });
});
