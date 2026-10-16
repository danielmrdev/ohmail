import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { pgDialect } from "../src/dialect/pg.js";
import { sqliteDialect } from "../src/dialect/sqlite.js";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * EVERY SETTING ON THE SEARCH PATH IS TRANSACTION-LOCAL. The hosted API reaches Postgres through a
 * transaction pooler: a session-level SET outlives the request on a backend the next account's
 * request is handed, so a typo threshold or a planner switch would leak across accounts. The
 * search session's statement is rendered for every option it takes, and the search path's
 * sources are read for any setting spelled another way.
 */
const ROOT = join(import.meta.dirname, "../../..");
const SEARCH_PATH = [
  "packages/db/src/dialect/pg.ts",
  "packages/db/src/dialect/sqlite.ts",
  "packages/services/src/search-service.ts",
  "packages/services/src/kb-service.ts",
  "packages/services/src/store-probe.ts",
  "packages/services/src/settings-first.ts",
];

/** Why a text sets something beyond its transaction, or `null` when every setting is local. */
function sessionLevel(text: string): string | null {
  for (const m of text.matchAll(/set_config\s*\(/gi)) {
    let depth = 1;
    let at = m.index! + m[0].length;
    const args: string[] = [""];
    for (; at < text.length && depth > 0; at++) {
      const c = text[at]!;
      if (c === "(") depth++;
      if (c === ")") depth--;
      if (depth === 1 && c === ",") args.push("");
      else if (depth > 0) args[args.length - 1] += c;
    }
    if (args.length !== 3 || args[2]!.trim().toLowerCase() !== "true") return `set_config(${args.join(",")})`;
  }
  const bare = /\bset\s+(?!local\b)(?:session\s+)?[a-z_][a-z0-9_.]*\s*(?:=|\bto\b)/i.exec(text);
  return bare ? bare[0] : null;
}

describe("the search path sets nothing past its transaction", () => {
  it("the rule reads the four shapes it exists for", () => {
    expect(sessionLevel("select set_config('enable_seqscan', 'off', false) as s0")).not.toBeNull();
    expect(sessionLevel("select set_config('enable_seqscan', 'off')")).not.toBeNull();
    expect(sessionLevel("set enable_seqscan = off")).not.toBeNull();
    expect(sessionLevel("SET SESSION pg_trgm.word_similarity_threshold TO 0.3")).not.toBeNull();
    expect(sessionLevel("select set_config('enable_seqscan', 'off', true) as s0")).toBeNull();
    expect(sessionLevel("set local enable_seqscan = off")).toBeNull();
    expect(sessionLevel("known.set(accountId); sets.push(x)")).toBeNull();
  });

  it("the search session's statement, for every option it takes, is local", () => {
    const render = (s: ReturnType<ReturnType<typeof pgDialect>["search"]["searchSession"]>): string =>
      s === null ? "" : new PgDialect().sqlToQuery(s).sql;
    let rendered = 0;
    for (const typoThreshold of [undefined, 0, 0.3, 1]) {
      for (const preferIndexes of [undefined, false, true]) {
        const opts = { ...(typoThreshold !== undefined ? { typoThreshold } : {}), ...(preferIndexes !== undefined ? { preferIndexes } : {}) };
        const text = render(pgDialect().search.searchSession(opts));
        if (text !== "") rendered++;
        expect(sessionLevel(text), `${JSON.stringify(opts)}: ${text}`).toBeNull();
        expect(sqliteDialect().search.searchSession(opts)).toBeNull();
      }
    }
    expect(rendered).toBeGreaterThanOrEqual(8);
  });

  it("no source on the search path spells a session-level setting", () => {
    let sites = 0;
    for (const rel of SEARCH_PATH) {
      const text = withoutComments(readFileSync(join(ROOT, rel), "utf8"));
      sites += [...text.matchAll(/set_config\s*\(/gi)].length;
      expect(sessionLevel(text), rel).toBeNull();
    }
    // The two settings the dialect composes are read here, or this census read nothing.
    expect(sites).toBeGreaterThanOrEqual(2);
  });
});
