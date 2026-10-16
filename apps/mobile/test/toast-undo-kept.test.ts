/**
 * THE UNDO OFFER KEEPS ITS SLOT. One pill used to hold every sentence, so a notice raised while
 * an Undo pill stood (a sync sentence, a save confirmation) took the offer off the screen with a
 * window still running. Two slots now: the offer and a notice beneath it, the newest in each and
 * nothing waiting. Held here as the policy the provider folds, the lift that keeps the offer clear
 * of a notice without moving it from under a finger, and a census that the pill wires both.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  AT_REST, NO_TOASTS, STACK_GAP, afterDismiss, nextToast, riseForAction, riseForNotice, riseForPress,
  type ToastEntry, type ToastSlots,
} from "../src/state/toast-one";

const offer = (id: number): ToastEntry => ({ id, say: { say: "toastQueued" } as never, undo: () => undefined, holdMs: 8000 });
const notice = (id: number): ToastEntry => ({ id, say: { say: "toastRead" } as never });
const fold = (entries: ToastEntry[]): ToastSlots =>
  entries.reduce<ToastSlots>((standing, e) => nextToast(standing, e), NO_TOASTS);

describe("two slots, the newest in each", () => {
  it("a notice raised under a standing offer stands BESIDE it — the offer is not displaced", () => {
    const shown = fold([offer(1), notice(2)]);
    expect(shown.action?.id, "the Undo offer is still on screen").toBe(1);
    expect(shown.notice?.id).toBe(2);
  });

  it("and the other way round: an offer raised over a standing notice leaves the notice", () => {
    const shown = fold([notice(1), offer(2)]);
    expect(shown.action?.id).toBe(2);
    expect(shown.notice?.id).toBe(1);
  });

  it("controls: a notice replaces a notice, an offer replaces an offer", () => {
    expect(fold([notice(1), notice(2)])).toEqual({ action: null, notice: notice(2) });
    const two = fold([offer(1), offer(2)]);
    expect(two.action?.id, "the person acted again").toBe(2);
    expect(two.notice).toBeNull();
  });

  it("a dismiss by id takes its own slot only, and a stale id takes nothing", () => {
    const both = fold([offer(1), notice(2)]);
    expect(afterDismiss(both, 1)).toEqual({ action: null, notice: both.notice });
    expect(afterDismiss(both, 2)).toEqual({ action: both.action, notice: null });
    expect(afterDismiss(both, 3)).toBe(both);
  });
});

describe("the offer rises to clear a notice, once, and never under a finger", () => {
  const H = 40;

  it("a notice laid out under a standing offer lifts it by the notice's height and the gap", () => {
    const r = riseForNotice(riseForAction(1, null), H);
    expect(r.lift).toBe(H + STACK_GAP);
  });

  it("upward only: a shorter notice, or none, never brings it back down", () => {
    const up = riseForNotice(riseForAction(1, null), H);
    expect(riseForNotice(up, H - 20)).toBe(up);
    expect(riseForNotice(up, 0)).toBe(up);
    // A TALLER notice replacing the first is another arrival, and it may lift further.
    expect(riseForNotice(up, H + 20).lift).toBe(H + 20 + STACK_GAP);
  });

  it("a press in progress defers the move to the press's end", () => {
    const held = riseForPress(riseForAction(1, null), true);
    const during = riseForNotice(held, H);
    expect(during.lift, "the button did not move under the finger").toBe(0);
    expect(riseForPress(during, false).lift).toBe(H + STACK_GAP);
  });

  it("a new offer is PLACED above a notice already standing, and at the anchor without one", () => {
    expect(riseForAction(2, H).lift).toBe(H + STACK_GAP);
    expect(riseForAction(2, null).lift).toBe(0);
    expect(riseForAction(null, H)).toEqual(AT_REST);
  });

  it("with no offer standing a notice moves nothing", () => {
    expect(riseForNotice(AT_REST, H)).toBe(AT_REST);
  });
});

/* ── the census: the pill wires the policy ─────────────────────────────────────────────────── */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = path.join(HERE, "..", "src", "ui", "chrome.tsx");

/** Names of every function CALLED inside the named top-level function of `file`. */
function callsIn(file: string, fn: string): string[] {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body: ts.Node | null = null;
  ts.forEachChild(sf, (n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === fn) body = n; });
  const out: string[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isCallExpression(n)) out.push(n.expression.getText());
    ts.forEachChild(n, walk);
  };
  if (body) walk(body);
  return out;
}

describe("the pill is wired to the two slots", () => {
  it("the toast reads the lift off the policy at all three moments", () => {
    const calls = callsIn(CHROME, "Toast");
    for (const f of ["riseForAction", "riseForNotice", "riseForPress"]) expect(calls, f).toContain(f);
  });

  it("the Undo button reports its press, so the lift can wait for it", () => {
    const src = fs.readFileSync(CHROME, "utf8");
    expect(src).toContain("onPressIn={() => onPressing?.(true)}");
    expect(src).toContain("onPressOut={() => onPressing?.(false)}");
  });

  it("the pill tells a held window its hold has started, AFTER arming it, so the offer leaves first", () => {
    const src = fs.readFileSync(CHROME, "utf8");
    const from = src.indexOf("const laidOut = (e: LayoutChangeEvent) => {");
    expect(from, "the pill's layout handler is not declared under that name any more").toBeGreaterThan(-1);
    const body = src.slice(from, src.indexOf("\n  };", from));
    const hold = body.indexOf("setTimeout(() => dismiss(toastId), holdMs)");
    const told = body.indexOf("entry.shown?.()");
    expect(hold, "the hold is not armed in the layout handler").toBeGreaterThan(-1);
    expect(told, "the pill never tells the window it is on screen").toBeGreaterThan(-1);
    expect(told, "the window was re-armed before the pill's own hold").toBeGreaterThan(hold);
    /* Once per entry: the early return for a laid-out id stands above both. */
    expect(body.indexOf("if (hold.current.id === toastId) return;")).toBeLessThan(hold);
  });

  it("the census can see an absence — the positive control", () => {
    expect(callsIn(CHROME, "NoSuchFunction")).toEqual([]);
    expect(callsIn(CHROME, "ToastPill")).toContain("onScreen");
  });
});
