/** @vitest-environment jsdom */
/**
 * THE UNDO CAPSULE KEEPS ITS SLOT. The host drew one capsule, so a notice raised inside an Undo
 * window — a suggestion batch's summary 300 ms after a Screener decision, measured — replaced the
 * capsule and took the Undo with it. Two slots now: the Undo capsule holds its own for its whole
 * duration, a notice shows beneath it on its own timer, a notice replaces a notice and an action
 * an action, and the notice's arrival lifts the capsule clear of it once, never mid-press.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ToastHost, useToast, type ToastFn } from "@ohmail/ui";

let say: ToastFn = () => undefined;
function Grab(): null {
  say = useToast();
  return null;
}

const UNDO_MS = 8000;
const held = (): HTMLElement | null => document.querySelector(".toast-held");
const notice = (): HTMLElement => document.querySelectorAll<HTMLElement>('[role="status"]')[1]!;
const undoButton = (): HTMLButtonElement | null => document.querySelector(".toast-held .toast-act");
const lift = (): string => held()?.style.getPropertyValue("--toast-lift") ?? "";
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  render(<ToastHost><Grab /></ToastHost>);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a notice inside an Undo window", () => {
  it("(a) the Undo capsule stays on screen with its button, the notice shows beneath it and leaves on its own", () => {
    const onAction = vi.fn();
    act(() => say("Ohbox — filed.", { action: "Undo", onAction, duration: UNDO_MS }));
    tick(200);
    act(() => say("Suggested 1 sender."));

    tick(1800); // two seconds after the decision
    expect(held()?.className).toContain("on");
    expect(held()?.textContent).toContain("Ohbox — filed.");
    expect(undoButton(), "the Undo is still offered").not.toBeNull();
    expect(notice().className).toContain("on");
    expect(notice().textContent).toBe("Suggested 1 sender.");

    tick(800); // the notice's own 2600 ms, counted from its arrival at 200
    expect(notice().className).not.toContain("on");
    expect(held()?.className, "the notice's timer is not the capsule's").toContain("on");

    fireEvent.click(undoButton()!);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(held(), "Undo dismisses the capsule it is on").toBeNull();
    expect(notice().textContent, "and nothing else").toBe("Suggested 1 sender.");
  });

  it("the capsule's own timer runs to its end whatever a notice does, then its button leaves the tree", () => {
    act(() => say("Deleted.", { action: "Undo", onAction: () => undefined, duration: UNDO_MS }));
    tick(100);
    act(() => say("Saved."));
    tick(UNDO_MS - 101);
    expect(held()?.className).toContain("on");
    tick(1);
    expect(held()?.className).not.toContain("on");
    tick(300);
    expect(held(), "a faded capsule keeps no focusable button behind").toBeNull();
    expect(undoButton()).toBeNull();
  });

  it("the notice's arrival lifts the capsule clear of it, and its leaving does not bring it down", () => {
    act(() => say("Filed.", { action: "Undo", onAction: () => undefined, duration: UNDO_MS }));
    expect(lift(), "alone, at the shipped anchor").toBe("");
    act(() => say("Suggested 1 sender."));
    expect(lift()).toBe("44px");
    tick(3000);
    expect(notice().className).not.toContain("on");
    expect(lift(), "moved once, on the arrival").toBe("44px");
  });

  it("a notice arriving while the Undo capsule is pressed waits for the press to end", () => {
    act(() => say("Filed.", { action: "Undo", onAction: () => undefined, duration: UNDO_MS }));
    fireEvent.pointerDown(held()!);
    act(() => say("Suggested 1 sender."));
    expect(lift(), "the button is not moved from under the pointer").toBe("");
    fireEvent.pointerUp(held()!);
    expect(lift()).toBe("44px");
  });

  it("an Undo capsule raised over a notice already standing is PLACED above it", () => {
    act(() => say("Saved."));
    act(() => say("Filed.", { action: "Undo", onAction: () => undefined, duration: UNDO_MS }));
    expect(lift()).toBe("44px");
    expect(notice().textContent).toBe("Saved.");
  });
});

describe("an Undo whose window closed early is withdrawn by its owner", () => {
  it("aborting the signal takes the capsule and its button out at once, and leaves the notice", () => {
    const ends = new AbortController();
    act(() => say("Filed.", { action: "Undo", onAction: () => undefined, duration: UNDO_MS, signal: ends.signal }));
    act(() => say("Could not be saved."));
    act(() => ends.abort());
    expect(held(), "no dead Undo above the act's own outcome").toBeNull();
    expect(notice().textContent).toBe("Could not be saved.");
  });

  it("a stale abort never takes the capsule that replaced it", () => {
    const first = new AbortController();
    act(() => say("Filed A.", { action: "Undo", onAction: () => undefined, duration: UNDO_MS, signal: first.signal }));
    act(() => say("Filed B.", { action: "Undo", onAction: () => undefined, duration: UNDO_MS }));
    act(() => first.abort());
    expect(held()?.textContent).toContain("Filed B.");
  });
});

describe("the controls — what replaces what", () => {
  it("(b) a notice replaces a notice, on the second's timer", () => {
    act(() => say("First."));
    tick(2000);
    act(() => say("Second."));
    expect(notice().textContent).toBe("Second.");
    tick(2000);
    expect(notice().className, "the first's timer did not take the second down").toContain("on");
    expect(held()).toBeNull();
  });

  it("(b) an action replaces an action — the person acted again", () => {
    const first = vi.fn();
    const second = vi.fn();
    act(() => say("Filed A.", { action: "Undo", onAction: first, duration: UNDO_MS }));
    tick(1000);
    act(() => say("Filed B.", { action: "Undo", onAction: second, duration: UNDO_MS }));
    expect(held()?.textContent).toContain("Filed B.");
    expect(document.querySelectorAll(".toast-act")).toHaveLength(1);
    tick(UNDO_MS - 1000);
    expect(held()?.className, "on the replacing toast's own window").toContain("on");
    fireEvent.click(undoButton()!);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("both slots are polite live regions, in the tree before anything is said", () => {
    const regions = [...document.querySelectorAll('[role="status"]')];
    expect(regions).toHaveLength(2);
    for (const r of regions) expect(r.getAttribute("aria-live")).toBe("polite");
    expect(regions.map((r) => r.textContent)).toEqual(["", ""]);
  });
});
