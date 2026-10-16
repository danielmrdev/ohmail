import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SWEPT_ROOTS, TEST_ROOTS } from "../scripts/lib/comment-blocks.mjs";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A CAST CANNOT KEEP A STALE DOUBLE COMPILING
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured 2026-09-15, three instances in one day. A partial test double kept compiling by
 * `as unknown as <ProductType>` is a guard saying nothing: the cast hides the missing members from
 * the typecheck, so the product gains a member, the double does not, nothing says a word, and the
 * case throws `… is not a function` at runtime — against a double that was written to prove the
 * opposite. The remedy is to TYPE the instance and let the compiler name what is missing.
 *
 * WHICH CASTS. Not all of them: thousands of `as unknown as` expressions live in the test roots, and a
 * census that refuses thousands of sites refuses the whole directory and gets deleted. The class is the
 * one the defect is about — a type from a product package's CHROME or CONTRACT surface, which is
 * exactly what a double stands in for. That is 32 type names and, at this tip, 2 casts.
 *
 * `typeof fetch`, `Record<string, unknown>`, a local test type and a node built-in are not this
 * subject: nobody writes a partial double of `typeof fetch` and expects the compiler to have
 * checked it.
 *
 * THE TWO LISTS. `ALLOWED` is deliberate wire-shape casts, by file:line with a reason; an entry
 * matching no cast REFUSES, because a list that admits nothing and reads as though it did is how
 * every allow-list in this repository has rotted. `OWED` is what stood here when this census was
 * written, by FILE with a count — a ratchet that may only fall, so the two sites can be typed by
 * the lanes that own them without this file reddening their landing.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * THE SURFACE A DOUBLE STANDS IN FOR. A `*Chrome` interface is a component's injected-dependency
 * surface — the one thing a test supplies by hand — and a DTO or contract module is the shape two
 * halves of the product agree on. Both are named here rather than pinned as a list of type names,
 * so a new surface type joins the census by being declared, not by somebody remembering.
 */
export function isSurfaceDeclaration(file: string, typeName: string): boolean {
  const base = file.split("/").pop() ?? "";
  return /(^|[-.])dto\.ts$/.test(base) || /contract/i.test(base) || /Chrome$/.test(typeName);
}

function walk(rel: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(join(ROOT, rel)); } catch { return out; }
  for (const name of entries) {
    const next = `${rel}/${name}`;
    if (statSync(join(ROOT, next)).isDirectory()) {
      if (name !== "node_modules") walk(next, out);
    } else if (/\.(ts|tsx)$/.test(name)) out.push(next);
  }
  return out;
}

function parse(rel: string, text?: string): ts.SourceFile {
  return ts.createSourceFile(
    rel, text ?? readFileSync(join(ROOT, rel), "utf8"), ts.ScriptTarget.Latest, true,
    /\.tsx$/.test(rel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Every surface type name a product source root exports, with the file that declares it. */
export function surfaceTypes(roots: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const root of roots) {
    for (const file of walk(root)) {
      const sf = parse(file);
      sf.forEachChild((node) => {
        const exported = (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [])
          .some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (!exported) return;
        if (!ts.isTypeAliasDeclaration(node) && !ts.isInterfaceDeclaration(node)
            && !ts.isClassDeclaration(node) && !ts.isEnumDeclaration(node)) return;
        if (node.name === undefined) return;
        const name = node.name.text;
        if (isSurfaceDeclaration(file, name) && !found.has(name)) found.set(name, file);
      });
    }
  }
  return found;
}

export type Cast = { file: string; line: number; type: string };

/**
 * The `as unknown as T` casts in one file whose T names a surface type. A real parse, never a
 * scanner: `as unknown as` inside a string or a comment is not a cast, and a scanner cannot tell.
 */
export function castsIn(file: string, surface: ReadonlySet<string>, text?: string): Cast[] {
  const sf = parse(file, text);
  const hits: Cast[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) && ts.isAsExpression(node.expression)
        && node.expression.type.kind === ts.SyntaxKind.UnknownKeyword
        && ts.isTypeReferenceNode(node.type)) {
      const name = node.type.typeName.getText(sf).split(".")[0];
      if (surface.has(name)) {
        /* The line of the TYPE, not of the expression: `} as unknown as RemoteImagesChrome;` is
           what a reader greps for, and the expression starts wherever the object literal opened. */
        hits.push({ file, line: sf.getLineAndCharacterOfPosition(node.type.getStart(sf)).line + 1, type: name });
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return hits;
}

/** Deliberate wire-shape casts, by `file:line`, each with the reason it is not a partial double. */
export const ALLOWED: Record<string, string> = {};

/**
 * What stood here when this census was written. A CEILING per file, never a
 * target: both are the sites kit row 188 names, and both are owed to the lanes that own those
 * files. The count may fall and may not rise, so typing them closes the row without reddening
 * anybody's landing, and a NEW one in this class is refused outright.
 */
export const OWED: Record<string, number> = {
  "apps/webapp/test/tracking-notice.test.tsx": 1,
  ["apps/" + "admin/test/alerts-unavailable-surfaces.test.ts"]: 1,
};

const SURFACE = surfaceTypes(SWEPT_ROOTS);
const ALL: Cast[] = TEST_ROOTS.flatMap((r) => walk(r)).flatMap((f) => castsIn(f, new Set(SURFACE.keys())));

describe("a cast cannot keep a stale double compiling", () => {
  it("reads a real surface: the chrome and contract types a double stands in for", () => {
    expect(SURFACE.size, "no surface types at all — the census would be green over everything").toBeGreaterThan(5);
    expect([...SURFACE.keys()]).toContain("RemoteImagesChrome");
    expect([...SURFACE.keys()]).toContain("OverviewSnapshot");
    /* And it is NARROW. Thousands of `as unknown as` expressions live in these roots; a census that
       refuses all of them refuses the directory and is deleted within the week. */
    expect(ALL.length, "the class has widened — re-measure before letting it refuse").toBeLessThan(40);
  });

  it("refuses a cast of a surface type that is neither allowed nor owed", () => {
    const owedCount = new Map<string, number>();
    const strays: string[] = [];
    for (const c of ALL) {
      if (ALLOWED[`${c.file}:${c.line}`] !== undefined) continue;
      if (OWED[c.file] !== undefined) { owedCount.set(c.file, (owedCount.get(c.file) ?? 0) + 1); continue; }
      strays.push(`${c.file}:${c.line}: as unknown as ${c.type}`);
    }
    expect(
      strays,
      "a partial double kept compiling by a cast to a product surface type. The cast hides the " +
        "missing members from the typecheck, so the case throws at runtime against a double written " +
        "to prove the opposite — TYPE the instance, or add the site to ALLOWED with its reason: ",
    ).toEqual([]);
    /* The ratchet: a file may lose these and may not gain them. */
    const risen = Object.entries(OWED)
      .filter(([f, pin]) => (owedCount.get(f) ?? 0) > pin)
      .map(([f, pin]) => `${f}: ${pin} -> ${owedCount.get(f)}`);
    expect(risen, "an owed file gained a cast of this class").toEqual([]);
    for (const [f, pin] of Object.entries(OWED)) {
      const now = owedCount.get(f) ?? 0;
      if (now < pin) console.log(`cast-hides-a-stale-double: ${f} ${pin} -> ${now} — lower the OWED pin`);
    }
  });

  it("an ALLOWED entry that matches no cast is refused: a list that admits nothing reads as though it did", () => {
    const real = new Set(ALL.map((c) => `${c.file}:${c.line}`));
    const stale = Object.keys(ALLOWED).filter((k) => !real.has(k));
    expect(stale, "an allow-list entry naming no cast of this class").toEqual([]);
    for (const [k, why] of Object.entries(ALLOWED)) expect(why.length, `${k} has no reason`).toBeGreaterThan(20);
  });

  it("a planted cast is found, by file and line, and a cast to something else is not", () => {
    /* The control, over the same reader the census runs. A fixture rather than a real file: a
       census whose own arm mutates the tree is a census that leaves the tree mutated. */
    const surface = new Set(["RemoteImagesChrome"]);
    const planted = [
      "const chrome = {",
      "  auto: false,",
      "} as unknown as RemoteImagesChrome;",
      "const f = (() => {}) as unknown as typeof fetch;",
      "const s = \"x as unknown as RemoteImagesChrome\";",
    ].join("\n");
    const hits = castsIn("apps/" + "webapp/test/fixture.ts", surface, planted);
    expect(hits.map((h) => `${h.file}:${h.line}:${h.type}`))
      .toEqual(["apps/" + "webapp/test/fixture.ts:3:RemoteImagesChrome"]);
    /* And the allow-list admits its own entry: keyed on file:line, which is what a reader checks. */
    const allow = { ["apps/" + "webapp/test/fixture.ts:3"]: "the wire shape arrives untyped from the server" };
    expect(hits.filter((h) => allow[`${h.file}:${h.line}` as keyof typeof allow] === undefined)).toEqual([]);
  });
});
