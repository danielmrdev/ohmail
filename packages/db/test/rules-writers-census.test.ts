import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * ONE RULE PER FOUR-FIELD KEY ON EVERY DOOR: every `insert(rules…)` in a product source is either
 * one of the two converging doors (`reconcileRuleCreate`, `writeRuleUnderKey`; each calls
 * `convergeRuleKey` before its insert) or named below with the gap row that owns it. A new insert is red by name; an entry no
 * site answers to is red by name; the list may only shrink.
 */
const ROOT = resolve(import.meta.dirname ?? ".", "../../..");

/** The converging doors: the create door and the writer for a door that names a sender. */
const CONVERGING = new Set([
  "packages/db/src/request-apply.ts:reconcileRuleCreate",
  "packages/db/src/rule-key.ts:writeRuleUnderKey",
]);

/** Inserts that write without converging, each with the row that owns it or why none is owed. */
const ALLOWED: Readonly<Record<string, string>> = {
  "packages/core/src/adapters/organizer-profile-store.ts:applyOrganizerProfile":
    "no row: mirrors the document's own row count per key, so it writes twins only where the exporter had them",
  "packages/services/src/consent-seed.ts:confirmSeed":
    "no row: inserts a bare key only where it has no row at all, read under the rule-key lock, in bulk (writeRuleUnderKey's skip)",
  "apps/sidecar/src/cloud-mirror.ts:applyAccountUpsert": "no row: a mirror of Cloud's rows, upserted by id",
};

const RULES_TABLE = new Set(["rules", "rulesTbl"]);

function enclosing(node: ts.Node): string {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name && ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)
      && p.initializer && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) return p.name.text;
  }
  return "<top level>";
}

/** Every `.insert(<rules table>)` in one source, as `file:function` with its offset. */
function insertSites(file: string, text: string): { key: string; at: number; fn: ts.Node | null }[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: { key: string; at: number; fn: ts.Node | null }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "insert") {
      const arg = n.arguments[0];
      if (arg && ts.isIdentifier(arg) && RULES_TABLE.has(arg.text)) {
        let fn: ts.Node | null = null;
        for (let p: ts.Node | undefined = n.parent; p && fn === null; p = p.parent) {
          if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) fn = p;
        }
        out.push({ key: `${file}:${enclosing(n)}`, at: n.getStart(sf), fn });
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

function sources(): string[] {
  // Tracked AND untracked: a new file is a door from the moment it is written, not from its commit.
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "packages/*/src/**", "apps/*/src/**"], { cwd: ROOT, encoding: "utf8" });
  return listed.split("\n").filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts"));
}

function census(): { key: string; at: number; fn: ts.Node | null; text: string }[] {
  return sources().flatMap((f) => {
    const text = readFileSync(resolve(ROOT, f), "utf8");
    if (!/\.insert\(\s*rules(Tbl)?\s*\)/.test(text)) return [];
    return insertSites(f, text).map((s) => ({ ...s, text }));
  });
}

describe("every insert into rules converges its key or is named", () => {
  const sites = census();

  it("the census reads the tree (positive control: the create door is found)", () => {
    expect(sources().length).toBeGreaterThan(500);
    expect(sites.map((s) => s.key)).toContain("packages/db/src/request-apply.ts:reconcileRuleCreate");
  });

  it("no insert outside the converging doors and the named list", () => {
    const unnamed = sites.map((s) => s.key).filter((k) => !CONVERGING.has(k) && !(k in ALLOWED));
    expect(unnamed, "a new rules insert: converge through writeRuleUnderKey, or name it with its gap row").toEqual([]);
  });

  it("no named entry without a site (the list may only shrink)", () => {
    const found = new Set(sites.map((s) => s.key));
    const stale = [...CONVERGING, ...Object.keys(ALLOWED)].filter((k) => !found.has(k));
    expect(stale, "a named door no longer inserts: remove its entry").toEqual([]);
  });

  it("each converging door calls convergeRuleKey before its insert (code order)", () => {
    for (const s of sites.filter((x) => CONVERGING.has(x.key))) {
      const calls: number[] = [];
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "convergeRuleKey") calls.push(n.getStart());
        n.forEachChild(visit);
      };
      visit(s.fn!);
      expect(calls.length, `${s.key} never converges`).toBeGreaterThan(0);
      expect(Math.min(...calls), `${s.key} inserts before it converges`).toBeLessThan(s.at);
    }
  });

  it("a planted insert is named by file and function (the classifier's own control)", () => {
    const planted = "export async function plant(tx: any) { await tx.insert(rulesTbl).values({}); }\n";
    expect(insertSites("packages/x/src/planted.ts", planted).map((s) => s.key)).toEqual(["packages/x/src/planted.ts:plant"]);
    const method = "class S { private async seed(tx: any) { await tx.insert(rules).values([]); } }\n";
    expect(insertSites("packages/x/src/m.ts", method).map((s) => s.key)).toEqual(["packages/x/src/m.ts:seed"]);
    expect(insertSites("packages/x/src/o.ts", "async function f(tx: any) { await tx.insert(contacts).values({}); }")).toEqual([]);
  });
});
