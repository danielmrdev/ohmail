/**
 * THE PHONE TIMES ITS OWN OPEN AND SWITCH. A device run bounds a tap by a uiautomator poll every 100 ms; the
 * app's own reading — press to the commit showing the result — sits beside it on the minute's `ui_vitals`
 * line, the web's `recordInteraction` shape (FEEL-026, DESIGN-REAL-USER-CHECKS).
 *
 * MUTATIONS WATCHED: the reader's terminal-state condition dropped ⇒ the wiring arm RED; `endMark`'s key
 * check removed ⇒ the foreign-end arm RED; startUiVitals logging without takeUiMarks() ⇒ the cadence arm RED; the
 * ring bound removed, or a quiet minute's percentile taken anyway ⇒ the ring arm RED.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { logUiVitals } from "../src/engine/engine-log";
import { MARK_TIMEOUT_MS, RING, beginMark, endMark, resetUiMarksForTest, takeUiMarks } from "../src/engine/ui-marks";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const parse = (rel: string) => ts.createSourceFile(rel, fs.readFileSync(path.join(ROOT, rel), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function calls(src: ts.SourceFile, callee: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const walk = (n: ts.Node): void => { if (ts.isCallExpression(n) && n.expression.getText() === callee) out.push(n); ts.forEachChild(n, walk); };
  walk(src);
  return out;
}
const effectsCalling = (src: ts.SourceFile, needle: string) => calls(src, "useEffect").filter((c) => c.arguments[0]?.getText().includes(needle));

afterEach(() => resetUiMarksForTest(() => performance.now()));

describe("the open and switch marks", () => {
  it("time press to end on the given clock and report nearest-rank percentiles and counts", () => {
    let now = 0;
    resetUiMarksForTest(() => now);
    for (const ms of [40, 120, 80]) { beginMark("open", "m1"); now += ms; endMark("open", "m1"); }
    beginMark("switch", "screener"); now += 25; endMark("switch", "screener");
    expect(takeUiMarks()).toEqual({ openP50Ms: 80, openP95Ms: 120, openCount: 3, openTimeouts: 0, switchP50Ms: 25, switchP95Ms: 25, switchCount: 1, switchTimeouts: 0 });
    expect(takeUiMarks().openCount, "the counts are per report").toBe(0);
  });

  it("ignore an end for another key, and count an end past the timeout as a timeout, never a reading", () => {
    let now = 0;
    resetUiMarksForTest(() => now);
    beginMark("open", "m1"); now += 10; endMark("open", "m2");
    beginMark("switch", "reads"); now += MARK_TIMEOUT_MS + 1; endMark("switch", "reads");
    expect(takeUiMarks()).toMatchObject({ openCount: 0, openP50Ms: null, switchCount: 0, switchTimeouts: 1, switchP95Ms: null });
  });

  it("take their percentiles over the last RING readings, and a minute with none logs null, not the last minute's", () => {
    let now = 0;
    resetUiMarksForTest(() => now);
    const open = (ms: number) => { beginMark("open", "m"); now += ms; endMark("open", "m"); };
    for (let i = 0; i < 50; i++) open(10_000);
    for (let i = 0; i < RING; i++) open(10);
    expect(takeUiMarks()).toMatchObject({ openP95Ms: 10, openCount: 150 });
    expect(takeUiMarks(), "a quiet minute repeats nothing").toMatchObject({ openP50Ms: null, openP95Ms: null, openCount: 0 });
  });

  it("ride the minute's ui_vitals line beside the derivation figures", () => {
    const written: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { written.push(String(a[0])); });
    try {
      logUiVitals({ derives: 3, deriveMsMax: 9, deriveMsP95: 7, notifies: 2 }, { openP50Ms: 80, openP95Ms: 120, openCount: 3, openTimeouts: 0, switchP50Ms: 25, switchP95Ms: 25, switchCount: 1, switchTimeouts: 0 });
    } finally { spy.mockRestore(); }
    expect(JSON.parse(written[0]!)).toEqual({ service: "app", event: "ui_vitals", derives: 3, deriveMsMax: 9, deriveMsP95: 7, notifies: 2,
      openP50Ms: 80, openP95Ms: 120, openCount: 3, openTimeouts: 0, switchP50Ms: 25, switchP95Ms: 25, switchCount: 1, switchTimeouts: 0 });
  });

  it("are begun by the press and ended by the commit effect of the screen that shows the result", () => {
    const open = calls(parse("src/ui/list-detail.tsx"), "beginMark");
    expect(open.map((c) => c.getText())).toEqual(['beginMark("open", id)']);
    const reader = effectsCalling(parse("src/ui/MessageReader.tsx"), "endMark(");
    expect(reader, "one effect in the reader ends the open").toHaveLength(1);
    expect(reader[0]!.arguments[0]!.getText()).toContain('bodyState !== "snippet" && bodyState !== "loading"');
    expect(reader[0]!.arguments[1]?.getText()).toBe("[id, bodyState]");
    const tabs = parse("app/(tabs)/_layout.tsx");
    expect(calls(tabs, "beginMark").map((c) => c.getText())).toEqual(['beginMark("switch", id)']);
    const sw = effectsCalling(tabs, "endMark(");
    expect(sw).toHaveLength(1);
    expect(sw[0]!.arguments[1]?.getText()).toBe("[activeId]");
    const cadence = calls(parse("src/engine/engine-log.ts"), "logUiVitals").map((c) => c.getText());
    expect(cadence).toContain("logUiVitals(take(), takeUiMarks())");
  });
});
