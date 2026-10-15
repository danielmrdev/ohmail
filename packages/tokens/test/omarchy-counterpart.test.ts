/**
 * THE SCHEME AN OMARCHY THEME DOES NOT HAVE, over all 22 real themes.
 *
 * `omarchy-mapping.test.ts` proves the theme's OWN scheme through the production path. The
 * scheme control has three states, so the face owes a second token set per theme, and this
 * file is the proof that the second one is as readable as the first: the counterpart palette
 * goes through the UNCHANGED law, and every floor the law promises is checked on its OUTPUT —
 * plus one the law never needed, canvas against panel, because a derived pair's two surfaces
 * are mixes of one colour and nothing else would stop them collapsing into each other.
 *
 * All 22 × their counterpart, not the seven the design named: the set costs milliseconds and
 * the refusal it defends against (a theme whose counterpart ships unreadable) is per-theme.
 * Nine pin their hex, so a derivation change has to be argued in a diff rather than absorbed.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { clearsCounterpartFloors, mapOmarchyThemePair, omarchyMap } from "../omarchy/map.js";
import { counterpartPalette } from "../omarchy/counterpart.js";
import { parseColorsToml } from "../omarchy/colors-toml.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const rawDir = join(here, "..", "omarchy", "fixtures", "raw");
const slugs = readdirSync(rawDir)
  .filter((f) => f.endsWith(".colors.toml"))
  .map((f) => f.replace(/\.colors\.toml$/, ""))
  .sort();
const rawOf = (slug: string) => readFileSync(join(rawDir, `${slug}.colors.toml`), "utf8");

/** The five stock light themes — the stress cases, since a light theme's ink is near-black and
 *  its counterpart's surfaces have to come from its paper instead. */
const LIGHT = ["catppuccin-latte", "flexoki-light", "lupine", "rose-pine", "white"];

describe("the counterpart palette — every stock theme gets its other scheme", () => {
  it("scanned the set it claims to scan", () => {
    expect(slugs).toHaveLength(22);
    for (const slug of LIGHT) expect(slugs, slug).toContain(slug);
  });

  it("every theme's counterpart flips the mode and swaps the poles", () => {
    for (const slug of slugs) {
      const palette = parseColorsToml(rawOf(slug))!;
      const other = counterpartPalette(palette)!;
      expect(other, slug).not.toBeNull();
      expect(other.mode, slug).not.toBe(palette.mode);
      /* The theme's ground becomes its ink, and the accents cross verbatim — the law's walks
         are what fix their contrast against the new panel. */
      expect(other.colors.foreground, slug).toBe(palette.colors.background);
      expect(other.colors.bright_foreground, slug).toBe(palette.colors.background);
      for (const key of ["red", "yellow", "green", "blue", "magenta", "cyan", "accent"]) {
        if (palette.colors[key] === undefined) continue;
        expect(other.colors[key], `${slug} ${key}`).toBe(palette.colors[key]);
      }
    }
  });

  it("every theme's counterpart clears every floor the law promises, plus canvas against panel", () => {
    const MAP = omarchyMap();
    for (const slug of slugs) {
      const pair = mapOmarchyThemePair({ colorsToml: rawOf(slug) });
      expect(pair, slug).not.toBeNull();
      expect(pair!.counterpart, `${slug} has no counterpart`).not.toBeNull();
      const t = pair!.counterpart!.tokens;
      const panel = t["--panel"];
      expect(MAP.contrast(t["--ink"], panel), `${slug} ink`).toBeGreaterThanOrEqual(4.5);
      expect(MAP.contrast(t["--ink2"], panel), `${slug} ink2`).toBeGreaterThanOrEqual(4.5);
      expect(MAP.contrast(t["--ink3"], panel), `${slug} ink3`).toBeGreaterThanOrEqual(4.5);
      expect(MAP.contrast(t["--accent"], panel), `${slug} accent`).toBeGreaterThanOrEqual(3);
      expect(MAP.contrast(t["--accent-ink"], panel), `${slug} accent-ink`).toBeGreaterThanOrEqual(4.5);
      expect(MAP.contrast(t["--on-accent"], t["--accent"]), `${slug} on-accent`).toBeGreaterThanOrEqual(4.5);
      expect(MAP.contrast(t["--danger"], panel), `${slug} danger`).toBeGreaterThanOrEqual(4.5);
      for (const [name] of MAP.TAG_HUES) {
        expect(MAP.contrast(t[`--tg-${name}-ink`], panel), `${slug} tg-${name}`).toBeGreaterThanOrEqual(4.5);
      }
      /* A tile must read as a tile. The shipped static pairs sit at 1.09 (tokyo-night dark)
         and 1.14 (flexoki-light), so 1.06 is the floor and not the target. */
      expect(MAP.contrast(t["--canvas"], panel), `${slug} canvas/panel`).toBeGreaterThanOrEqual(1.06);
      /* And it is the scheme the theme does not state. */
      expect(pair!.counterpart!.mode, slug).not.toBe(pair!.mode);
    }
  });

  it("every theme's counterpart is a whole set — the same slots as its own scheme", () => {
    for (const slug of slugs) {
      const pair = mapOmarchyThemePair({ colorsToml: rawOf(slug) })!;
      expect(Object.keys(pair.counterpart!.tokens).sort(), slug).toEqual(
        Object.keys(pair.native.tokens).sort(),
      );
    }
  });

  /**
   * THE PINS. Seven from the design plus flexoki-light, the second light stress case, and
   * catppuccin-latte's reminder in the comment: latte's dark counterpart is latte's own ink
   * and paper swapped — it is NOT mocha, and no copy anywhere may call it the theme's dark
   * variant.
   */
  it("the named themes pin their counterpart's panel, ink and accent", () => {
    const PINS: Record<string, [string, string, string]> = {
      "tokyo-night": ["#f8f9fc", "#1a1b26", "#6c8ed8"],
      catppuccin: ["#fbfcfe", "#1e1e2e", "#6e8fc7"],
      gruvbox: ["#fcfaf7", "#282828", "#6c938a"],
      everforest: ["#fbfaf8", "#2d353b", "#6b9a95"],
      nord: ["#fcfcfd", "#2e3440", "#7591ae"],
      "rose-pine": ["#1c1b1a", "#faf4ed", "#56949f"],
      "catppuccin-latte": ["#1a1b1b", "#eff1f5", "#1e66f5"],
      "flexoki-light": ["#1c1c1a", "#FFFCF0", "#366ead"],
    };
    for (const [slug, [panel, ink, accent]] of Object.entries(PINS)) {
      const t = mapOmarchyThemePair({ colorsToml: rawOf(slug) })!.counterpart!.tokens;
      expect([t["--panel"], t["--ink"], t["--accent"]], slug).toEqual([panel, ink, accent]);
    }
  });

  /**
   * THE REFUSAL, and its positive control beside it. A palette the colour math cannot read has
   * no counterpart, and `mapOmarchyThemePair` then answers a theme whose own scheme maps and
   * whose other one falls back to the static face block — never a half-mapped set.
   */
  it("material the colour math cannot read gets no counterpart, and the theme still maps", () => {
    const MAP = omarchyMap();
    const unreadable = counterpartPalette({ mode: "dark", colors: { background: "#111111", foreground: "not-a-colour" } });
    expect(unreadable).toBeNull();
    const readable = counterpartPalette({ mode: "dark", colors: { background: "#111111", foreground: "#dddddd" } });
    expect(readable).not.toBeNull();
    expect(clearsCounterpartFloors(MAP, { "--canvas": "#ffffff", "--panel": "#ffffff" })).toBe(false);
  });
});
