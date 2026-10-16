/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseHash, goTriage, TRIAGE_PILES } from "../app/shell/routing";
import { shellFrameOf } from "./source-anchor";
import {
  act,
  answerSyncWith,
  installShellEnv,
  mailbox,
  mountShell,
  page,
  teardownShellEnv,
} from "./fixtures/live-walk-shell";

/**
 * THE THREE TRIAGE HORIZONS ARE THREE PLACES, AND THE PILES HAVE NUMBERS.
 *
 * Two reports, one seam — the rail.
 *
 * ── THE DIAGNOSIS THIS FILE PINS ──────────────────────────────────────────────────────
 *
 * *"the triage answer later .. etc. can't be selected individually, only Answer Later opens
 * on all 3"*. Exactly right, and it was three failures stacked:
 *
 *   1. `Route` had no representation for a triage pile at all — `view`, `tagId`,
 *      `screenerSegment`, and nothing else. Park was not unbound, it was unSAYable.
 *   2. `AppShell`'s rail handler was `if (id.startsWith("triage")) go("triage")`, which
 *      matched all three rows and discarded which one had been pressed.
 *   3. `activeRailId` mapped `view === "triage"` back to the literal `"triage"` — the Answer
 *      Later row — so the rail lit the first row however you had arrived.
 *
 * Each of the three gets an assertion, because fixing any two of them still leaves the bug.
 */

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/**
 * Source with the `//` comments taken out.
 *
 * The negative assertions below forbid the OLD code, and the comments beside the fix quote
 * that old code deliberately — it is how the next reader learns what the line is for. Matching
 * the raw text would make describing a defect indistinguishable from shipping it, which is a
 * rule that punishes the documentation and not the bug.
 */
const codeOnly = (src: string): string =>
  src.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*")).join("\n");

describe("the route can say which pile is open", () => {
  it("#/triage, #/triage/aside and #/triage/resurface are three different routes", () => {
    expect(parseHash("#/triage").triagePile).toBe("reply");
    expect(parseHash("#/triage/aside").triagePile).toBe("aside");
    expect(parseHash("#/triage/resurface").triagePile).toBe("resurface");
    // All three are the triage VIEW — the pile is a second axis, not a second view.
    for (const hash of ["#/triage", "#/triage/aside", "#/triage/resurface"]) {
      expect(parseHash(hash).view).toBe("triage");
    }
  });

  it("an unknown pile falls to the first one rather than 404ing", () => {
    // Same rule the screener's segments already follow: a hash somebody typed or a stale
    // bookmark lands somewhere real.
    expect(parseHash("#/triage/nonsense").triagePile).toBe("reply");
    expect(parseHash("#/triage/nonsense").view).toBe("triage");
  });

  it("the first pile keeps the bare #/triage, so existing links still land", () => {
    goTriage("reply");
    expect(window.location.hash).toBe("#/triage");
    goTriage("aside");
    expect(window.location.hash).toBe("#/triage/aside");
  });

  it("every pile round-trips through the hash", () => {
    for (const pile of TRIAGE_PILES) {
      goTriage(pile);
      expect(parseHash(window.location.hash).triagePile).toBe(pile);
    }
  });
});

describe("the shell reads the pile back out", () => {
  /* TWO FRAMES, because the claim has two halves in two places (ARCH-022 L6): the rail's own
     `onNavigate` handler is JSX and stayed in `AppShell.tsx`, while the digit chords, the
     conversion table and the highlight moved to `shell-keys.tsx`. `numberNav` is the name the
     manifest resolver finds there — `railGroups` and `activeRailId`'s neighbours carry type
     annotations, which `const <name> =` cannot match. */
  const shell = read("../app/shell/AppShell.tsx");
  const keysFrame = shellFrameOf("numberNav").source;

  it("the rail handler carries WHICH row was pressed", () => {
    // The defect verbatim: `if (id.startsWith("triage")) go("triage")` matched all three and
    // threw the answer away. Scoped to the handler rather than the file, because the comments
    // quote the old line on purpose and a whole-file match would forbid describing it.
    const nav = codeOnly(shell.slice(shell.indexOf("onNavigate={(id)"), shell.indexOf("activeTagId=")));
    expect(nav).not.toMatch(/startsWith\("triage"\)/);
    expect(nav).not.toMatch(/go\("triage"\)/);
    expect(nav).toMatch(/const pile = TRIAGE_PILE_OF_RAIL\[id\];\s*\n\s*if \(pile\) goTriage\(pile\);/);
  });

  it("the number keys convert through the SAME table, not a second opinion", () => {
    const keys = codeOnly(keysFrame.slice(keysFrame.indexOf("numberNav.map("), keysFrame.indexOf("const activeRailId")));
    expect(keys).not.toMatch(/startsWith\("triage"\)/);
    expect(keys).toMatch(/TRIAGE_PILE_OF_RAIL\[item\.id\]/);
  });

  it("the active rail row follows the open pile", () => {
    expect(keysFrame).toMatch(/\? RAIL_OF_TRIAGE_PILE\[route\.triagePile\]/);
  });

  it("the view is handed the pile and a way to change it", () => {
    expect(shell).toMatch(/pile=\{route\.triagePile\}/);
    expect(shell).toMatch(/onPile=\{goTriage\}/);
  });
});

describe("the number keys", () => {
  /* The digits are derived from the rail and both live in `shell-keys.tsx` now (ARCH-022 L6). */
  const shell = shellFrameOf("numberNav").source;

  it("are DERIVED from the rail, never written out beside it", () => {
    // A hand-written table would be a second enumeration of the nav — the shape the (i)
    // panel's hand-typed key list had, and the one the `?` sheet is generated to avoid. It
    // goes wrong the first time a group gains an item.
    expect(shell).toMatch(/railGroups\s*\n?\s*\.flatMap\(\(g\) => g\.items\)/);
    expect(shell).toMatch(/chord: String\(i \+ 1\)/);
    // Nine at most: there is no key `10`, and a tenth pile must go unnumbered rather than
    // silently shifting the rest.
    expect(shell).toMatch(/\.slice\(0, 9\)/);
  });

  it("are listed in the ? sheet, because they declare their own labels", () => {
    // The sheet is generated from the registry (`groupedBindings`), so a binding with a
    // label is a documented binding. This pins that the label is real copy and not a blank:
    // the `g` chord's own sentence for a numbered place (so the sheet folds `1` and `g o`
    // into one row), and the generic "Go to {pile}" over the rail's label for any other row.
    expect(shell).toMatch(/label: PILE_CHORD_LABEL\[item\.id\] \? t\(PILE_CHORD_LABEL\[item\.id\]!\) : t\("shortcuts\.goPile", \{ pile: item\.label \}\)/);
  });
});

/* ── the rendered shell ─────────────────────────────────────────────────────────────── */

describe("the rail is QUIET until asked", () => {
  beforeEach(() => {
    installShellEnv();
    answerSyncWith(() => page(1));
    window.location.hash = "";
  });
  afterEach(teardownShellEnv);

  it("THE QUIET STATE: no number badges on the rail rows by default", async () => {
    // The whole point of the three-layer design. A badge on every row forever is clutter
    // charged to every user so that a few learn something once — so the resting rail carries
    // counts and no keycaps, and this is the assertion that keeps it that way.
    const host = await mountShell([mailbox({ lastSyncAt: "2026-08-04T08:59:00.000Z" })]);
    const rail = host.querySelector(".rail")!;
    const caps = [...rail.querySelectorAll("kbd")].map((k) => k.textContent?.trim());
    // `/` is Search's long-standing hint and is not a number key; nothing else may be capped.
    expect(caps.filter((c) => /^[0-9]$/.test(c ?? ""))).toEqual([]);
  });

  it("a numbered row shows its key on keyboard focus, and hides it on blur", async () => {
    // The persistent-but-quiet hint that REPLACED the one-time strip: the key is on the row
    // you are pointing at or have tabbed to, and nowhere else. Focus stands in for hover here
    // because jsdom evaluates no CSS and fires no pointer geometry — but the reveal is one
    // reaction to both, so proving focus proves the mechanism. Ohbox is the first numbered
    // pile, so its key is `1`.
    const host = await mountShell([mailbox({ lastSyncAt: "2026-08-04T08:59:00.000Z" })]);
    const rail = host.querySelector(".rail")!;
    const ohbox = [...rail.querySelectorAll<HTMLButtonElement>(".ritem")].find((b) =>
      b.textContent?.includes("Ohbox"),
    )!;
    // Quiet at rest — the row carries its count, not a keycap.
    expect(ohbox.querySelector("kbd")).toBeNull();

    await act(async () => {
      ohbox.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(ohbox.querySelector("kbd")?.textContent?.trim()).toBe("1");

    await act(async () => {
      ohbox.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(ohbox.querySelector("kbd")).toBeNull();
  });

  it("pressing ? puts the keycap on every numbered row, and only on those", async () => {
    const host = await mountShell([mailbox({ lastSyncAt: "2026-08-04T08:59:00.000Z" })]);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    });

    const rail = host.querySelector(".rail")!;
    const caps = [...rail.querySelectorAll("kbd")]
      .map((k) => k.textContent?.trim())
      .filter((c) => /^[0-9]$/.test(c ?? ""));
    // Seven piles: three streams, the Screener, three triage horizons — numbered 1..7 in
    // menu order. Derived, so this is the rail's real shape and not a restatement.
    expect(caps).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
  });

  it("a number key navigates to the pile in that position", async () => {
    await mountShell([mailbox({ lastSyncAt: "2026-08-04T08:59:00.000Z" })]);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "6", bubbles: true }));
    });
    // 5/6/7 are the triage horizons, so `6` is Park — the row that could not be reached at
    // all before, by key or by click.
    expect(window.location.hash).toBe("#/triage/aside");
  });

  it("a number typed into a field is a number, not navigation", async () => {
    // `isTypingTarget` in the registry does this for every binding; asserted here because
    // number keys are the ones most likely to be typed on purpose.
    await mountShell([mailbox({ lastSyncAt: "2026-08-04T08:59:00.000Z" })]);
    window.location.hash = "#/ohbox";
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true }));
    });
    expect(window.location.hash).toBe("#/ohbox");
    input.remove();
  });
});
