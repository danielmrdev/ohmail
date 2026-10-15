/**
 * THE APP SAYS WHICH POSTURE IT DERIVED. The layout cell on a foldable read the posture from the
 * accessibility tree and guessed; the provider derived it and logged nothing (LAYOUT-026). One line per
 * derived posture — window dp, the fold features' count and the fold state — through the engine sink
 * `adb logcat -s ReactNativeJS` already carries, so the rig reads the app's claim beside `dumpsys device_state`.
 *
 * MUTATION WATCHED: the effect in posture/index.tsx removed ⇒ the wiring arm RED.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { logPostureDerived } from "../src/engine/engine-log";

const PROVIDER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "ui", "posture", "index.tsx");

function linesOf(body: () => void): Record<string, unknown>[] {
  const written: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { written.push(String(a[0])); });
  try { body(); } finally { spy.mockRestore(); }
  return written.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("a derived posture", () => {
  it("writes the window in whole dp, the fold count and the fold state, and nothing else", () => {
    const lines = linesOf(() => {
      logPostureDerived({ width: 841.4285, height: 900.2, folds: 1, state: "flat" });
      logPostureDerived({ width: 404, height: 904, folds: 0, state: "none" });
    });
    expect(lines).toEqual([
      { service: "app", event: "posture_derived", width: 841, height: 900, folds: 1, state: "flat" },
      { service: "app", event: "posture_derived", width: 404, height: 904, folds: 0, state: "none" },
    ]);
  });

  it("is written by the provider from the posture it derived, once per derived value", () => {
    const src = ts.createSourceFile(PROVIDER, fs.readFileSync(PROVIDER, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const effects: ts.CallExpression[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.expression.getText() === "useEffect" && n.arguments[0]?.getText().includes("logPostureDerived(")) effects.push(n);
      ts.forEachChild(n, walk);
    };
    walk(src);
    expect(effects, "one useEffect in posture/index.tsx calls logPostureDerived").toHaveLength(1);
    const body = effects[0]!.arguments[0]!.getText();
    expect(body).toContain("state: value.fold");
    expect(body).toContain("folds: folds?.length ?? 0");
    expect(effects[0]!.arguments[1]?.getText(), "keyed on the derived value, so one line per posture").toBe("[value]");
  });
});
