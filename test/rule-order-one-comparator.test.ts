import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { span, withoutComments, withoutCommentsAndLiterals } from "../scripts/lib/source-scan.mjs";

/**
 * ONE ORDER OVER RULES, AND BOTH DOORS IMPORT IT.
 *
 * The router ranked a sender's rules by `compareRules` while the clients' consent index ranked
 * them newest-created first, so one sender's mail was filed one way and presented another. The
 * order now lives in `packages/core/src/rule-order.ts`; this walks every product source root for a
 * second statement of it, and reads the two consumers for the import and the CALL (comments are
 * blanked first, so a docblock naming the comparator satisfies nothing).
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const LEAF = "packages/core/src/rule-order.ts";
const ROOTS = ["apps", "packages"];
const SKIP = new Set(["node_modules", "dist", "build", "test", "tests", ".next", "android", "ios", "src-tauri"]);

function sources(): { file: string; src: string }[] {
  const out: { file: string; src: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (SKIP.has(e) || e.startsWith(".")) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts)$/.test(e) && !/\.(test|spec)\.tsx?$/.test(e)) out.push({ file: relative(REPO, p), src: withoutCommentsAndLiterals(readFileSync(p, "utf8")) });
    }
  };
  for (const r of ROOTS) walk(join(REPO, r));
  return out;
}

/** A declaration of the comparator or one of its rank tables. */
const DECLARES = /\b(?:function|const|let|var)\s+(compareRules|EFFECT_RANK|KIND_RANK|PROVENANCE_RANK)\b/g;

const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

/** The body of the function a marker opens, read with comments and literals blanked. */
function bodyOf(src: string, marker: string): string {
  const blank = withoutCommentsAndLiterals(src);
  const at = blank.indexOf(marker);
  expect(at, `${marker} not found`).toBeGreaterThan(-1);
  const [start, end] = span(blank, blank.indexOf("{", blank.indexOf(")", at)), "{", "}");
  return blank.slice(start, end);
}

describe("the order over rules has one statement, and the router and the clients both read it", () => {
  it("is declared in the leaf and nowhere else in any product source root", () => {
    expect(existsSync(join(REPO, LEAF)), `${LEAF} is missing`).toBe(true);
    const all = sources();
    // A walk that found nothing passes every assertion under it: the count comes first.
    expect(all.length).toBeGreaterThan(500);
    const found: string[] = [];
    for (const { file, src } of all) for (const m of src.matchAll(DECLARES)) found.push(`${file}: ${m[1]}`);
    expect(found.sort()).toEqual([
      `${LEAF}: EFFECT_RANK`, `${LEAF}: KIND_RANK`, `${LEAF}: PROVENANCE_RANK`, `${LEAF}: compareRules`,
    ]);
  });

  it("the router imports it and its two winners call it", () => {
    const rules = read("packages/core/src/rules.ts");
    expect(withoutComments(rules)).toMatch(/import\s*\{[^}]*\bcompareRules\b[^}]*\}\s*from\s*"\.\/rule-order\.js"/);
    expect(bodyOf(rules, "export function standingRule("), "standingRule does not rank by the shared order")
      .toMatch(/\bcompareRules\(/);
    // The winner is the one claim seam's, and that seam ranks by the shared order.
    expect(bodyOf(rules, "function winningRule("), "winningRule does not take the shared claim").toMatch(/\bplacingRule\(/);
    const order = withoutComments(read("packages/core/src/rule-order.ts"));
    const seam = order.slice(order.indexOf("export function placingRule<"));
    expect(seam.slice(0, seam.indexOf("\nexport ", 1) > 0 ? seam.indexOf("\nexport ", 1) : undefined),
      "placingRule does not rank by the shared order").toMatch(/\bcompareRules\(/);
  });

  it("the client's consent index and decision import it, call it, and read no instant", () => {
    const src = read("packages/client-engine/src/consent-cutline.ts");
    expect(withoutComments(src)).toMatch(/import\s*\{[^}]*\bcompareRules\b[^}]*\}\s*from\s*"@trafficflow\/core\/rule-order"/);
    expect(bodyOf(src, "function outranks(")).toMatch(/\bcompareRules\(/);
    for (const name of ["consentIndex", "decidedDestination"]) {
      const body = bodyOf(src, `export function ${name}(`);
      expect(body, `${name} does not rank by the shared order`).toMatch(/\boutranks\(/);
      expect(body, `${name} reads an instant`).not.toMatch(/createdAt|updatedAt|Date\.parse/);
    }
  });
});
