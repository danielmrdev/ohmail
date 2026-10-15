/**
 * THE HERMES INTL CENSUS — the phone's JavaScript runs on Hermes, which ships `Intl.Collator`,
 * `DateTimeFormat`, `NumberFormat` and `PluralRules` and NOT `RelativeTimeFormat`, `ListFormat`,
 * `Segmenter`, `DisplayNames`, `Locale` or `DurationFormat`. An unguarded `new` on one of those is
 * a data-dependent crash: on 2026-09-21 the receipts day heading reached `Intl.RelativeTimeFormat`
 * the day a receipt arrived and every iOS launch died in `WorldProvider`. Every such `new` — named
 * directly or through a local alias, the shape the fix ships — must sit in a function that asked
 * `typeof` for it first, in VALUE position: `typeof Intl.X` inside a type annotation reads as a
 * guard to any text search and guards nothing, so this reads the syntax tree instead.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const REPO = path.resolve(__dirname, "..", "..", "..");
const ROOTS = ["packages/client-engine/src", "packages/core/src", "apps/mobile/src", "apps/mobile/app"];
const MISSING = ["RelativeTimeFormat", "ListFormat", "Segmenter", "DisplayNames", "Locale", "DurationFormat"];

/** `via` is `"Intl"` where the constructor is named outright, else the local alias it came through. */
export interface IntlHit { file: string; line: number; name: string; guarded: boolean; via: string }

/** Past the parentheses and casts that `(Intl as { … }).X` and `new (X as T)()` wrap things in. */
function unwrap(node: ts.Node): ts.Node {
  let n = node;
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)) n = n.expression;
  return n;
}

/** The name of the missing constructor `expr` reads off `Intl`, or null. */
function missingOf(expr: ts.Node): string | null {
  const e = unwrap(expr);
  if (!ts.isPropertyAccessExpression(e)) return null;
  const base = unwrap(e.expression);
  if (!ts.isIdentifier(base) || base.text !== "Intl") return null;
  return MISSING.includes(e.name.text) ? e.name.text : null;
}

/** Local names bound to a missing constructor: `const Rtf = (Intl as …).X` and `const { X } = Intl`. */
function aliasesIn(sf: ts.SourceFile): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      if (ts.isIdentifier(n.name)) {
        const name = missingOf(n.initializer);
        if (name) found.set(n.name.text, name);
      } else if (ts.isObjectBindingPattern(n.name)) {
        const base = unwrap(n.initializer);
        if (ts.isIdentifier(base) && base.text === "Intl") {
          for (const el of n.name.elements) {
            const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text
              : ts.isIdentifier(el.name) ? el.name.text : null;
            if (prop && MISSING.includes(prop) && ts.isIdentifier(el.name)) found.set(el.name.text, prop);
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** A `typeof <needle>` in value position inside `scope`, standing before position `at`. */
function asksTypeof(scope: ts.Node, at: number, needles: string[]): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isTypeOfExpression(n) && n.getStart() < at && needles.includes(unwrap(n.expression).getText())) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

/** Every `new` on a constructor Hermes lacks in `source`, with whether its function guards it. */
export function intlConstructors(source: string, file = "fixture.ts"): IntlHit[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const alias = aliasesIn(sf);
  const hits: IntlHit[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const callee = unwrap(node.expression);
      let name = missingOf(callee);
      let via = "Intl";
      if (!name && ts.isIdentifier(callee) && alias.has(callee.text)) { name = alias.get(callee.text) ?? null; via = callee.text; }
      if (name) {
        let scope: ts.Node = node;
        while (scope.parent && !ts.isFunctionLike(scope)) scope = scope.parent;
        const needles = via === "Intl" ? [`Intl.${name}`] : [via, `Intl.${name}`];
        hits.push({
          file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, name, via,
          guarded: asksTypeof(scope, node.getStart(), needles),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(full, out); }
    else if (/\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(full);
  }
  return out;
}

describe("hermes-intl-census — no unguarded Intl constructor Hermes lacks, in the phone's closure", () => {
  it("refuses an unguarded `new Intl.RelativeTimeFormat` (the 2026-09-21 shape)", () => {
    const hits = intlConstructors(`function dayLabel(l: string) { return new Intl.RelativeTimeFormat(l, { numeric: "auto" }).format(0, "day"); }`);
    expect(hits).toEqual([{ file: "fixture.ts", line: 1, name: "RelativeTimeFormat", via: "Intl", guarded: false }]);
  });
  it("admits the same constructor behind a typeof guard in the same function", () => {
    const hits = intlConstructors(`function dayLabel(l: string) {\n  if (typeof Intl.RelativeTimeFormat !== "function") return "Monday";\n  return new Intl.RelativeTimeFormat(l).format(0, "day");\n}`);
    expect(hits.map((h) => h.guarded)).toEqual([true]);
  });
  it("a guard in ANOTHER function does not cover it", () => {
    const hits = intlConstructors(`function a() { return typeof Intl.ListFormat; }\nfunction b() { return new Intl.ListFormat("en"); }`);
    expect(hits.map((h) => [h.name, h.guarded])).toEqual([["ListFormat", false]]);
  });
  it("Intl constructors Hermes ships are not the census's business", () => {
    expect(intlConstructors(`const f = new Intl.DateTimeFormat("en"); const n = new Intl.NumberFormat("de");`)).toEqual([]);
  });
  it("refuses an unguarded LOCAL ALIAS of the constructor", () => {
    const src = `function today(l: string) {\n  const Rtf = (Intl as { RelativeTimeFormat?: unknown }).RelativeTimeFormat as typeof Intl.RelativeTimeFormat;\n  return new Rtf(l).format(0, "day");\n}`;
    expect(intlConstructors(src).map((h) => [h.name, h.via, h.guarded])).toEqual([["RelativeTimeFormat", "Rtf", false]]);
  });
  it("admits the alias behind a value-position typeof — the shape the fix ships", () => {
    const src = `function today(l: string) {\n  const Rtf = (Intl as { RelativeTimeFormat?: unknown }).RelativeTimeFormat;\n  if (typeof Rtf !== "function") return null;\n  return new (Rtf as typeof Intl.RelativeTimeFormat)(l, { numeric: "auto" }).format(0, "day");\n}`;
    expect(intlConstructors(src).map((h) => [h.name, h.via, h.guarded])).toEqual([["RelativeTimeFormat", "Rtf", true]]);
  });
  it("a typeof in TYPE position is not a guard — a text search would admit this one", () => {
    const src = `function today(l: string) {\n  const Rtf: typeof Intl.RelativeTimeFormat = (Intl as { RelativeTimeFormat: typeof Intl.RelativeTimeFormat }).RelativeTimeFormat;\n  return new Rtf(l).format(0, "day");\n}`;
    expect(src).toContain("typeof Intl.RelativeTimeFormat");
    expect(intlConstructors(src).map((h) => h.guarded)).toEqual([false]);
  });
  it("a destructured alias is an alias", () => {
    const src = `const { Segmenter } = Intl;\nexport function words(s: string) { return new Segmenter("en").segment(s); }`;
    expect(intlConstructors(src).map((h) => [h.name, h.via, h.guarded])).toEqual([["Segmenter", "Segmenter", false]]);
  });
  it("the tree: every hit is guarded, and the census reached the receipts selector", () => {
    const files = ROOTS.flatMap((r) => walk(path.join(REPO, r)));
    expect(files.length).toBeGreaterThan(200);
    const hits = files.flatMap((f) => intlConstructors(fs.readFileSync(f, "utf8"), path.relative(REPO, f)));
    const unguarded = hits.filter((h) => !h.guarded).map((h) => `${h.file}:${h.line} new ${h.via === "Intl" ? `Intl.${h.name}` : `${h.via} (alias of Intl.${h.name})`}`);
    expect(unguarded, `unguarded Intl constructors Hermes lacks:\n${unguarded.join("\n")}`).toEqual([]);
    // the positive control: the site that crashed is in the census and admitted for its guard
    expect(hits.some((h) => h.file === "packages/client-engine/src/selectors.ts" && h.name === "RelativeTimeFormat" && h.guarded)).toBe(true);
  });
});
