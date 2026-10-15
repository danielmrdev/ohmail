import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE SECONDARY TEXTS THE TESTER READ UNDER 4.5:1 (the sync link,
 * the tag chips, the suggested decision's keycap), from the tokens. Each case reads the text's own
 * rule — its colour token and any opacity — and composites it over the surface stack it was
 * measured on (its box's tint, then its own pill), in both faces and both themes. A fix moves a
 * text to an existing token; a literal colour in a rule is refused, since a new colour is a design
 * ruling.
 * String-level, like the More menu's ring: jsdom resolves neither `oklch()` nor opacity.
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const UI = "../../../packages/ui/src/";

function blockOf(css: string, selector: RegExp): string | null {
  const m = css.match(selector);
  if (!m || m.index === undefined) return null;
  const open = css.indexOf("{", m.index);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  return null;
}

function propsOf(block: string, custom = true): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of block.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const m = decl.match(/^\s*([\w-]+)\s*:\s*([\s\S]+?)\s*$/);
    if (m && m[1]!.startsWith("--") === custom) out[m[1]!] = m[2]!;
  }
  return out;
}

type RGBA = [number, number, number, number];

function parseColor(v: string): RGBA {
  const s = v.trim();
  let m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1]!.slice(i, i + 2), 16) / 255).concat(1) as RGBA;
  m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)$/);
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, m[4] === undefined ? 1 : Number(m[4])];
  m = s.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\s*\)$/);
  if (!m) throw new Error(`cannot read the colour ${v}`);
  const [L, C, H] = [Number(m[1]), Number(m[2]), (Number(m[3]) * Math.PI) / 180];
  const a = C * Math.cos(H);
  const b = C * Math.sin(H);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const ss = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * ss,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * ss,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * ss,
  ].map((c) => Math.min(1, Math.max(0, c)));
  const enc = lin.map((c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  return [enc[0]!, enc[1]!, enc[2]!, m[4] === undefined ? 1 : Number(m[4])];
}

function resolve(expr: string, theme: Record<string, string>): string {
  const m = expr.trim().match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/);
  if (!m) return expr.trim();
  const own = theme[m[1]!];
  if (own !== undefined) return resolve(own, theme);
  if (m[2] === undefined) throw new Error(`${m[1]} is not defined in this theme`);
  return resolve(m[2], theme);
}

const over = (top: RGBA, under: RGBA): RGBA =>
  [0, 1, 2].map((i) => top[i]! * top[3] + under[i]! * (1 - top[3])).concat(1) as RGBA;
const luminance = (c: RGBA): number => {
  const [r, g, b] = [0, 1, 2].map((i) => (c[i]! <= 0.03928 ? c[i]! / 12.92 : ((c[i]! + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: RGBA, b: RGBA): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

const tokens = read("../../../packages/tokens/src/tokens.css");
const ohmarchy = read("../../../packages/tokens/src/ohmarchy.css");
const paperLight = propsOf(blockOf(tokens, /(^|\n):root,\s*\[data-theme="light"\]\s*\{/)!);
const paperDark = propsOf(blockOf(tokens, /\n\[data-theme="dark"\]\s*\{/)!);
const THEMES: Array<[string, Record<string, string>]> = [
  ["paper light", paperLight],
  ["paper dark", paperDark],
  ["ohmarchy light", { ...paperLight, ...propsOf(blockOf(ohmarchy, /\n\[data-face="ohmarchy"\],\s*\n\[data-face="ohmarchy"\]\[data-theme="light"\]\s*\{/)!) }],
  ["ohmarchy dark", { ...paperDark, ...propsOf(blockOf(ohmarchy, /\n\[data-face="ohmarchy"\]\[data-theme="dark"\],/)!) }],
];

/** A text: the rule whose `color`/`opacity` it wears, where `inherit` resolves, and its surfaces.
 *  `grounds` narrows the three when the text's box paints its own; `pill` names the rule whose
 *  `background` sits under the text in each scheme ([file, light rule, dark rule]). */
interface Text {
  what: string; file: string; rule: RegExp; inherits?: [string, RegExp]; tints: string[];
  grounds?: string[]; pill?: [string, RegExp, RegExp];
}
const GROUNDS = ["--canvas", "--panel", "--float"];
const APP = "../app/app.css";
const SPLIT = UI + "primitives/split-button.css";
const CHIP = UI + "primitives/chip.css";
/** The sync link in each box it stands in: its pill at rest and hovered, per scheme. */
const syncLink = (box: "rail-sync" | "sync-bar", tone: string, what: string, extra: Partial<Text>): Text[] =>
  (["", ":hover"] as const).map((state) => {
    const own = new RegExp(`\\n\\.${box} a${state} \\{`);
    return {
      what: `${what}${state ? ", hovered" : ""}`, file: APP, rule: new RegExp(`\\n\\.${box} a \\{`),
      inherits: [APP, new RegExp(`\\n\\.${box}\\.${tone} \\{`)] as [string, RegExp], tints: [],
      pill: [APP, own, new RegExp(`\\n\\[data-theme="dark"\\] \\.${box} a${state} \\{`)] as [string, RegExp, RegExp],
      ...extra,
    };
  });
/** The chip's own wash under its ink: the hue class's `background`, on every ground. */
const TAG_HUES = ["rosewood", "ochre", "olive", "moss", "verdigris", "denim", "indigo", "iris", "mulberry", "heather"];
const tagChip = (hue: string): Text => {
  const rule = new RegExp(`\\n\\.tagchip\\.hue-${hue}\\{`);
  return { what: `the ${hue} tag chip`, file: CHIP, rule, tints: [], pill: [CHIP, rule, rule] };
};
const TEXTS: Text[] = [
  { what: "a segmented option", file: UI + "primitives/seg.css", rule: /\n\.seg button\{/, tints: ["--tint2"] },
  { what: "a segment's count", file: UI + "primitives/seg.css", rule: /\n\.seg button \.scnt\{/, tints: ["--tint2"] },
  { what: "the Screener tab's count", file: "../app/app.css", rule: /\n\.scn-seg button \.scnt \{/, tints: ["--tint2"] },
  { what: "a badge", file: UI + "primitives/chip.css", rule: /\n\.badge\{/, tints: ["--tint2"] },
  { what: "a place badge", file: UI + "primitives/chip.css", rule: /\n\.badge\{/, tints: ["--tint"] },
  { what: "a partition chip's count", file: UI + "composites/bulk-strip.css", rule: /\n\.scn-chip \.num\{/, tints: ["--tint"] },
  { what: "the chosen chip's count", file: UI + "composites/bulk-strip.css", rule: /\n\.scn-chip\.on \.num\{/,
    inherits: [UI + "composites/bulk-strip.css", /\n\.scn-chip\.on,\.scn-chip\.on:hover\{/], tints: ["--accent-soft"] },
  { what: "a note's detail", file: UI + "primitives/info-note.css", rule: /\n\.infonote-more\{/,
    inherits: ["../app/app.css", /\n\.view-note \{/], tints: [] },
  { what: "the sync strip's detail", file: "../app/app.css", rule: /\n\.sync-bar\.warn \.num \{/, tints: ["--accent-soft"] },
  { what: "the rail sync box's detail", file: "../app/app.css", rule: /\n\.rail-sync \.rs-num \{/,
    inherits: ["../app/app.css", /\n\.rail-sync\.warn \{/], tints: ["--accent-soft"] },
  { what: "a hovered row's address", file: UI + "composites/row.css", rule: /\n\.row:hover \.row-top \.addr,/, tints: ["--tint"] },
  ...syncLink("rail-sync", "warn", "the rail sync box's link", { tints: ["--accent-soft"] }),
  ...syncLink("sync-bar", "warn", "the sync strip's link", { tints: ["--accent-soft"] }),
  ...syncLink("rail-sync", "busy", "the busy rail box's link", { tints: ["--tint"] }),
  ...syncLink("sync-bar", "busy", "the corner pill's link", { grounds: ["--panel"] }),
  { what: "the suggested decision's keycap", file: SPLIT, rule: /\n\.dbtn\.ai \.d-main kbd\{/,
    inherits: [SPLIT, /\n\.dbtn\.ai \.d-main\{/], tints: ["--accent-soft"], grounds: ["--float"] },
  ...TAG_HUES.map(tagChip),
];

/** The pill under a text in one scheme, or `undefined` when the rule or its `background` is missing. */
function pillOf(pill: [string, RegExp, RegExp], dark: boolean, theme: Record<string, string>): RGBA | undefined {
  const own = blockOf(read(pill[0]), dark ? pill[2] : pill[1]);
  const bg = own === null ? undefined : propsOf(own, false).background;
  return bg === undefined ? undefined : parseColor(resolve(bg, theme));
}

/** The text colour one rule gives, opacity folded into its alpha. `undefined` = no such rule. */
function textOf(t: Text, theme: Record<string, string>): RGBA | undefined {
  const own = blockOf(read(t.file), t.rule);
  if (own === null) return undefined;
  const props = propsOf(own, false);
  let color = props.color;
  if ((color === undefined || color === "inherit") && t.inherits) color = propsOf(blockOf(read(t.inherits[0]), t.inherits[1])!, false).color;
  if (color === undefined) return undefined;
  const c = parseColor(resolve(color, theme));
  const opacity = props.opacity === undefined ? 1 : Number(props.opacity);
  return [c[0], c[1], c[2], c[3] * opacity];
}

describe("the secondary texts read 4.5:1 in both faces and both themes", () => {
  it("reads four themes whose inks and grounds are defined (positive control)", () => {
    for (const [name, theme] of THEMES) for (const k of ["--ink2", "--ink3", ...GROUNDS]) expect(theme[k], `${name} ${k}`).toBeTruthy();
    // The dark faces' muted ink is under 4.5 on a tinted panel: the pair the finding is about.
    const [, ohDark] = THEMES[3]!;
    const ground = over(parseColor(resolve("var(--tint2)", ohDark)), parseColor(resolve("var(--panel)", ohDark)));
    expect(ratio(over(parseColor(resolve("var(--ink3)", ohDark)), ground), ground)).toBeLessThan(4.5);
  });

  it("each text meets 4.5:1 on every ground it can stand on", () => {
    const under: string[] = [];
    for (const t of TEXTS) for (const [name, theme] of THEMES) {
      const fg = textOf(t, theme);
      if (fg === undefined) { under.push(`${t.what}: no rule`); continue; }
      const pill = t.pill ? pillOf(t.pill, name.endsWith("dark"), theme) : undefined;
      if (t.pill && pill === undefined) { under.push(`${t.what}: no pill rule`); continue; }
      for (const g of t.grounds ?? GROUNDS) {
        let bg = parseColor(resolve(`var(${g})`, theme));
        for (const tint of t.tints) bg = over(parseColor(resolve(`var(${tint})`, theme)), bg);
        if (pill) bg = over(pill, bg);
        const r = ratio(over(fg, bg), bg);
        if (r < 4.5) under.push(`${t.what} · ${name} on ${[g, ...t.tints, ...(pill ? ["pill"] : [])].join("+")}: ${r.toFixed(2)}:1`);
      }
    }
    expect([...new Set(under)]).toEqual([]);
  });

  it("the Devices name field states its placeholder colour, from a token", () => {
    const rule = blockOf(read("../app/app.css"), /\n\.join-input::placeholder \{/);
    expect(rule, "no placeholder rule: the browser's own grey reads 4.0:1").not.toBeNull();
    const props = propsOf(rule!, false);
    expect(props.color).toMatch(/^var\(--ink[23]\)$/);
    expect(props.opacity).toBe("1");
    for (const [name, theme] of THEMES) {
      const bg = parseColor(resolve("var(--canvas)", theme));
      expect(ratio(over(parseColor(resolve(props.color!, theme)), bg), bg), name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("no rule named here paints a literal colour", () => {
    for (const t of TEXTS) {
      const own = blockOf(read(t.file), t.rule);
      if (own !== null) expect(propsOf(own, false).color ?? "", t.what).not.toMatch(/#[0-9a-f]{3,8}\b|oklch\(|rgba?\(/i);
    }
  });
});
