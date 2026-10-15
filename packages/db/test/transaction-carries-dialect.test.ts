import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A TRANSACTION THAT REACHES THE SEAM CARRIES ITS PARENT'S DIALECT — measured, because this class
 * has now cost two production paths and thirteen assertions.
 *
 * The seam refuses a handle with no dialect brand.
 *
 * ── THE PREMISE THIS WAS BUILT ON IS NOW FALSE, ON PURPOSE ────────────────────────────────
 *
 * It read: "a transaction object is built by the query builder and inherits nothing, so a block
 * that opens one and hands the raw parameter to anything that composes a statement through the seam
 * throws at the first such statement — in production, not in a build." That was true, and it cost
 * the two production paths named below.
 *
 * `brandDialect` now wraps a handle's `transaction`, so the callback is handed a BRANDED object and
 * a savepoint opened on that one is branded too. The class this census exists to catch is
 * therefore closed at its source rather than swept for, which is the better fix and the reason a
 * census over it is no longer a gate: it would fail on every correct site that reads the dialect
 * from a transaction, which is now most of them.
 *
 * SO THE GATE IS THE PREMISE, NOT THE SWEEP. The case below asserts that the inheritance holds; if
 * it is ever removed, that case goes red and names this file, and the sweep — kept intact, and
 * still reported — becomes the right gate again. A guard that has to be deleted by hand when its
 * premise changes is a guard nobody deletes; one that turns itself off says so out loud.
 *
 * ── WHY A CENSUS AND NOT A REVIEW NOTE ────────────────────────────────────────────────────
 *
 * It is invisible until the callee acquires a dialect requirement, which happens in a DIFFERENT
 * file, in a different lane, months later. Two production sites were broken exactly that way —
 * `approval-service`'s decide transaction reaching the learning-signal write, and the worker's
 * request drain reaching the screener apply — by a port that touched neither of them. Both were
 * green in every suite the porting lane ran and were found by a full-suite comparison afterwards.
 * A third had been fixed at ONE call site without sweeping for its siblings, which is how the
 * second one survived.
 *
 * ── CLASSIFIED BY RELATIONSHIP, NEVER BY THE NAME `tx` ────────────────────────────────────
 *
 * Two halves, and neither is a list of identifiers:
 *
 *   · a module REQUIRES a dialect when it imports `dialect` from the seam — that is what
 *     "resolves the store from a handle it was given" looks like in source. `carryDialect` and
 *     `brandDialect` do not count: those SUPPLY a brand rather than demand one.
 *   · the callback's parameter name is read from the source of each `.transaction(` rather than
 *     assumed, so a block that calls it `t`, `trx` or `txRaw` is judged the same way.
 *
 * A finding is: the RAW callback parameter reaches a callee imported from a dialect-requiring
 * module. Rebinding it through `carryDialect` clears it, which is the fix and the only fix.
 */
const ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

/** Production source only: a test may hold an unbranded handle on purpose. */
function productionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e === "node_modules" || e === "dist" || e === "test") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith(".ts") && !e.endsWith(".d.ts")) out.push(p.slice(ROOT.length + 1));
    }
  };
  for (const top of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(ROOT, top))) {
      const src = join(ROOT, top, pkg, "src");
      try { if (statSync(src).isDirectory()) walk(src); } catch { /* no src */ }
    }
  }
  return out.sort();
}

/** `dialect` imported from the seam — demanding a brand, as opposed to supplying one. */
const IMPORTS_DIALECT = /import\s*\{[^}]*\bdialect\b[^}]*\}\s*from\s*["'][^"']*dialect[^"']*["']/;

/** An exported function and the parameter name it takes its handle in — its first. */
interface Exported { readonly file: string; readonly name: string; readonly firstParam: string }

function exportedFunctions(files: readonly string[]): Exported[] {
  const out: Exported[] = [];
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), "utf8");
    for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)\s*\(\s*(\w+)?/gm)) {
      out.push({ file: f, name: m[1] as string, firstParam: (m[2] ?? "") as string });
    }
    for (const m of src.matchAll(/^export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(\s*(\w+)?/gm)) {
      out.push({ file: f, name: m[1] as string, firstParam: (m[2] ?? "") as string });
    }
  }
  return out;
}

/**
 * WHICH FUNCTIONS RESOLVE A DIALECT FROM THE HANDLE THEY ARE GIVEN — followed, not listed.
 *
 * The base case is a module that imports `dialect` from the seam: that is what "asks a handle
 * which store it is" looks like in source. But the requirement TRAVELS, and the two production
 * defects this file exists for both travelled: `applyScreenerDecision` imports no dialect at all
 * and hands its own first parameter to `recordLearningSignal`, which does.
 *
 * So the relation is closed over one real data-flow step and iterated to a fixed point: a function
 * requires a dialect when it passes ITS OWN FIRST PARAMETER as the first argument of a function
 * that already requires one. Nothing here is keyed on what anything is called.
 */
function dialectRequiringExports(files: readonly string[]): Map<string, string> {
  const owner = new Map<string, string>();
  const exported = exportedFunctions(files);
  const sources = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));

  for (const e of exported) {
    if (IMPORTS_DIALECT.test(sources.get(e.file) as string)) owner.set(e.name, e.file);
  }

  for (let pass = 0; pass < 8; pass++) {
    let grew = false;
    for (const e of exported) {
      if (owner.has(e.name) || e.firstParam === "") continue;
      const src = sources.get(e.file) as string;
      // Its own first parameter, handed on as somebody else's first argument.
      for (const call of src.matchAll(/(\w+)\s*\(\s*(\w+)/g)) {
        if (call[2] !== e.firstParam) continue;
        if (!owner.has(call[1] as string)) continue;
        owner.set(e.name, e.file); grew = true; break;
      }
    }
    if (!grew) break;
  }
  return owner;
}

/** The source of a balanced `(` … `)` starting at `open`. */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return src.slice(open);
}

interface Finding { readonly where: string; readonly param: string; readonly callee: string }

/**
 * EVERY NAME IN THIS BLOCK THAT IS STILL THE RAW TRANSACTION.
 *
 * The callback's own parameter, plus anything bound straight from it — `const tx = txRaw;` is the
 * same object under a second name and is still unbranded. Written because the first version of
 * this census judged the parameter name alone, and the mutation that was supposed to prove it
 * worked stayed GREEN: renaming the parameter and aliasing it defeated the check entirely, which
 * is a rename away from being how somebody writes it for real.
 *
 * A binding through `carryDialect` is the fix and clears the name, which is the whole point: the
 * object it produces IS branded.
 */
function rawAliases(block: string, param: string): Set<string> {
  const raw = new Set<string>([param]);
  for (let pass = 0; pass < 4; pass++) {
    let grew = false;
    for (const m of block.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*([^;\n]+)/g)) {
      const name = m[1] as string;
      const init = (m[2] as string).trim();
      if (raw.has(name)) continue;
      if (/\bcarryDialect\s*\(/.test(init)) continue;
      // A bare alias — `= txRaw`, `= txRaw as typeof txRaw`, `= txRaw as never` — is still raw.
      const head = /^(\w+)\b/.exec(init);
      if (head && raw.has(head[1] as string)) { raw.add(name); grew = true; }
    }
    if (!grew) break;
  }
  return raw;
}

function findings(files: readonly string[], requiring: Map<string, string>): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), "utf8");
    if (!src.includes(".transaction(")) continue;
    const lineOf = (i: number): number => src.slice(0, i).split("\n").length;
    for (const m of src.matchAll(/\.transaction\s*\(/g)) {
      const block = balanced(src, (m.index as number) + m[0].length - 1);
      // The callback's own parameter name, read from the source rather than assumed.
      const cb = /^\(\s*(?:async\s*)?\(?\s*(\w+)\s*\)?\s*=>/.exec(block);
      if (!cb) continue;
      const raw = rawAliases(block, cb[1] as string);
      for (const call of block.matchAll(/(\w+)\s*\(\s*([\w.]+)/g)) {
        const callee = call[1] as string;
        const firstArg = call[2] as string;
        if (!raw.has(firstArg)) continue;
        if (!requiring.has(callee)) continue;
        out.push({ where: `${f}:${lineOf((m.index as number))}`, param: firstArg, callee });
      }
    }
  }
  return out;
}

describe("a transaction that reaches the seam carries its parent's dialect", () => {
  const files = productionSources();
  const requiring = dialectRequiringExports(files);

  it("has found the modules that demand a dialect, or it is judging nothing", () => {
    // A relationship that stopped matching would classify nothing as requiring, and every block
    // would then pass. These three resolve a dialect from a handle they are given.
    expect(files.length).toBeGreaterThan(200);
    expect(requiring.has("recordLearningSignal"), "learning-signal's write resolves a dialect").toBe(true);
    expect(requiring.has("applyScreenerDecision"), "screener-apply resolves a dialect").toBe(true);
    expect(requiring.has("makeDrizzleRepo"), "the repository resolves a dialect on first use").toBe(true);
    // …and `carryDialect` SUPPLIES a brand rather than demanding one, so a module that only
    // imports that must not be classified as requiring.
    expect(IMPORTS_DIALECT.test('import { carryDialect } from "@trafficflow/db/dialect";')).toBe(false);
    expect(IMPORTS_DIALECT.test('import { dialect } from "@trafficflow/db/dialect";')).toBe(true);
  });

  it("can see a raw transaction parameter reaching one, whatever the block calls it", () => {
    // The positive control, on text: the same block passes and fails on one word, and the
    // parameter is deliberately NOT called `tx` — a census keyed on that name would miss it.
    const carried = 'db.transaction(async (t) => { const u = carryDialect(db, t); await recordLearningSignal(u, a, b); })';
    const raw = 'db.transaction(async (t) => { await recordLearningSignal(t, a, b); })';
    // The shape the first version of this census MISSED: a rename plus a bare alias.
    const aliased = 'db.transaction(async (tRaw) => { const t = tRaw; await recordLearningSignal(t, a, b); })';
    const probe = (src: string): number => {
      const m = /\.transaction\s*\(/.exec(src);
      const block = balanced(src, (m?.index ?? 0) + (m?.[0].length ?? 0) - 1);
      const cb = /^\(\s*(?:async\s*)?\(?\s*(\w+)\s*\)?\s*=>/.exec(block);
      const param = cb?.[1] ?? "";
      const raws = rawAliases(block, param);
      let n = 0;
      for (const call of block.matchAll(/(\w+)\s*\(\s*([\w.]+)/g)) {
        if (raws.has(call[2] as string) && requiring.has(call[1] as string)) n++;
      }
      return n;
    };
    expect(probe(raw), "the raw parameter reaching the callee must be a finding").toBe(1);
    expect(probe(aliased), "an ALIAS of the raw parameter is still the raw parameter").toBe(1);
    expect(probe(carried), "a parameter rebound through carryDialect must not be").toBe(0);
  });

  it("PREMISE: a transaction inherits its handle's dialect, so the sweep below is not a gate", async () => {
    // The one assertion in this file, and the switch it announces. While this holds, a raw
    // transaction parameter reaching a dialect-requiring callee is CORRECT and the sweep would
    // refuse correct code. If it stops holding, this goes red naming this file and the sweep is
    // the gate again — which is the whole reason the sweep is kept rather than deleted.
    const { brandDialect, dialectOf } = await import("../src/dialect/index.js");
    const db = brandDialect({
      transaction: async (fn: (tx: object) => unknown) => fn({}),
    }, "pg");
    const inside = await (db.transaction as (fn: (tx: object) => unknown) => Promise<unknown>)(
      (tx) => dialectOf(tx));
    expect(inside, "the brand no longer reaches a transaction — re-arm the sweep below").toBe("pg");
  });

  it("REPORTS every raw transaction parameter reaching a dialect-requiring callee", () => {
    // No assertion: under the premise above these are correct. Printed because the CLASSIFICATION
    // is the valuable part — it is how the two production paths named in the header were found —
    // and because the number is worth being able to read after a change to the seam.
    const found = findings(files, requiring).map((f) => `${f.where} passes ${f.param} to ${f.callee}`);
    console.log(`${found.length} site(s) read the dialect from a transaction parameter; all of them`
      + " rely on the inheritance asserted above."
      + (found.length > 0 ? `\n  ${found.slice(0, 8).join("\n  ")}${found.length > 8 ? `\n  …and ${found.length - 8} more` : ""}` : ""));
  });
});
