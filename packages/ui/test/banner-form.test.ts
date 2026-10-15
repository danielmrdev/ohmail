/** @vitest-environment jsdom */
/**
 * BANNER — its form is decided by ONE media rule on the shell's own breakpoint.
 *
 * A media query cannot read a custom property, so the breakpoint in `banner.css` is a literal, and
 * this is what keeps that literal honest: it must equal `layout.mobileMax + 1` from `@ohmail/tokens`
 * — the same 1024px the rail's drawer turns on — and `position: sticky` may appear ONLY inside
 * that rule. A `position` written outside it would pin the banner at every width, which is the
 * form the phone must not have; a second breakpoint typed by hand would pin it on a tablet the
 * rest of the shell treats as a phone.
 *
 * The rendered form at 390 and 1440 is read in a real browser by `scripts/fit-render.mjs` (the
 * banner specimen scrolls its list and reads whether the banner moved); this file holds the rule
 * the rendering depends on. Mutation-proven: changing the literal to 640px reddens the pin case;
 * moving `position:sticky` out of the media block reddens the containment case.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { layout } from "@ohmail/tokens";
import { Banner } from "@ohmail/ui";

afterEach(cleanup);

const css = readFileSync(resolve(__dirname, "..", "src", "primitives", "banner.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

describe("banner.css — one rule decides the form", () => {
  it("the one min-width rule is the shell's desktop breakpoint, read from the tokens", () => {
    const rules = [...css.matchAll(/@media\s*\(min-width:\s*(\d+)px\)/g)].map((m) => Number(m[1]));
    expect(rules, "exactly one min-width rule").toHaveLength(1);
    expect(rules[0]).toBe(layout.mobileMax + 1);
  });

  it("`position: sticky` lives only inside that rule, and no other position is declared", () => {
    const at = css.indexOf("@media (min-width:");
    const outside = css.slice(0, at);
    const inside = css.slice(at);
    expect(outside).not.toMatch(/position\s*:/);
    expect(inside).toMatch(/\.banner\{[^}]*position:sticky/);
    // The ring's room at the top, as the scroller reserves it (list-pane.css), plus the banner's
    // own top margin — the stuck position equals the resting one.
    expect(inside).toMatch(/top:calc\(var\(--focus-w\) \* var\(--teach\) \+ 4px\)/);
    expect(outside).toMatch(/\.banner\{[^}]*margin:4px 16px 8px/);
  });

  it("no width is decided in the component — the stylesheet is the only place", () => {
    // Comments stripped first: the docblock NAMES the hook it forbids, and a guard that reads prose
    // fails on the sentence that explains it.
    const src = readFileSync(resolve(__dirname, "..", "src", "primitives", "Banner.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(src).not.toMatch(/innerWidth|matchMedia|useNarrow/);
  });
});

describe("Banner — the element", () => {
  it("is a status by default, with the sentence and its one verb in named slots", () => {
    const { container, getByRole } = render(
      createElement(Banner, { action: createElement("button", { type: "button" }, "Away settings"), children: "Away responder is on." }),
    );
    const el = getByRole("status");
    expect(el.classList.contains("banner")).toBe(true);
    expect(container.querySelector(".banner-text")!.textContent).toBe("Away responder is on.");
    expect(container.querySelector(".banner-act button")!.textContent).toBe("Away settings");
  });

  it("can be a note, and keeps a caller's className", () => {
    const { getByRole } = render(createElement(Banner, { role: "note", className: "ohx-away", children: "A fact." }));
    const el = getByRole("note");
    expect(el.classList.contains("ohx-away")).toBe(true);
  });
});
