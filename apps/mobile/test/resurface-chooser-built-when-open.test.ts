import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * THE 90-DAY CHOOSER IS BUILT ONLY WHILE IT IS OPEN. It stood in the resurface sheet's final
 * `else` branch — taken whenever the sheet was neither "resurface" nor "time", closed included — so
 * every render of the reader built ninety rows and a day label each. Asserted over the syntax tree
 * (there is no React Native renderer in this workspace): the `Array.from({ length: 90 })` must sit
 * in the TRUE arm of a conditional whose test is `open === "pick"`.
 */

const SRC = fileURLToPath(new URL("../src/ui/MessageActions.tsx", import.meta.url));

/** The test of the conditional whose TRUE arm holds the chooser's rows, or null when none does. */
function guardOf(source: string): string | null {
  const sf = ts.createSourceFile("MessageActions.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let rows: ts.Node | null = null;
  const find = (n: ts.Node): void => {
    if (rows) return;
    if (ts.isCallExpression(n) && n.expression.getText(sf) === "Array.from" && /length:\s*90\b/.test(n.arguments[0]?.getText(sf) ?? "")) {
      rows = n;
      return;
    }
    ts.forEachChild(n, find);
  };
  find(sf);
  if (rows === null) throw new Error("no Array.from({ length: 90 }) in MessageActions.tsx");
  let child: ts.Node = rows;
  for (let p = (rows as ts.Node).parent; p; child = p, p = p.parent) {
    if (ts.isConditionalExpression(p) && p.whenTrue === child) return p.condition.getText(sf).replace(/\s+/g, " ");
  }
  return null;
}

describe("the reader's day chooser", () => {
  it("is built only in the arm where the chooser is open", () => {
    expect(guardOf(readFileSync(SRC, "utf8"))).toBe('open === "pick"');
  });

  it("reads the shipped shape — the closed sheet's else arm — as unguarded", () => {
    const shipped = readFileSync(SRC, "utf8").replace(') : open === "pick" ? (', ") : (").replace(") : null}\n      </Sheet>", ")}\n      </Sheet>");
    expect(shipped).not.toContain('open === "pick" ?');
    expect(guardOf(shipped)).not.toBe('open === "pick"');
  });
});
