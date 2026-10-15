import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ORGANIZED_FOLDERS, canonicalDestination } from "@trafficflow/core/destinations";
import * as destinations from "@trafficflow/core/destinations";
import { effectForDestination } from "@trafficflow/core/rule-order";
import {
  CUTLINE_ALLOW_DESTINATIONS, CUTLINE_DECIDED_DESTINATIONS, CUTLINE_PRESENTED_FOLDERS, DECIDABLE_FOLDERS,
} from "@trafficflow/db";
import { withoutComments, lineOf } from "../scripts/lib/source-scan.mjs";

/**
 * ONE DESTINATION LIST FOR "DECIDED" AND "CONSENTING". The Screener queue, the consent count and
 * the client cutline each classified destinations from a list of their own; this census refuses a
 * literal collection equal to either answer anywhere but the core owner. `db` cannot import core,
 * so its copies stay, each pinned by value below. Positive control: a planted duplicate.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OWNER = "packages/core/src/types.ts";
/** `db` may not depend on `@trafficflow/core`; its re-declarations are pinned in the last block. */
const MIRROR_ROOT = "packages/db/src/";

/** The identifiers a destination literal is spelled with, by value. Anything else is unknown. */
const KNOWN: Readonly<Record<string, string>> = {
  NEWS_FOLDER: "ohmail/News", LEGACY_NEWS_FOLDER: "ohmail/Reads", YES_FOLDER: "INBOX",
  NO_FOLDER: "ohmail/Screened", SCREENER_FOLDER: "ohmail/Screener", GATE_FOLDER: "ohmail/Screener",
  CUTLINE_GATE_FOLDER: "ohmail/Screener", AWAY_SCREENER_FOLDER: "ohmail/Screener",
  OHBOX: "INBOX", SCREENER: "ohmail/Screener",
};

const canon = (xs: Iterable<string>): string => JSON.stringify([...new Set([...xs].map(canonicalDestination))].sort());
/** The two answers, DERIVED from the order's own classification — never from the module under test. */
const CONSENTING = canon(ORGANIZED_FOLDERS.filter((f) => effectForDestination(f) === "allow"));
const DECIDED = canon(ORGANIZED_FOLDERS.filter((f) => f !== "ohmail/Screener"));

export interface Copy { file: string; line: number; answer: "consenting" | "decided" }

/** Every bracketed literal in `src` whose members, resolved and canonical, equal one of the two answers. */
export function copiesIn(file: string, src: string): Copy[] {
  const code = withoutComments(src);
  const out: Copy[] = [];
  for (const m of code.matchAll(/\[([^[\]]*)\]/g)) {
    const members = m[1]!.split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (members.length < 2) continue;
    const values: string[] = [];
    for (const x of members) {
      const lit = /^["']([^"']*)["']$/.exec(x);
      const v = lit ? lit[1]! : KNOWN[x];
      if (v === undefined) { values.length = 0; break; }
      values.push(v);
    }
    if (values.length === 0) continue;
    const key = canon(values);
    const answer = key === CONSENTING ? "consenting" : key === DECIDED ? "decided" : null;
    if (answer) out.push({ file, line: lineOf(code, m.index!), answer });
  }
  return out;
}

/** The scanned roots, named, and what each skips: build output and dependencies, never tests. */
const ROOTS = ["packages", "apps"];
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "build", ".next", "test", "tests", "android", "ios", "target"].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const files = ROOTS.flatMap((r) => sources(join(ROOT, r))).map((p) => relative(ROOT, p));
const all = files.flatMap((f) => copiesIn(f, readFileSync(join(ROOT, f), "utf8")));

describe("the Screener's destination classification has one owner", () => {
  it("the census reads a known copy through the same path — db's pinned mirrors", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain(OWNER);
    const mirrors = all.filter((c) => c.file.startsWith(MIRROR_ROOT));
    expect(mirrors.map((c) => c.answer)).toContain("consenting");
    expect(mirrors.map((c) => c.answer)).toContain("decided");
  });

  it("no literal copy of either answer outside the owning module and db's pinned mirrors", () => {
    const stray = all.filter((c) => c.file !== OWNER && !c.file.startsWith(MIRROR_ROOT));
    expect(stray.map((c) => `${c.file}:${c.line} ${c.answer}`)).toEqual([]);
  });

  it("POSITIVE CONTROL — a planted duplicate set is refused, a different question is not", () => {
    const planted = [
      'const CONSENTING = new Set<string>(["INBOX", NEWS_FOLDER, "ohmail/Receipts", LEGACY_NEWS_FOLDER]);',
      'const decidable = [YES_FOLDER, "ohmail/News", "ohmail/Receipts", NO_FOLDER, "ohmail/Quarantine"];',
      '// ["INBOX", "ohmail/News", "ohmail/Receipts"] in a comment is prose',
      'const piles = ["INBOX", "ohmail/News", "ohmail/Receipts", AWAY_SCREENER_FOLDER];',
      'const unknown = ["INBOX", SOMETHING_ELSE, "ohmail/Receipts"];',
    ].join("\n");
    expect(copiesIn("planted.ts", planted)).toEqual([
      { file: "planted.ts", line: 1, answer: "consenting" },
      { file: "planted.ts", line: 2, answer: "decided" },
    ]);
  });
});

describe("the owning module states both answers, and every copy that cannot import it agrees", () => {
  const owner = destinations as unknown as Record<string, unknown>;
  const consenting = owner.CONSENTING_DESTINATIONS as readonly string[] | undefined;
  const decided = owner.DECIDED_DESTINATIONS as readonly string[] | undefined;

  it("core names the two lists, derived from the order's own allow/deny reading", () => {
    expect(consenting && canon(consenting)).toBe(CONSENTING);
    expect(decided && canon(decided)).toBe(DECIDED);
    // Both News spellings: stored rows and rules carry the pre-0.22 name.
    for (const list of [consenting, decided]) expect(list).toContain("ohmail/Reads");
  });

  it("db's re-declarations equal core's, member for member", () => {
    expect([...CUTLINE_ALLOW_DESTINATIONS].sort()).toEqual([...(consenting ?? [])].sort());
    expect([...CUTLINE_DECIDED_DESTINATIONS].sort()).toEqual([...(decided ?? [])].sort());
    expect([...DECIDABLE_FOLDERS].sort()).toEqual([...(decided ?? [])].sort());
    expect([...CUTLINE_PRESENTED_FOLDERS].sort()).toEqual([...ORGANIZED_FOLDERS].sort());
  });
});
