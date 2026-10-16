/** @vitest-environment jsdom */
/**
 * THE THEME PROVIDER PERSISTS THROUGH A DOOR IT DOES NOT OWN — or persists nothing, and says so.
 *
 * What was true before: this provider wrote `localStorage` itself, seven times, each inside a
 * `try` whose `catch` was a comment. In a private window "your theme is remembered" was a claim
 * nobody checked, and there was no way to fix it here — the door that ANSWERS lived in
 * `apps/webapp` and a package may not import from an app. The direction is inverted now: ui
 * declares the `StorageDoor` shape, the host hands one in, and this file imports nothing new.
 *
 * WITH NO DOOR THE STATE IS NAMED. `persistence: "unpersisted"` is a first-class answer — the
 * choice holds for the session and NOTHING is written — rather than a silent fallback to a direct
 * write behind the door's back.
 *
 * ── THE MUTATIONS EVERY CASE HERE WAS WATCHED AGAINST ───────────────────────────────────────
 *
 *  · `doorRef.current.set(storageKey, stored)` → `window.localStorage.setItem(storageKey, stored)`
 *    → "no door writes nothing" goes red: the jar holds the value;
 *  · `persistence = storage !== undefined && storageKey !== null ? "door" : "unpersisted"` →
 *    `"door"` unconditionally → "no door writes nothing" goes red (NO_DOOR is bypassed);
 *  · `doorRef.current = persistence === "door" && storage ? storage : NO_DOOR` → `storage ?? NO_DOOR`
 *    → "storageKey null still writes nothing" goes red;
 *  · `readStored(doorRef.current, storageKey)` → `readStored(NO_DOOR, storageKey)` → "a door's
 *    stored preference is adopted" goes red;
 *  · the `get` in the face adoption effect back to `window.localStorage?.getItem` → "every read
 *    goes through the door too" goes red, because the door's jar is not the window's.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { ThemeProvider, useTheme, type ThemeContextValue } from "@ohmail/ui";

import { jarDoor, refusingJar } from "./storage-door.js";

let ctx: ThemeContextValue | null = null;
function Probe() {
  ctx = useTheme();
  return <span data-testid="probe">{ctx.preference}:{ctx.face}:{ctx.persistence}</span>;
}

/** The mounted provider's context, or a refusal — never an optional chain that reads as absent. */
function theme(): ThemeContextValue {
  if (ctx === null) throw new Error("no ThemeProvider is mounted");
  return ctx;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.face;
  delete document.documentElement.dataset.layout;
  ctx = null;
});

/** A jar of its own, so "wrote through the door" cannot be satisfied by the window's jar. */
function ownJar(seed: Record<string, string> = {}): Storage {
  const kept = new Map(Object.entries(seed));
  return {
    get length() { return kept.size; },
    clear: () => kept.clear(),
    getItem: (k: string) => kept.get(k) ?? null,
    key: (i: number) => [...kept.keys()][i] ?? null,
    removeItem: (k: string) => void kept.delete(k),
    setItem: (k: string, v: string) => void kept.set(k, v),
  } as Storage;
}

describe("ThemeProvider with a door", () => {
  it("adopts the door's stored preference and writes the next one back through it", () => {
    const jar = ownJar({ "ohmail.theme": "dark" });
    const door = jarDoor(jar);
    render(<ThemeProvider storage={door}><Probe /></ThemeProvider>);
    expect(theme().persistence).toBe("door");
    expect(theme().preference, "the door's value, not the window's jar").toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    act(() => { theme().setTheme("light"); });
    expect(jar.getItem("ohmail.theme")).toBe("light");
    expect(window.localStorage.getItem("ohmail.theme"), "the window's jar is untouched").toBeNull();
    expect(door.calls).toContain("set ohmail.theme=light");
  });

  it("survives a remount through the door, which is what persistence means", () => {
    const jar = ownJar();
    const first = render(<ThemeProvider storage={jarDoor(jar)}><Probe /></ThemeProvider>);
    act(() => { theme().setTheme("dark"); });
    first.unmount();
    ctx = null;
    render(<ThemeProvider storage={jarDoor(jar)}><Probe /></ThemeProvider>);
    expect(theme().preference).toBe("dark");
  });

  it("every face and layout read goes through the door too, not the window's jar", () => {
    const jar = ownJar({
      "ohmail.face": "ohmarchy",
      "ohmail.face.account": "paper",
      "ohmail.layout": "zero",
    });
    const door = jarDoor(jar);
    render(<ThemeProvider faces storage={door}><Probe /></ThemeProvider>);
    expect(theme().facePreference).toBe("ohmarchy");
    expect(theme().accountFace).toBe("paper");
    expect(theme().layout).toBe("zero");
    for (const key of ["ohmail.face", "ohmail.face.account", "ohmail.layout"]) {
      expect(door.calls, `${key} was not read through the door`).toContain(`get ${key}`);
    }
  });

  it("a door that answers LOST still applies the choice, and answers lost once per write", () => {
    const door = jarDoor(refusingJar());
    render(<ThemeProvider faces storage={door}><Probe /></ThemeProvider>);
    act(() => { theme().setTheme("dark"); });
    // The in-memory choice and the stamp are unaffected — that is the degradation, and it is
    // why the door answers rather than throws.
    expect(theme().preference).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(door.set("probe", "x"), "the double must fail the way a private window fails").toBe("lost");
  });
});

describe("ThemeProvider with NO door", () => {
  it("is unpersisted: nothing is written, and the state says so", () => {
    window.localStorage.setItem("ohmail.theme", "dark");
    render(<ThemeProvider faces><Probe /></ThemeProvider>);
    expect(theme().persistence).toBe("unpersisted");
    // The stored value is NOT adopted: with no door there is nothing to read it through.
    expect(theme().preference).toBe("system");

    act(() => { theme().setTheme("light"); });
    act(() => { theme().setFace("ohmarchy"); });
    act(() => { theme().setLayout("zero"); });
    act(() => { theme().adoptAccountFace("paper"); });
    // The session still holds the choices…
    expect(theme().preference).toBe("light");
    expect(theme().face).toBe("ohmarchy");
    expect(theme().layout).toBe("zero");
    // …and the jar was never touched: the seeded value is still exactly what was seeded.
    expect(window.localStorage.getItem("ohmail.theme")).toBe("dark");
    expect(window.localStorage.getItem("ohmail.face")).toBeNull();
    expect(window.localStorage.getItem("ohmail.layout")).toBeNull();
    expect(window.localStorage.getItem("ohmail.face.account")).toBeNull();
  });

  it("loses the choice on a remount — which is what unpersisted promises", () => {
    const first = render(<ThemeProvider><Probe /></ThemeProvider>);
    act(() => { theme().setTheme("dark"); });
    first.unmount();
    ctx = null;
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(theme().preference).toBe("system");
  });

  /**
   * `storageKey === null` is the host's EXPLICIT opt-out (showcases, tests) and reaches the same
   * named state — two causes, one answer, because nothing downstream cares which. A door passed
   * with it writes nothing either: the key is the stronger statement.
   */
  it("storageKey null is unpersisted even WITH a door", () => {
    const jar = ownJar();
    const door = jarDoor(jar);
    render(<ThemeProvider faces storageKey={null} storage={door}><Probe /></ThemeProvider>);
    expect(theme().persistence).toBe("unpersisted");
    act(() => { theme().setTheme("dark"); });
    act(() => { theme().setFace("ohmarchy"); });
    expect(theme().preference).toBe("dark");
    expect(jar.length, "storageKey null must reach no jar at all").toBe(0);
    expect(door.calls.filter((c) => c.startsWith("set"))).toEqual([]);
  });
});

describe("the door prop's identity", () => {
  /**
   * A door built INLINE is a new object every render. Hosts hoist theirs to module scope, and the
   * provider reads it through a ref so that a host that does not is merely wasteful rather than
   * broken — no effect re-runs on it, no adoption loop.
   */
  it("a door rebuilt every render does not re-run adoption or lose the choice", () => {
    const jar = ownJar({ "ohmail.theme": "dark" });
    function Host({ tick }: { tick: number }) {
      return (
        <ThemeProvider storage={jarDoor(jar)}>
          <Probe />
          <span data-testid="tick">{tick}</span>
        </ThemeProvider>
      );
    }
    const { rerender, getByTestId } = render(<Host tick={0} />);
    act(() => { theme().setTheme("light"); });
    for (let i = 1; i <= 4; i++) rerender(<Host tick={i} />);
    expect(getByTestId("tick").textContent).toBe("4");
    // A re-run adoption effect would have put "dark" back over the click — "user wins".
    expect(theme().preference).toBe("light");
    expect(jar.getItem("ohmail.theme")).toBe("light");
  });
});
