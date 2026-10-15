/**
 * A NOTICE ON SCREEN WRITES ONE LINE. A device run read the 3.2 s launch notice "absent" through
 * screen dumps of two seconds and more while the app had raised it. The line carries the notice's
 * deck key and its Undo flag and nothing it interpolates, and
 * the pill writes it once, on the frame it is first on screen.
 *
 * MUTATIONS WATCHED: the call in chrome.tsx removed ⇒ the wiring arm RED.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { logNotice } from "../src/engine/engine-log";

const CHROME = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "ui", "chrome.tsx");

function linesOf(body: () => void): Record<string, unknown>[] {
  const written: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { written.push(String(a[0])); });
  try { body(); } finally { spy.mockRestore(); }
  return written.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("a notice on screen", () => {
  it("writes its key and its Undo flag, and nothing else", () => {
    const lines = linesOf(() => { logNotice("routingKeptAtLaunch", false); logNotice("text", true); });
    expect(lines).toEqual([
      { service: "app", event: "notice_shown", say: "routingKeptAtLaunch", undo: false },
      { service: "app", event: "notice_shown", say: "text", undo: true },
    ]);
  });

  it("is written by the pill once it is on screen, from the entry's key and never its words", () => {
    const src = ts.createSourceFile(CHROME, fs.readFileSync(CHROME, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let laidOut: ts.Node | undefined;
    const find = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && n.name.getText() === "laidOut") laidOut = n.initializer;
      ts.forEachChild(n, find);
    };
    find(src);
    expect(laidOut, "the pill's onLayout handler").toBeDefined();
    const calls: ts.CallExpression[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.expression.getText() === "logNotice") calls.push(n);
      ts.forEachChild(n, walk);
    };
    walk(laidOut!);
    expect(calls, "logNotice is called in the pill's onLayout").toHaveLength(1);
    const body = laidOut!.getText();
    // After the early return for a pill already on screen, so once per entry.
    expect(body.indexOf("logNotice(")).toBeGreaterThan(body.indexOf("if (hold.current.id === toastId) return;"));
    const [key, undo] = calls[0]!.arguments.map((a) => a.getText());
    expect(key).toContain("entry.say.say");
    expect(key).not.toContain("sayArg");
    expect(undo).toBe("undo !== undefined");
  });
});
