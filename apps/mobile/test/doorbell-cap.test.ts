/**
 * ═══ THE DOORBELL SHOWS FOUR FACES AND A COUNT ══════════════════════════════════════════════
 *
 * The phone's doorbell drew one circle per waiting sender: a long queue drew as many letters, and the
 * sentence that says how many — with "Screener" beside it — went off the right-hand edge, so the
 * capsule became a row of initials with no way to act on it. The browser has capped at four since
 * an account with a long queue measured far wider than the capsule (`packages/ui/src/composites/Doorbell.tsx`).
 *
 * The rule is matched to the letter rather than re-invented, and this file drives BOTH halves of
 * matching it: the arithmetic, and the label naming the FULL count while the overflow chip is
 * hidden from the screen reader — a stack of four beside a spoken "4 new senders" would be the
 * same lie in a different modality.
 *
 * ── MUTATIONS WATCHED (each restored, `cmp`-proven) ────────────────────────────────────────
 *
 *  · `DOORBELL_MAX = 4` → `351`                                  ⇒ "nine waiting" RED.
 *  · `doorbellFaces` returns `initials` unsliced                 ⇒ "nine waiting" RED.
 *  · `Copy.doorbellAria(count, …)` → `Copy.doorbellAria(shown.length, …)` in `chrome.tsx`
 *                                                                 ⇒ "the label names the count" RED.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Copy } from "../src/copy";
import { DE } from "../src/copy.de";
import { DOORBELL_MAX, doorbellFaces } from "../src/ui/doorbell-stack";

const chrome = readFileSync(fileURLToPath(new URL("../src/ui/chrome.tsx", import.meta.url)), "utf8");
const letters = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i));

describe("four faces, then a figure", () => {
  it("the web's number, not a second opinion", () => {
    const web = readFileSync(
      fileURLToPath(new URL("../../../packages/ui/src/composites/Doorbell.tsx", import.meta.url)),
      "utf8",
    );
    const named = /const DEFAULT_MAX = (\d+);/.exec(web);
    expect(named, "the browser doorbell no longer names its cap").not.toBeNull();
    expect(DOORBELL_MAX).toBe(Number(named![1]));
  });

  it("nine waiting draws four chips and +5", () => {
    const stack = doorbellFaces(letters(9));
    expect(stack.shown).toEqual(["A", "B", "C", "D"]);
    expect(stack.overflow).toBe(5);
    expect(Copy.doorbellMore(stack.overflow)).toBe("+5");
  });

  it("four waiting draws four chips and NO overflow", () => {
    const stack = doorbellFaces(letters(4));
    expect(stack.shown).toHaveLength(4);
    expect(stack.overflow).toBe(0);
  });

  it("one waiting draws one chip", () => {
    expect(doorbellFaces(letters(1))).toEqual({ shown: ["A"], overflow: 0 });
  });

  it("351 waiting still draws four", () => {
    // The measurement that started this. The capsule's width must not depend on the queue.
    const stack = doorbellFaces(letters(26).concat(letters(26)).slice(0, 26), DOORBELL_MAX);
    expect(stack.shown).toHaveLength(4);
    const big = doorbellFaces(Array.from({ length: 351 }, () => "S"));
    expect(big.shown).toHaveLength(4);
    expect(big.overflow).toBe(347);
  });

  it("`max = 0` shows no faces rather than dropping exactly one", () => {
    // `slice(0, -1)` is the bug this arm exists for: it would hide one sender and report the
    // rest as if nothing were missing.
    expect(doorbellFaces(letters(3), 0)).toEqual({ shown: [], overflow: 3 });
    expect(doorbellFaces(letters(3), -2)).toEqual({ shown: [], overflow: 3 });
  });

  it("the overflow figure reads the deck on BOTH sides", () => {
    // A figure, but still a string on screen: a locale that writes it differently owns it.
    expect(Copy.doorbellMore(347)).toBe("+347");
    expect(DE.doorbellMore(347)).toBe("+347");
  });
});

describe("the capsule speaks the full count, the chip speaks to nobody", () => {
  it("the label names the COUNT, never the number of faces drawn", () => {
    // The whole point of capping: the figure moves into the label. An aria label built from the
    // stack would say "4 new senders waiting" to a reader with 351 at the gate.
    expect(chrome).toContain("Copy.doorbellAria(count, Copy.doorbellGo)");
    expect(Copy.doorbellAria(9, Copy.doorbellGo)).toContain("9");
    expect(DE.doorbellAria(9, DE.doorbellGo)).toContain("9");
  });

  it("the overflow chip is hidden from the screen reader, both platforms", () => {
    // RN needs both props: iOS reads `accessibilityElementsHidden`, Android
    // `importantForAccessibility`. One of the two is half a fix.
    expect(chrome).toContain("accessibilityElementsHidden");
    expect(chrome).toContain('importantForAccessibility="no-hide-descendants"');
  });

  it("the component holds no cap of its own", () => {
    // The rule lives in `doorbell-stack.ts`. A `slice(` back in the component would be a second
    // spelling, which is how the phone and the browser drifted apart in the first place.
    expect(chrome).toContain("doorbellFaces(initials, cap)");
    expect(/initials\.slice\s*\(/.test(chrome), "chrome.tsx re-spells the cap").toBe(false);
  });
});
