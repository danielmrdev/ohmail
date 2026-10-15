/**
 * Every accessibility state a phone control declares reaches native WITH its key. A render that
 * hands Pressable no key leaves Android on the last flag it was given
 * (`button-ax-state-clears.test.ts` says how), so every `accessibilityState=` under `src/` and
 * `app/` is an object literal, and no property of it, nor an `aria-*` state prop, can be the
 * `undefined` literal. Shorthand and spread are refused: `{ disabled }` of an optional prop is the
 * regression this exists for. A `disabled=` handed to a press target folds into the same key, so it
 * is read too. Parsed with the TypeScript parser. Not seen: a named value typed
 * `boolean | undefined` (`{ disabled: flag }`); its type is the guard there.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["src", "app"];
const ARIA_STATE = new Set(["aria-disabled", "aria-selected", "aria-checked", "aria-busy", "aria-expanded"]);

type Site = { at: string; attr: string; refusal: string | null };

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : filesUnder(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

function unwrap(node: ts.Expression): ts.Expression {
  let e = node;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)
    || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

function canBeUndefined(node: ts.Expression): boolean {
  const e = unwrap(node);
  if (ts.isIdentifier(e)) return e.text === "undefined";
  if (ts.isVoidExpression(e) || ts.isOptionalChain(e)) return true;
  if (ts.isConditionalExpression(e)) return canBeUndefined(e.whenTrue) || canBeUndefined(e.whenFalse);
  if (ts.isBinaryExpression(e)) {
    const k = e.operatorToken.kind;
    const logical = k === ts.SyntaxKind.QuestionQuestionToken
      || k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.AmpersandAmpersandToken;
    return logical && (canBeUndefined(e.left) || canBeUndefined(e.right));
  }
  return false;
}

function refusalOf(name: string, value: ts.Expression | undefined): string | null {
  if (name === "disabled") return value !== undefined && canBeUndefined(value) ? "can be undefined" : null;
  if (value === undefined) return "no value";
  if (ARIA_STATE.has(name)) return canBeUndefined(value) ? "can be undefined" : null;
  const e = unwrap(value);
  if (!ts.isObjectLiteralExpression(e)) return "not an object literal";
  for (const p of e.properties) {
    if (ts.isShorthandPropertyAssignment(p)) return `shorthand ${p.name.text}`;
    if (ts.isSpreadAssignment(p)) return "spread";
    if (ts.isPropertyAssignment(p) && canBeUndefined(p.initializer)) return `${p.name.getText()} can be undefined`;
  }
  return null;
}

function sitesIn(source: string, file: string): Site[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Site[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node)) {
      const attr = node.name.getText(sf);
      if (attr === "accessibilityState" || attr === "disabled" || ARIA_STATE.has(attr)) {
        const init = node.initializer;
        const value = init && ts.isJsxExpression(init) ? init.expression : undefined;
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        out.push({ at: `${file}:${line}`, attr, refusal: refusalOf(attr, value) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const SITES = ROOTS.flatMap((r) => filesUnder(join(ROOT, r)))
  .flatMap((f) => sitesIn(readFileSync(f, "utf8"), relative(ROOT, f)));

const fixture = (attrs: string) => sitesIn(`const x = <T ${attrs} />;`, "fixture.tsx")[0]?.refusal;

describe("every accessibility state reaches native with its key", () => {
  it("the census reads the tree, including the three files the stale flag was found in", () => {
    expect(SITES.length).toBeGreaterThanOrEqual(8);
    const files = new Set(SITES.map((s) => s.at.replace(/:\d+$/, "")));
    for (const f of ["src/ui/base.tsx", "src/ui/glass/GlassIconButton.tsx", "src/ui/MessageActions.tsx"]) {
      expect(files, f).toContain(f);
    }
  });

  it("the census reads every disabled= site, the five handed straight to a press target included", () => {
    const disabled = new Set(SITES.filter((s) => s.attr === "disabled").map((s) => s.at.replace(/:\d+$/, "")));
    for (const f of ["src/ui/MessageReader.tsx", "src/ui/UnsavedChanges.tsx", "app/settings.tsx"]) {
      expect(disabled, f).toContain(f);
    }
    expect(SITES.filter((s) => s.attr === "disabled").length).toBeGreaterThanOrEqual(20);
  });

  it("no site under src/ or app/ can hand Pressable a state without its key", () => {
    expect(SITES.filter((s) => s.refusal !== null)).toEqual([]);
  });

  it("the rule refuses the shapes it exists for and admits the explicit ones, driven", () => {
    expect(fixture("accessibilityState={disabled === true ? { disabled: true } : undefined}"))
      .toBe("not an object literal");
    expect(fixture('accessibilityState={phase === "idle" ? undefined : { disabled: true }}'))
      .toBe("not an object literal");
    expect(fixture("accessibilityState={{ disabled: busy ? true : undefined }}")).toBe("disabled can be undefined");
    expect(fixture("accessibilityState={{ disabled: props?.disabled }}")).toBe("disabled can be undefined");
    expect(fixture("accessibilityState={{ disabled }}")).toBe("shorthand disabled");
    expect(fixture("accessibilityState={{ ...state }}")).toBe("spread");
    expect(fixture("aria-disabled={busy ? true : undefined}")).toBe("can be undefined");
    expect(fixture("accessibilityState={{ disabled: disabled === true }}")).toBeNull();
    expect(fixture('accessibilityState={{ selected: role === "tab" && on === true }}')).toBeNull();
    expect(fixture("accessibilityState={{ checked: applyRetro }}")).toBeNull();
    expect(fixture("aria-disabled={busy}")).toBeNull();
    expect(fixture("disabled={busy ? true : undefined}")).toBe("can be undefined");
    expect(fixture("disabled={props?.busy}")).toBe("can be undefined");
    expect(fixture("disabled={undefined}")).toBe("can be undefined");
    expect(fixture("disabled={busy === m.id}")).toBeNull();
    expect(fixture("disabled")).toBeNull();
  });
});
