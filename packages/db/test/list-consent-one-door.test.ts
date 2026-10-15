import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * ONLY A PERSON'S PRESS CONSENTS A BRAND UNDER A LIST ADDRESS (mail 0150). `consented_brands` is
 * written by two functions in `src/list-addresses.ts`: the press's consent and the reset's forget.
 * The press (`screener-apply.ts`) is the one caller of the first, the consent reset the one caller
 * of the second, so Not junk, the Sent seed, the act and every pass write no consent by
 * construction. Exact-set equality over product source with comments blanked: a new caller is red,
 * and so is a walk that stopped seeing the callers it is defined by.
 */

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", "dist", "test", "tests", "__tests__", ".next", "coverage"]);
const path = (...p: string[]) => p.join(sep);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if ((name.endsWith(".ts") || name.endsWith(".tsx")) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

function sources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const bucket of ["packages", "apps"]) {
    for (const name of readdirSync(join(REPO, bucket))) {
      for (const sub of ["src", "app"]) {
        const root = join(REPO, bucket, name, sub);
        try { if (!statSync(root).isDirectory()) continue; } catch { continue; }
        for (const file of walk(root)) out.set(relative(REPO, file), withoutComments(readFileSync(file, "utf8")));
      }
    }
  }
  return out;
}

const callersOf = (code: Map<string, string>, fn: string) => [...code]
  .filter(([, src]) => new RegExp(`(?<!function )\\b${fn}\\(`).test(src)).map(([f]) => f).sort();

describe("the brands consented under a list address have one writer each way", () => {
  const code = sources();

  it("the press is the one caller of the consent, and the reset the one caller of the forget", () => {
    expect(callersOf(code, "consentListBrands")).toEqual([path("packages", "db", "src", "screener-apply.ts")]);
    expect(callersOf(code, "forgetListConsents")).toEqual([path("packages", "services", "src", "consent-reset.ts")]);
  });

  it("no other product file writes the column, by key or by raw SQL", () => {
    // A `consentedBrands:` key is a `.set`/`.values` write or the schema's own definition; a read by
    // property (`knownSenders`' one statement) is no key. Raw SQL spells the column: the schema
    // twins and the generated device journal define it, `/health` probes it, and the Screener's
    // person skip reads it (a brand consented under a list address).
    expect([...code].filter(([, src]) => /\bconsentedBrands\s*:/.test(src)).map(([f]) => f).sort()).toEqual([
      path("packages", "db", "src", "list-addresses.ts"),
      path("packages", "db", "src", "schema-mail-sqlite.ts"),
      path("packages", "db", "src", "schema-mail.ts"),
    ]);
    expect([...code].filter(([, src]) => src.includes("consented_brands")).map(([f]) => f).sort()).toEqual([
      path("packages", "api", "src", "routes", "health-markers.ts"),
      path("packages", "db-mail", "src", "sqlite-journal.ts"),
      path("packages", "db", "src", "schema-mail-sqlite.ts"),
      path("packages", "db", "src", "schema-mail.ts"),
      path("packages", "db", "src", "screener-cutline.ts"),
    ]);
  });

  it("CONTROL: the walk reads the tree it claims to (the Screener's own decide is in it)", () => {
    expect(code.size).toBeGreaterThan(500);
    expect(code.has(path("packages", "api", "src", "junk-window.ts"))).toBe(true);
    expect(code.has(path("packages", "services", "src", "consent-seed.ts"))).toBe(true);
  });
});
