import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE ONE-SPELLING CENSUS for the read-state intent.
 *
 * `upsertDesiredSeen` (`src/flag-intent.ts`) is the single writer of the user's `\Seen` INTENT.
 * It had three spellings once — the module, plus inline twins in the Screener's
 * mark-read-on-dismiss and the worker's read-state retro pass — and three spellings of one
 * upsert is three answers to when a `\Seen` round trip is owed: the twins were documented as
 * twins, and one of them (`bubbleUpPass`'s) had already quietly ceased to exist while its
 * documentation lived on. This census makes the re-unification stick: every `insert(flagState)`
 * in product source must be one of the two named writers below, so the next feature that wants
 * to write read state finds the door instead of building one.
 *
 *  · `packages/db/src/flag-intent.ts` — the INTENT writer (desired side; observed preserved).
 *  · `packages/core/src/adapters/drizzle-repo.ts` — the worker's CONVERGENCE writer
 *    (`upsertFlagState`: desired AND observed together, backoff reset). A different contract,
 *    deliberately not this module — see flag-intent.ts's header.
 *
 * ── WHY EXACT-SET EQUALITY, NOT "NOTHING OUTSIDE THE ALLOWLIST" ─────────────────────────────
 *
 * A scanner that finds nothing is green, and a broken scanner finds nothing. Asserting the
 * found set EQUALS the allowlist means a regression in the walk or the needle goes red on the
 * two files that are known to contain the call — the census cannot be vacuously green.
 *
 * Scope: `packages/*\/src` and `apps/*\/src` plus `apps/webapp/app` — product source only.
 * Tests may hand-write `flag_state` rows to stage fixtures; they are not writers of record.
 */

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

/** The needle: a drizzle insert against the flag_state table. Prose never spells it with the dot. */
const NEEDLE = ".insert(flagState)";

const ALLOWED = new Set([
  ["packages", "db", "src", "flag-intent.ts"].join(sep),
  ["packages", "core", "src", "adapters", "drizzle-repo.ts"].join(sep),
]);

const SKIP_DIRS = new Set(["node_modules", "dist", "test", "tests", "__tests__", ".next", "coverage"]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) continue;
      yield p;
    }
  }
}

function rootsOf(): string[] {
  const roots: string[] = [];
  for (const bucket of ["packages", "apps"]) {
    for (const name of readdirSync(join(REPO, bucket))) {
      for (const sub of ["src", "app"]) {
        const p = join(REPO, bucket, name, sub);
        try {
          if (statSync(p).isDirectory()) roots.push(p);
        } catch {
          /* no such subdir — fine */
        }
      }
    }
  }
  return roots;
}

describe("the read-state intent has ONE spelling", () => {
  it("every .insert(flagState) in product source is one of the two named writers", () => {
    const found = new Set<string>();
    for (const root of rootsOf()) {
      for (const file of walk(root)) {
        if (readFileSync(file, "utf8").includes(NEEDLE)) {
          found.add(relative(REPO, file));
        }
      }
    }
    // Exact-set equality: a new inline twin is red, and so is a scanner that stopped seeing
    // the two writers it is defined by.
    expect([...found].sort()).toEqual([...ALLOWED].sort());
  });
});
