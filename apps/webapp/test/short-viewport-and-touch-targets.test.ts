import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * TWO LAYOUT RULES jsdom cannot measure, pinned where they are written;
 * the geometry itself was read in a real browser at 640x400 and 390x844. A short viewport makes the
 * page the one scroller, each view's own scroller one viewport tall; under a coarse pointer each
 * control that was the only way to its action reaches 44px. The block reader
 * is checked against a planted stylesheet first, so an empty read cannot pass.
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const css = read("../app/app.css");
/** The Rules chips' own sheet, which loads after `app.css`: their coarse rules live beside them. */
const rulesCss = read("../app/views/rules.css");
/** The file tiles' own sheet: the Download control's coarse rule lives beside the tile. */
const stripCss = read("../app/components/attachment-strip.css");

/** The declarations each selector gets inside the `@media` blocks whose prelude matches. */
function inMedia(text: string, prelude: RegExp): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const m of text.matchAll(/@media([^{]*)\{/g)) {
    if (!prelude.test(m[1]!.trim())) continue;
    let depth = 0;
    let end = m.index! + m[0].length - 1;
    for (let i = end; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}" && --depth === 0) { end = i; break; }
    }
    const body = text.slice(m.index! + m[0].length, end);
    for (const r of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const decls: Record<string, string> = {};
      for (const d of r[2]!.split(";")) {
        const kv = d.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/);
        if (kv) decls[kv[1]!] = kv[2]!;
      }
      for (const sel of r[1]!.split(",").map((s) => s.trim())) out.set(sel, { ...out.get(sel), ...decls });
    }
  }
  return out;
}

const px = (v: string | undefined): number => (v === undefined ? 0 : Number(v.replace(/px$/, "")) || 0);

describe("the block reader reads a planted stylesheet (positive control)", () => {
  it("finds a declaration inside a matching block and nothing inside another", () => {
    const planted = "@media (max-height: 480px){.a{height:1px}}@media (min-width: 1px){.b{height:2px}}";
    expect(inMedia(planted, /max-height:\s*480px/).get(".a")).toEqual({ height: "1px" });
    expect(inMedia(planted, /max-height:\s*480px/).has(".b")).toBe(false);
  });
});

describe("a short viewport keeps the list most of the height (R21-02)", () => {
  const short = inMedia(css, /^\(max-height:\s*480px\) and \(max-width:\s*1023\.98px\)$/);
  it("the page is the one scroller: the chrome and a view's head scroll away with it", () => {
    expect(short.get(".app-root")).toMatchObject({ height: "auto", overflow: "visible" });
    expect(short.get(".shell")?.flex).toBe("none");
    expect(short.get(".deck")?.flex).toBe("none");
  });
  it("each view's own scroller stays one viewport tall, so a windowed list keeps a bounded box", () => {
    for (const sel of [".view > .scroller", ".view > .stream", ".list-col > .scroller", ".list-col > .stream"]) {
      /* One viewport in the page's own px: divided by the web door's Text size zoom (1 unset). */
      expect(short.get(sel), sel).toMatchObject({ flex: "none", height: "calc(100dvh / var(--ui-zoom, 1) - 10px)" });
    }
  });
});

describe("under a coarse pointer each control reaches 44px (R19-03)", () => {
  const coarse = inMedia(css, /^\(pointer:\s*coarse\)$/);
  const wide = (sel: string): number => Math.max(px(coarse.get(sel)?.["min-width"]), px(coarse.get(sel)?.width), px(coarse.get(sel)?.["flex-basis"]));
  const tall = (sel: string): number => Math.max(px(coarse.get(sel)?.["min-height"]), px(coarse.get(`${sel}::before`)?.height));
  it("the reader's More, the header's Message actions, a folder's chevron and menu, the Settings pills", () => {
    for (const sel of [".abar .abar-more", ".msg-more", ".frow .ftw", ".frow .fmore", ".set-nav button"]) {
      expect(wide(sel), `${sel} width`).toBeGreaterThanOrEqual(44);
    }
    for (const sel of [".msg-more", ".frow .fmore"]) expect(tall(sel), `${sel} height`).toBeGreaterThanOrEqual(44);
  });
  it("the Rules filter chips: 44 wide, a 44px strip, and a row gap the strips cannot cross", () => {
    const chips = inMedia(rulesCss, /^\(pointer:\s*coarse\)$/);
    expect(px(chips.get(".rules-facets button")?.["min-width"])).toBeGreaterThanOrEqual(44);
    expect(px(chips.get(".rules-facets button::before")?.height)).toBeGreaterThanOrEqual(44);
    // A chip draws 29px; two wrapped rows' strips stay apart when the gap is more than 44 - 29.
    expect(px(chips.get(".rules-facets")?.["row-gap"])).toBeGreaterThan(15);
  });
  it("a file's Download control: 44 wide and 44 tall, and the tile's name stops before it", () => {
    const strip = inMedia(stripCss, /^\(pointer:\s*coarse\)$/);
    const side = strip.get(".att-side");
    expect(px(side?.width), ".att-side width").toBeGreaterThanOrEqual(44);
    expect(px(side?.height), ".att-side height").toBeGreaterThanOrEqual(44);
    const room = px(strip.get(".att-item[data-side] > .att-tile")?.["padding-right"]);
    expect(room, "the name runs under the control").toBeGreaterThanOrEqual(px(side?.width) + px(side?.right));
  });
});
