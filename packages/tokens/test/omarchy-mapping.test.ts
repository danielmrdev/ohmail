/**
 * The ohmarchy mapping's production-path proof — OHMARCHY-PLAN.md §3c's acceptance:
 * "all fixtures must pass through the production path in a test".
 *
 * Three claims, each of which has a way of silently rotting without it:
 *
 *  1. `packages/tokens/omarchy/mapping.js` is BYTE-IDENTICAL to the Phase 3-zero law in
 *     `packages/tokens/spec/mapping.js`. The law lives twice (the gallery
 *     and the demo run the prototype copy as a plain <script>); byte identity is what makes
 *     "one source" true rather than aspirational.
 *  2. Every one of the 22 REAL themes, entering as its literal `colors.toml` TEXT through
 *     `mapOmarchyTheme` — the path the desktop window ships — clears every contrast floor.
 *     Not the validator beside the law; the path itself.
 *  3. The reader is honest: `parseColorsToml(raw text)` reproduces the committed byte-faithful
 *     fixture parse exactly, for every fixture, and the production path's output equals the law
 *     applied to that parse — so the text → tokens pipeline adds nothing and loses nothing.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { clearsFloors, mapOmarchyTheme, omarchyMap } from "../omarchy/map.js";
import { parseColorsToml } from "../omarchy/colors-toml.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const omarchyDir = join(here, "..", "omarchy");
const rawDir = join(omarchyDir, "fixtures", "raw");
const protoMapping = join(here, "..", "spec", "mapping.js");

interface Fixture {
  slug: string;
  mode: string;
  colors: Record<string, string>;
}

const slugs = readdirSync(rawDir)
  .filter((f) => f.endsWith(".colors.toml"))
  .map((f) => f.replace(/\.colors\.toml$/, ""))
  .sort();

/** A chip's `rgba(r,g,b,a)` wash over one ground, through the law's own 8-bit `mix`. */
function chipGround(wash: string, ground: string): string {
  const m = wash.match(/^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/);
  if (!m) throw new Error(`not a chip wash: ${wash}`);
  const rgb = `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
  return omarchyMap().mix(ground, rgb, Number(m[4]));
}

const rawOf = (slug: string) => readFileSync(join(rawDir, `${slug}.colors.toml`), "utf8");
const fixtureOf = (slug: string): Fixture =>
  JSON.parse(readFileSync(join(omarchyDir, "fixtures", `${slug}.json`), "utf8")) as Fixture;

describe("the ohmarchy mapping, production path", () => {
  it("carries all 22 themes — the fixture set is complete", () => {
    expect(slugs).toHaveLength(22);
    expect(slugs).toContain("rose-pine");
    expect(slugs).toContain("tokyo-night");
    expect(slugs).toContain("flexoki-light");
  });

  it("mapping.js is byte-identical to the Phase 3-zero law", () => {
    expect(readFileSync(join(omarchyDir, "mapping.js"), "utf8")).toBe(
      readFileSync(protoMapping, "utf8"),
    );
  });

  it("reads every real colors.toml into exactly the committed byte-faithful parse", () => {
    for (const slug of slugs) {
      const parsed = parseColorsToml(rawOf(slug));
      const fixture = fixtureOf(slug);
      expect(parsed, slug).not.toBeNull();
      expect(parsed!.mode, slug).toBe(fixture.mode);
      expect(parsed!.colors, slug).toEqual(fixture.colors);
    }
  });

  it("every theme clears every floor THROUGH the production path", () => {
    const MAP = omarchyMap();
    for (const slug of slugs) {
      const mapped = mapOmarchyTheme({ colorsToml: rawOf(slug) });
      expect(mapped, slug).not.toBeNull();
      const t = mapped!.tokens;
      const panel = t["--panel"];
      // The floors of OHMARCHY-TOKENS.md §1, verbatim.
      expect(MAP.contrast(t["--ink"], panel), `${slug} ink`).toBeGreaterThanOrEqual(4.5);
      expect(MAP.contrast(t["--ink2"], panel), `${slug} ink2`).toBeGreaterThanOrEqual(4.5);
      expect(MAP.contrast(t["--ink3"], panel), `${slug} ink3`).toBeGreaterThanOrEqual(4.5);
      expect(MAP.contrast(t["--accent"], panel), `${slug} accent`).toBeGreaterThanOrEqual(3);
      expect(MAP.contrast(t["--accent-ink"], panel), `${slug} accent-ink`).toBeGreaterThanOrEqual(4.5);
      expect(MAP.contrast(t["--on-accent"], t["--accent"]), `${slug} on-accent`).toBeGreaterThanOrEqual(4.5);
      expect(MAP.contrast(t["--danger"], panel), `${slug} danger`).toBeGreaterThanOrEqual(4.5);
      // A tag's ink on the chip's own ground: its wash over the tile and over the canvas.
      for (const [name] of MAP.TAG_HUES) {
        for (const [where, ground] of [["tile", panel], ["canvas", t["--canvas"]]] as const) {
          expect(
            MAP.contrast(t[`--tg-${name}-ink`], chipGround(t[`--tg-${name}-bg`]!, ground!)),
            `${slug} tg-${name} on its chip over the ${where}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(t["color-scheme"], slug).toBe(fixtureOf(slug).mode);
    }
  });

  it("the production path with no system facts equals the law applied to the parse", () => {
    const MAP = omarchyMap();
    for (const slug of slugs) {
      const viaPath = mapOmarchyTheme({ colorsToml: rawOf(slug) });
      const fixture = fixtureOf(slug);
      const viaLaw = MAP.mapTheme({ mode: fixture.mode, colors: fixture.colors });
      expect(viaPath!.tokens, slug).toEqual(viaLaw.tokens);
      expect(viaPath!.mode, slug).toBe(viaLaw.mode);
    }
  });

  it("a weak palette engages the fallback walks and still clears the floor", () => {
    // A palette whose accent is nearly the panel color: without `ensure`'s walk this fails
    // the 3:1 structural floor outright — the note proves the fallback FIRED, the contrast
    // proves it SUFFICED. (Deleting the walk from the law turns this red; so does weakening
    // the floor, because the note assertion pins the walk's existence.)
    const weak = [
      'mode = "dark"',
      'background = "#202020"',
      'foreground = "#d0d0d0"',
      'dark_foreground = "#808080"',
      'accent = "#2a2a2a"',
      'red = "#252525"',
    ].join("\n");
    const mapped = mapOmarchyTheme({ colorsToml: weak });
    expect(mapped).not.toBeNull();
    const MAP = omarchyMap();
    expect(MAP.contrast(mapped!.tokens["--accent"], mapped!.tokens["--panel"])).toBeGreaterThanOrEqual(3);
    expect(MAP.contrast(mapped!.tokens["--danger"], mapped!.tokens["--panel"])).toBeGreaterThanOrEqual(4.5);
    expect(mapped!.notes.some((n) => n.slot === "--accent")).toBe(true);
    expect(mapped!.notes.some((n) => n.slot === "--danger")).toBe(true);
  });

  it("a tag ink that reads on the bare tile but not on its own chip is refused", () => {
    // tokyo-night's cyan reads 4.5:1 on the tile and 4.44:1 on its own wash over it, so the
    // output check must ask the chip's ground, or a live theme ships a tag under the floor.
    const MAP = omarchyMap();
    const t = mapOmarchyTheme({ colorsToml: rawOf("tokyo-night") })!.tokens;
    expect(clearsFloors(MAP, t)).toBe(true);
    expect(MAP.contrast("#449dab", t["--panel"]!)).toBeGreaterThanOrEqual(4.5);
    expect(clearsFloors(MAP, { ...t, "--tg-pottery-ink": "#449dab" })).toBe(false);
  });

  it("rose-pine — the measured worst case — arrives walked, not failed", () => {
    const mapped = mapOmarchyTheme({ colorsToml: rawOf("rose-pine") });
    expect(mapped!.notes.length).toBeGreaterThan(0);
  });

  it("a palette the walks cannot save is refused, not shipped under the floor", () => {
    // `ensure` mixes toward the palette's own foreground; when the foreground itself sits
    // near the background, every walk runs to its end and still lands under the floor —
    // ~1.4:1 here against promised 4.5:1. The production path must answer null (keep the
    // last good theme), never a "success" whose floors are fiction. Deleting the output
    // floor check in map.ts turns this red.
    const unreadable = [
      'mode = "dark"',
      'background = "#202020"',
      'foreground = "#303030"',
      'dark_foreground = "#282828"',
      'accent = "#2a2a2a"',
      'red = "#252525"',
    ].join("\n");
    expect(mapOmarchyTheme({ colorsToml: unreadable })).toBeNull();
  });

  it("unreadable material answers null — the caller keeps the last good theme", () => {
    expect(mapOmarchyTheme({ colorsToml: "" })).toBeNull();
    expect(mapOmarchyTheme({ colorsToml: "not a theme at all" })).toBeNull();
    // The two poles are required; a palette without them is refused, not guessed at.
    expect(mapOmarchyTheme({ colorsToml: 'foreground = "#ffffff"' })).toBeNull();
    // A background the color math cannot read is refused by the law; the path turns that
    // throw into null rather than letting broken chrome render.
    expect(
      mapOmarchyTheme({
        colorsToml: ['mode = "dark"', 'background = "purple"', 'foreground = "#fff"'].join("\n"),
      }),
    ).toBeNull();
  });

  it("a theme without a mode key falls back to background luminance, both ways", () => {
    const dark = parseColorsToml('background = "#101010"\nforeground = "#e0e0e0"');
    const light = parseColorsToml('background = "#f0f0f0"\nforeground = "#202020"');
    expect(dark!.mode).toBe("dark");
    expect(light!.mode).toBe("light");
  });
});
