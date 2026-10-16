/**
 * THE CLASSIC BYTE-STABILITY PIN for the Zero layout (OHMARCHY-PLAN §3b) — the
 * faces-paper-purity argument, applied to the layout axis:
 *
 *  1. Classic is the ABSENT state of `data-layout`, so `zero-layout.css` can never match a
 *     classic document: every selector in it requires `[data-layout="zero"]`. A classic
 *     page therefore computes exactly what it computed before the file existed.
 *  2. The layout stylesheet CONSUMES tokens and declares none — a custom property defined
 *     here would be an appearance value living outside the token home.
 *  3. The two DOM additions this slice makes for the ribbon are invisible by themselves:
 *     the rail-head ≡ is hidden UNCONDITIONALLY by app.css (only zero reveals it), and
 *     `data-nav-key` is an attribute nothing but zero-layout.css reads.
 *  4. The §12 ladder's CSS bands are pinned by their exact numbers — an off-by-one edit to
 *     any breakpoint is red here by name (the JS half's exactness is
 *     test/zero-layout.test.tsx's boundary block).
 *
 * Mutation-proven at authoring time: a bare `.deck{}` rule added to zero-layout.css went
 * red on (1); `--gap-tile: 4px` planted in it went red on (2); deleting the app.css
 * `.rail-expand` base went red on (3); 722 → 723 went red on (4).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

const zeroCss = readFileSync(here("../app/zero-layout.css"), "utf8");
const appCss = readFileSync(here("../app/app.css"), "utf8");

/** Every selector (the text before each top-level `{`), media preludes skipped —
 *  faces-paper-purity's own extractor. */
function selectors(css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  let buf = "";
  for (const ch of clean) {
    if (ch === "{") {
      const sel = buf.trim();
      if (sel && !sel.startsWith("@")) out.push(sel);
      buf = "";
    } else if (ch === "}") {
      buf = "";
    } else buf += ch;
  }
  return out;
}

describe("zero-layout.css cannot touch a classic document", () => {
  it('every selector requires [data-layout="zero"]', () => {
    const sels = selectors(zeroCss);
    expect(sels.length).toBeGreaterThan(0);
    for (const sel of sels) {
      for (const alt of sel.split(",")) {
        expect(alt, `unguarded selector in zero-layout.css: "${alt.trim()}"`).toContain(
          '[data-layout="zero"]',
        );
      }
    }
  });

  it("declares no custom properties — the layout consumes tokens, never defines them", () => {
    const clean = zeroCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(clean.match(/--[\w-]+\s*:/g) ?? []).toEqual([]);
  });
});

describe("the ribbon's DOM additions are invisible in classic", () => {
  it("app.css hides .rail-expand unconditionally (zero alone reveals it)", () => {
    const clean = appCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(clean).toMatch(/\.rail-expand\s*\{\s*display:\s*none;?\s*\}/);
  });

  it("data-nav-key is read only by the layout home", () => {
    // A classic stylesheet growing a data-nav-key rule would paint the attribute where it
    // is meant to be inert. The census's homes check covers [data-layout]; this covers the
    // attribute the ribbon paints from.
    expect(appCss).not.toContain("data-nav-key");
    expect(zeroCss).toContain("attr(data-nav-key)");
  });
});

describe("the ribbon stands DOCKED — §12: it never auto-floats", () => {
  it("the minified rail is static and in flow; only .open may float", () => {
    // The ruled model: a collapsed rail is a PERSISTENT DOCKED state; FLOATING happens only
    // by the user's hand (`.open` — ≡ or `h`). The docked form must therefore be scoped to
    // `:not(.open)` and stand `position: static`; a `fixed`/`absolute` here IS the rejected
    // auto-float. (The computed-style half of this pin runs in the real-browser ladder
    // audit, a probe outside this suite.)
    const clean = zeroCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const docked = /\.deck > \.rail:not\(\.open\)\s*\{([^}]*)\}/.exec(clean);
    expect(docked, "the docked ribbon rule (.deck > .rail:not(.open)) is gone").toBeTruthy();
    expect(docked![1]).toMatch(/position:\s*static/);
    expect(docked![1]).not.toMatch(/position:\s*(fixed|absolute)/);
  });
});

describe("the §12 ladder's CSS bands, by their exact numbers", () => {
  it("the four bands are the ruled ones", () => {
    for (const prelude of [
      "@media (min-width: 392px) and (max-width: 1023.98px)", // ribbon tiers (docked 52px rail)
      "@media (min-width: 722px) and (max-width: 1023.98px)", // ribbon + surviving split
      "@media (min-width: 392px) and (max-width: 721px)", // ribbon + one-tile push-nav
      "@media (max-width: 391px)", // floating tier
    ]) {
      expect(zeroCss, `ladder band missing or drifted: ${prelude}`).toContain(prelude);
    }
    // No band this file did not declare: every width prelude is one of the four. The one other
    // prelude is not a band — the touch rule's half for this layout's re-shown hint strips.
    const preludes = [...zeroCss.matchAll(/@media[^{]+/g)].map((m) => m[0].trim());
    expect(preludes.filter((p) => /width/.test(p))).toHaveLength(4);
    expect(preludes.filter((p) => !/width/.test(p))).toEqual(["@media (pointer: coarse)"]);
  });
});
