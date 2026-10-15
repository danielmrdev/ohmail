/**
 * EVERY MAIL ROW ON THE PHONE IS RENDERED THROUGH THE WINDOW. `MailList` is only the fix while
 * every screen uses it, so this census walks `app/` and, for each route importing `MailRow`,
 * refuses by name and line: a `<MailRow` produced by a `.map(` (the whole list mounted at once),
 * one outside every `<MailList …/>` element, one under a `<Scroller>` or `<ScrollView>` (a scroll
 * view mounts all of its children). The read blanks COMMENTS ONLY (`scripts/lib/source-scan.mjs`):
 * the literal-blanking reading takes the `/` of a JSX `</Tag>` or `/>` for a regex opener and
 * blanks the closer, so every span ran to the end of the file and the outside rule admitted all.
 * Two fixtures go through the same scan: the old shape earns all three refusals, the new one none.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bracketSpan, lineOf, withoutComments } from "../../../scripts/lib/source-scan.mjs";

const APP = fileURLToPath(new URL("../app", import.meta.url));
const CONTROL = fileURLToPath(new URL("./fixtures/list-census-control", import.meta.url));

type Rule = "MAPPED" | "OUTSIDE-MAILLIST" | "UNDER-SCROLLER";
interface Finding { file: string; line: number; rule: Rule }

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const importsMailRow = (src: string): boolean => /import\s*\{[^}]*\bMailRow\b[^}]*\}\s*from/.test(src);

/** Every index at which a `<Tag` element opens (`<TagName` continues a longer name — skipped). */
function opens(src: string, tag: string): number[] {
  const out: number[] = [];
  let at = 0;
  while ((at = src.indexOf(`<${tag}`, at)) !== -1) {
    const next = src[at + tag.length + 1];
    if (next === undefined || !/[\w]/.test(next)) out.push(at);
    at += tag.length + 1;
  }
  return out;
}

/**
 * Where the element opened at `at` ENDS: for `<Tag …/>` the `/>` at brace depth 0; for
 * `<Tag …>children</Tag>` the closing tag. Attribute expressions live inside `{}`, so a `>` at
 * depth 0 is the tag's own.
 */
function elementEnd(src: string, at: number, tag: string): { end: number; closed: boolean } {
  let depth = 0;
  for (let j = at + tag.length + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 0 && c === "/" && src[j + 1] === ">") return { end: j + 2, closed: true };
    else if (depth === 0 && c === ">") {
      const close = src.indexOf(`</${tag}>`, j);
      return close === -1 ? { end: src.length, closed: false } : { end: close, closed: true };
    }
  }
  return { end: src.length, closed: false };
}

function census(files: string[], root: string): { censused: string[]; findings: Finding[] } {
  const censused: string[] = [];
  const findings: Finding[] = [];
  for (const path of files) {
    const raw = readFileSync(path, "utf8");
    if (!importsMailRow(raw)) continue;
    const file = relative(root, path);
    censused.push(file);
    const src = withoutComments(raw);
    const rowsAt = opens(src, "MailRow");

    // 1. A `.map(` whose callback produces the row mounts the whole list at once.
    let at = 0;
    while ((at = src.indexOf(".map(", at)) !== -1) {
      const s = bracketSpan(src, at + ".map".length);
      if (src.slice(s.start, s.end).includes("<MailRow")) findings.push({ file, line: lineOf(src, at), rule: "MAPPED" });
      at = s.end;
    }

    // 2. Every row sits inside a `<MailList …/>` element.
    const lists = opens(src, "MailList").map((o) => [o, elementEnd(src, o, "MailList").end] as const);
    for (const r of rowsAt) {
      if (!lists.some(([s, e]) => r > s && r < e)) findings.push({ file, line: lineOf(src, r), rule: "OUTSIDE-MAILLIST" });
    }

    // 3. No row under a scroll view — it mounts every child it is given.
    for (const tag of ["Scroller", "ScrollView"]) {
      for (const o of opens(src, tag)) {
        const { end } = elementEnd(src, o, tag);
        for (const r of rowsAt) {
          if (r > o && r < end) findings.push({ file, line: lineOf(src, r), rule: "UNDER-SCROLLER" });
        }
      }
    }
  }
  return { censused, findings };
}

const said = (f: Finding) => `${f.file}:${f.line} ${f.rule}`;

describe("the app's routes", () => {
  const result = census(tsxFiles(APP), APP);

  it("the census sees the list screens — it is not green for want of a file", () => {
    for (const screen of ["(tabs)/index.tsx", "(tabs)/receipts.tsx", "history.tsx", "folder/[id].tsx", "trash/index.tsx"]) {
      expect(result.censused, `${screen} imports MailRow and is censused`).toContain(screen);
    }
  });

  it("every MailRow is drawn inside MailList: none mapped, none outside, none under a scroll view", () => {
    expect(result.findings.map(said)).toEqual([]);
  });
});

describe("the control fixtures, through the same scan", () => {
  it("the old shape earns all three refusals by name", () => {
    const { censused, findings } = census([join(CONTROL, "unvirtualized.tsx")], CONTROL);
    expect(censused).toEqual(["unvirtualized.tsx"]);
    expect(new Set(findings.map((f) => f.rule))).toEqual(new Set<Rule>(["MAPPED", "OUTSIDE-MAILLIST", "UNDER-SCROLLER"]));
    for (const f of findings) expect(f.line, said(f)).toBeGreaterThan(1);
  });

  it("the new shape earns none — the rule admits the app it guards", () => {
    const { censused, findings } = census([join(CONTROL, "virtualized.tsx")], CONTROL);
    expect(censused).toEqual(["virtualized.tsx"]);
    expect(findings.map(said)).toEqual([]);
  });

  it("a `<MailList` element that never closes is not a span anything can hide in", () => {
    const { end, closed } = elementEnd("<MailList groups={x}", 0, "MailList");
    expect(closed).toBe(false);
    expect(end).toBe("<MailList groups={x}".length);
  });
});
