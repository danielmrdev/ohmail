/**
 * The tokens→RN translation, gated.
 *
 * Three independent ports of the Blanc design system now exist: the CSS in the
 * prototype, `Theme/` in the macOS app, and `src/theme/` here. A design system
 * that has been "translated" three times is a design system that has drifted
 * three times unless something checks. So:
 *
 *  · **Colour** — this module's OKLCH→sRGB converter must reproduce, byte for
 *    byte, the hexes documented beside every token in `Palette.swift`. Two
 *    independent implementations agreeing is the gate; one drifting fails.
 *  · **Shadow** — the lift ladder is parsed back out of `@ohmail/tokens`' own
 *    CSS strings and compared layer for layer, including the negative spreads
 *    that the macOS port had to drop and this one does not.
 *  · **Type** — the 5→4 weight compression is the one lossy step in the port,
 *    so the table is pinned here; changing it requires changing this test,
 *    which is the point.
 *  · **Discipline** — no screen may hold a colour literal. Same audit
 *    `OhMailKitTests.testNoUntrackedVisualConstants` runs over the Swift.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  shadow as tokenShadow,
  color as tokenColor,
  radius as tokenRadius,
  typography as tokenType,
} from "@ohmail/tokens";
import { hex, oklch } from "../src/theme/oklch";
import { authored, palettes } from "../src/theme/palette";
import { liftLayers } from "../src/theme/lift";
import { PHONE_STEP, size, tracking, type, weight } from "../src/theme/type";
import { HIT, MIN_SLOP, hitSlopFor, radius } from "../src/theme/tokens";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

/* ------------------------------------------------------------------ colour */

/**
 * The hexes `apps/macos/…/Theme/Palette.swift` documents beside each token,
 * transcribed. If this port's converter disagrees with the Swift one, the two
 * apps are painting different pixels from the same authored numbers.
 */
const SWIFT_HEX: Record<"light" | "dark", Record<string, string>> = {
  light: {
    canvas: "#fbfaf9",
    panel: "#ffffff",
    float: "#ffffff",
    ink: "#251f1b",
    ink2: "#534b45",
    ink3: "#625952",
    hair: "#362c24",
    hairSoft: "#362c24",
    tint: "#795d46",
    tint2: "#795d46",
    accent: "#a3461c",
    accentInk: "#923d17",
    accentSoft: "#be6438",
    accentHair: "#ae5528",
    onAccent: "#fffdfa",
    scrim: "#fbfaf8",
    tagMossInk: "#325b3b",
    tagMossBg: "#4e7f58",
    tagOchreInk: "#704e09",
    tagOchreBg: "#a17833",
    tagRosewoodInk: "#843c38",
    tagRosewoodBg: "#a45953",
  },
  dark: {
    canvas: "#0e0b08",
    panel: "#1c1714",
    float: "#26201c",
    ink: "#ebe8e3",
    ink2: "#aaa39d",
    ink3: "#8f8880",
    hair: "#f3eee6",
    hairSoft: "#f3eee6",
    tint: "#fcecd9",
    tint2: "#fcecd9",
    accent: "#e69a64",
    accentInk: "#eaa672",
    accentSoft: "#e69a64",
    accentHair: "#e69a64",
    onAccent: "#200f05",
    scrim: "#060403",
    tagMossInk: "#9ecba6",
    tagMossBg: "#8abd93",
    tagOchreInk: "#e3be80",
    tagOchreBg: "#d9b06b",
    tagRosewoodInk: "#edaaa4",
    tagRosewoodBg: "#dc8c85",
  },
};

describe("OKLCH → sRGB agrees with the macOS port", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`${scheme}: every token resolves to the hex Palette.swift documents`, () => {
      const got = Object.fromEntries(
        Object.entries(authored[scheme]).map(([k, v]) => [k, hex(v)]),
      );
      expect(got).toEqual(SWIFT_HEX[scheme]);
    });
  }

  it("the converter would notice if it were wrong (a wrong input gives a wrong hex)", () => {
    expect(hex(oklch(0.51, 0.135, 42))).toBe("#a3461c");
    expect(hex(oklch(0.51, 0.135, 142))).not.toBe("#a3461c");
  });

  it("keeps alpha on translucent tokens and drops it on opaque ones", () => {
    expect(palettes.light.panel).toBe("#ffffff");
    expect(palettes.light.hair).toBe("rgba(54, 44, 36, 0.16)");
    expect(palettes.dark.accentSoft).toBe("rgba(230, 154, 100, 0.12)");
  });
});

describe("the authored OKLCH is the token file's, not a copy", () => {
  const NUM = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*(\.?[\d.]+))?\s*\)/;
  const parse = (s: string) => {
    const m = NUM.exec(s)!;
    return {
      l: Number(m[1]),
      c: Number(m[2]),
      h: Number(m[3]),
      a: m[4] === undefined ? 1 : Number(m[4].startsWith(".") ? `0${m[4]}` : m[4]),
    };
  };

  for (const scheme of ["light", "dark"] as const) {
    it(`${scheme}: L/C/H/alpha match @ohmail/tokens exactly`, () => {
      const t = tokenColor[scheme];
      const pairs: [string, string][] = [
        ["canvas", t.canvas],
        ["panel", t.panel],
        ["float", t.float],
        ["ink", t.ink],
        ["ink2", t.ink2],
        ["ink3", t.ink3],
        ["hair", t.hair],
        ["hairSoft", t.hairSoft],
        ["tint", t.tint],
        ["tint2", t.tint2],
        ["accent", t.accent],
        ["accentInk", t.accentInk],
        ["accentSoft", t.accentSoft],
        ["accentHair", t.accentHair],
        ["onAccent", t.onAccent],
        ["scrim", t.scrim],
        ["tagMossInk", t.tag.moss.ink],
        ["tagMossBg", t.tag.moss.bg],
        ["tagOchreInk", t.tag.ochre.ink],
        ["tagOchreBg", t.tag.ochre.bg],
        ["tagRosewoodInk", t.tag.rosewood.ink],
        ["tagRosewoodBg", t.tag.rosewood.bg],
      ];
      for (const [key, css] of pairs) {
        expect({ key, ...authored[scheme][key] }).toEqual({ key, ...parse(css) });
      }
    });
  }
});

/* ------------------------------------------------------------------ shadow */

describe("the lift ladder is the CSS stack, transcribed", () => {
  const LAYER =
    /(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?(?:\s+(-?[\d.]+)(?:px)?)?\s+oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*(\.?[\d.]+))?\s*\)/g;

  const parseStack = (css: string) => {
    const out: { x: number; y: number; blur: number; spread: number; l: number; c: number; h: number; a: number }[] = [];
    for (const m of css.matchAll(LAYER)) {
      out.push({
        x: Number(m[1]),
        y: Number(m[2]),
        blur: Number(m[3]),
        spread: m[4] === undefined ? 0 : Number(m[4]),
        l: Number(m[5]),
        c: Number(m[6]),
        h: Number(m[7]),
        a: m[8] === undefined ? 1 : Number(m[8].startsWith(".") ? `0${m[8]}` : m[8]),
      });
    }
    return out;
  };

  for (const scheme of ["light", "dark"] as const) {
    for (const [level, css] of [
      ["l0", tokenShadow[scheme].lift0],
      ["l1", tokenShadow[scheme].lift1],
      ["l2", tokenShadow[scheme].lift2],
      ["l3", tokenShadow[scheme].lift3],
      ["barEdge", tokenShadow[scheme].barEdge],
    ] as const) {
      it(`${scheme} ${level}: same layers, offsets, blurs, spreads and colours`, () => {
        const want = parseStack(css);
        const got = liftLayers(scheme, level).map((l) => ({
          x: l.x,
          y: l.y,
          blur: l.blur,
          spread: l.spread,
          l: l.color.l,
          c: l.color.c,
          h: l.color.h,
          a: l.color.a,
        }));
        expect(want.length).toBeGreaterThan(0);
        expect(got).toEqual(want);
      });
    }
  }

  it("keeps the negative spreads the macOS port had to drop", () => {
    const spreads = liftLayers("light", "l3").map((l) => l.spread);
    expect(spreads.some((s) => s < 0)).toBe(true);
    expect(spreads).toEqual([0, -12, -24, -40]);
  });
});

/* -------------------------------------------------------------------- type */

describe("typography", () => {
  it("pins the 5→4 weight compression", () => {
    expect(weight).toEqual({
      regular: "400",
      medium: "500",
      semibold: "600",
      bold: "600",
      heavy: "700",
    });
  });

  /*
   * THE PHONE TYPE STEP — re-baselined 2026-09-04 (`MOBILE-TYPE-RULING.md` §2, §4).
   *
   * This block used to read "uses the token sizes verbatim". It no longer does,
   * and the change is deliberate rather than a drift to absorb: this app is
   * only ever a phone, and the ruling moves every reading role from 10.5 to
   * 15.5 up exactly one point, leaving 16 and above alone. The old numbers are
   * on the left, what the app renders now is on the right:
   *
   *     micro       10.5 → 11.5     wordmark      15   → 15    (a mark, no step)
   *     caption     11   → 12       proseReader   15.5 → 16.5
   *     label       11.5 → 12.5     h4            16   → 16
   *     bodyS       12   → 13       cardTitle     16.5 → 16.5
   *     control     12.5 → 13.5     heldTitle     17   → 17
   *     body        13   → 14       h1            22   → 22
   *     bodyL       13.5 → 14.5     h2            24   → 24
   *     base        14   → 15       readerTitle   29   → 29
   *     prose       14.5 → 15.5
   *
   * Both halves are asserted on purpose. The derivation alone would be
   * self-referential — `px(token) + PHONE_STEP` stays green with the step set
   * to 0 — so the rendered points are pinned as literals beside it. Setting
   * `PHONE_STEP` to 0 turns this block red, which is the only reason to trust
   * it.
   */
  const px = (v: string) => Number(v.replace("px", ""));

  /** The 10.5–15.5 reading band, which steps. `wordmark` sits inside it and is exempt. */
  const BAND = [
    "micro",
    "caption",
    "label",
    "bodyS",
    "control",
    "body",
    "bodyL",
    "base",
    "prose",
    "proseReader",
  ] as const;

  /** Role → the token key it derives from. `h1` is the mobile h1. */
  const TOKEN_OF: Record<keyof typeof size, keyof typeof tokenType.size> = {
    micro: "micro",
    caption: "caption",
    label: "label",
    bodyS: "bodyS",
    control: "control",
    body: "body",
    bodyL: "bodyL",
    base: "base",
    prose: "prose",
    wordmark: "wordmark",
    proseReader: "proseReader",
    h4: "h4",
    cardTitle: "cardTitle",
    heldTitle: "heldTitle",
    h1: "h1Mobile",
    h2: "h2",
    readerTitle: "readerTitle",
  };

  it("carries the phone step on the reading band and the token number above it", () => {
    for (const role of Object.keys(TOKEN_OF) as (keyof typeof size)[]) {
      const token = px(tokenType.size[TOKEN_OF[role]]);
      const steps = (BAND as readonly string[]).includes(role) && role !== "wordmark";
      expect(size[role], role).toBe(token + (steps ? PHONE_STEP : 0));
    }
  });

  it("renders these exact points — the step is 1, and it is not 0", () => {
    expect(PHONE_STEP).toBe(1);
    expect(size).toEqual({
      micro: 11.5,
      caption: 12,
      label: 12.5,
      bodyS: 13,
      control: 13.5,
      body: 14,
      bodyL: 14.5,
      base: 15,
      prose: 15.5,
      wordmark: 15,
      proseReader: 16.5,
      h4: 16,
      cardTitle: 16.5,
      heldTitle: 17,
      h1: 22, // `typography.size.h1Mobile` — this app is the mobile case
      h2: 24,
      readerTitle: 29,
    });
  });

  it("leaves 16 and above exactly where the tokens put them", () => {
    for (const role of ["h4", "cardTitle", "heldTitle", "h1", "h2", "readerTitle"] as const) {
      expect(size[role], role).toBe(px(tokenType.size[TOKEN_OF[role]]));
      expect(size[role], role).toBeGreaterThanOrEqual(16);
    }
    // The wordmark is a mark, not text: it sits inside the band and does not step.
    expect(size.wordmark).toBe(px(tokenType.size.wordmark));
  });

  it("converts em tracking to points at the role's own size", () => {
    expect(type.h1.letterSpacing).toBeCloseTo(22 * tracking.display, 6);
    // was 13.5 × subject; the subject role stepped to 14.5
    expect(type.rowSubject.letterSpacing).toBeCloseTo(14.5 * tracking.subject, 6);
  });

  it("converts the CSS leading multiplier to an absolute line box", () => {
    // was 15.5 × 1.78 and 14.5 × 1.72; both bodies stepped
    expect(type.readerBody.lineHeight).toBeCloseTo(16.5 * 1.78, 2);
    expect(type.msgBody.lineHeight).toBeCloseTo(15.5 * 1.72, 2);
  });

  /*
   * THE TWO PRESETS THE RESIDUAL EDITS ADDED, PINNED AS RENDERED POINTS.
   *
   * Both exist to retire a number a screen was typing by hand, so what is pinned is the point the
   * screen renders. `size.bodyS` on its own would stay green if the band moved underneath it, and
   * a preset that silently follows the band is exactly the drift the block above was written for.
   */
  it("decisionAi is the decision role in the heavy grade, not a smaller role", () => {
    expect(type.decisionAi).toEqual({ fontSize: 13, fontWeight: "700" });
    /* THE WHOLE POINT: it lines up with the sibling capsule it sits beside. The emphasis is the
       ring, the accent and the weight — never the size, which is what keeps the row one row. */
    expect(type.decisionAi.fontSize, "the AI capsule no longer matches its neighbour")
      .toBe(type.decision.fontSize);
    expect(type.decisionAi.fontWeight).not.toBe(type.decision.fontWeight);
    /* And it is not what the site borrowed before: `pileTitle` is a role and a half larger, which
       is why it had to be pulled back down by an inline size to 12 — one point UNDER its
       neighbour rather than level with it. */
    expect(type.decisionAi.fontSize).not.toBe(type.pileTitle.fontSize);
    expect(type.decisionAi.letterSpacing, "decisionAi took pileTitle's tracking").toBeUndefined();
  });

  it("hint is a caption that wraps — 12 with a 1.5 line box, where caption has none", () => {
    expect(type.hint).toEqual({ fontSize: 12, fontWeight: "400", lineHeight: 18 });
    expect(type.hint.fontSize).toBe(type.caption.fontSize);
    /* `caption` is single-line BY DESIGN — a row's timestamp, a tab label — so it carries no line
       box and a wrapped caption falls back to the platform's own (~1.33 at 12). That is the state
       `hint` exists to leave; if caption ever grows one, the two roles have collapsed. */
    expect(type.caption.lineHeight, "caption grew a line box, so `hint` is now a duplicate")
      .toBeUndefined();
    // 18, and 18 is 12 x 1.5 — not the 16 the screens used to type into a style object.
    expect(type.hint.lineHeight).toBe(12 * 1.5);
    expect(type.hint.lineHeight).not.toBe(16);
  });
});

/* --------------------------------------------------------------- targets */

/*
 * `HIT` was a claim, not a fact. `Tap` carried a flat `hitSlop={6}` under a
 * comment promising Material's 48dp, and for anything shorter than 36pt the
 * promise was false: the segmented control (34pt) reached 46 and a chip (29pt)
 * reached 41. `hitSlopFor` closes the gap from the MEASURED height, so the
 * geometry below is the app's real geometry and the reachable height is what a
 * finger actually gets.
 */
describe("touch targets reach HIT from the measured height", () => {
  it("gives a short control the slop it needs, and never less than the floor", () => {
    expect(hitSlopFor(29)).toBe(10); // chip: was 41 reachable, now 49
    expect(hitSlopFor(34)).toBe(7); // segmented control: was 46, now 48
    expect(hitSlopFor(38)).toBe(6); // Button minHeight: was 50, still 50
    expect(hitSlopFor(41)).toBe(6); // sheet row
    expect(hitSlopFor(44)).toBe(6); // dock tab — already over HIG's 44
    expect(hitSlopFor(48)).toBe(MIN_SLOP);
    expect(hitSlopFor(70)).toBe(MIN_SLOP); // a mail row
  });

  it("reaches HIT for every height the app actually renders", () => {
    for (const h of [18, 22, 26, 29, 30, 34, 38, 41, 44, 48, 66, 70]) {
      expect(h + 2 * hitSlopFor(h), `height ${h}`).toBeGreaterThanOrEqual(HIT);
    }
  });

  it("falls back to the floor before the first layout pass", () => {
    // `Tap` starts at height 0 and uses MIN_SLOP until `onLayout` reports.
    expect(hitSlopFor(0)).toBe(MIN_SLOP);
    expect(hitSlopFor(Number.NaN)).toBe(MIN_SLOP);
  });
});

describe("radii come straight from the token file", () => {
  it("matches every step", () => {
    const px = (v: string) => Number(v.replace("px", ""));
    expect(radius.row).toBe(px(tokenRadius.row));
    expect(radius.panel).toBe(px(tokenRadius.panel));
    expect(radius.card).toBe(px(tokenRadius.card));
    expect(radius.reader).toBe(px(tokenRadius.reader));
    expect(radius.input).toBe(px(tokenRadius.input));
  });
});

/* -------------------------------------------------------------- discipline */

/** Every source file the app renders from, minus the theme itself. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".expo" || entry === "assets") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("no screen holds a visual constant", () => {
  it("colour literals live only in src/theme", () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles(join(APP_DIR, "app")), ...sourceFiles(join(APP_DIR, "src"))]) {
      if (file.includes(`${"/"}theme${"/"}`)) continue;
      const body = readFileSync(file, "utf8");
      for (const [i, line] of body.split("\n").entries()) {
        // Ignore the `#nnn` that appear inside fixture-quoted prose and doc comments.
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        if (/#[0-9a-fA-F]{6}\b|rgba?\(|oklch\(|hsl\(/.test(code)) {
          offenders.push(`${file.replace(APP_DIR, "")}:${i + 1} ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/* ---------------------------------------------------------- the size census */

/**
 * ═══ NO SCREEN TYPES A SIZE ════════════════════════════════════════════
 *
 * The phone type step is decided in ONE place — `PHONE_STEP` in `src/theme/type.ts`, applied to
 * `size`, read by every preset. A `fontSize` or `lineHeight` typed into a screen is outside that
 * mechanism entirely: it does not take the step, nothing points at it, and the result is a line
 * one point off the line beside it, which is invisible in a screenshot and invisible in a diff.
 *
 * That is not hypothetical. Three sites carried exactly this shape and each read as deliberate:
 * an AI capsule at `fontSize: 12` sitting one point UNDER the `decision` capsule it shares a row
 * with, and nineteen captions at `lineHeight: 16` — 1.33 at 12px — where the web's equivalent
 * hints run 1.5. All nineteen were written the same way, one screen at a time, by people reading
 * the screen beside them.
 *
 * ── THE PARSER, NOT A GREP ──────────────────────────────────────────────────────────────────
 *
 * A text search cannot tell a property from prose. `type.ts` documents the retired literal in a
 * comment, and `t.type.rowSender.fontSize` is a READ of the theme rather than a number typed into
 * a screen — a grep flags both, and a census that cries wolf gets its allowlist widened until it
 * covers the real thing. `ts.createSourceFile` answers the actual question: is there a property
 * named `fontSize` or `lineHeight` being ASSIGNED in an object literal.
 *
 * ── THE ONE EXEMPTION IS NAMED, AND ITS SUBJECT IS CHECKED ──────────────────────────────────
 *
 * `Empty`'s glyph in `src/ui/base.tsx` is an emoji drawn at 30 to fill the space above the
 * sentence — artwork sized to its box, not text anyone reads, and the same reasoning that keeps
 * the wordmark out of the step on the web. It is the only one, and the case below fails if it
 * ever stops existing: an allowlist whose subject has moved exempts nothing and hides the next
 * offender in the same file.
 */

/** Every `.ts`/`.tsx` the app renders from. `src/theme/type.ts` is where sizes are ALLOWED to be. */
const TYPE_MODULE = join(APP_DIR, "src", "theme", "type.ts");
const NATIVE_FILES = [...sourceFiles(join(APP_DIR, "app")), ...sourceFiles(join(APP_DIR, "src"))]
  .filter((f) => f !== TYPE_MODULE);

interface SizeLiteral { file: string; line: number; prop: string; fn: string | null; text: string }

/** The nearest named function or variable a node sits in — how the one exemption is identified. */
function enclosingName(node: ts.Node): string | null {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
  }
  return null;
}

function sizeLiterals(): SizeLiteral[] {
  const out: SizeLiteral[] = [];
  for (const file of NATIVE_FILES) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
        const name = node.name;
        const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
        if (key === "fontSize" || key === "lineHeight") {
          out.push({
            file: file.replace(APP_DIR, ""),
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            prop: key,
            fn: enclosingName(node),
            text: node.getText(sf).replace(/\s+/g, " "),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

const LITERALS = sizeLiterals();
/**
 * The empty state's emoji glyph was the one typed size this census exempted (`fontSize: 30` in
 * `Empty`). The glyph is gone since 2026-09-21 — an empty state is its title and hint — so
 * nothing is exempt: a size typed into `Empty` now is an offender like any other.
 */
const isGlyph = (_d: SizeLiteral): boolean => false;

describe("no screen types a size", () => {
  it("reads the app at all, and exempts nothing", () => {
    /* Anti-vacuity. A renamed directory or a walk that stopped finding files would make every
       case below pass over nothing, which is the way this census would go quiet without failing.
       79 today; the bound is a floor on the WALK, not a count to keep updated. */
    expect(NATIVE_FILES.length, "the walk found almost nothing — the census covers nothing")
      .toBeGreaterThan(60);
    /* NOTHING IS EXEMPT, ASSERTED: `Empty` types no size since its glyph left, and the census
       reads `base.tsx` (a walk that skipped it would pass this over nothing). */
    expect(LITERALS.filter((d) => d.file === "src/ui/base.tsx" && d.fn === "Empty")).toEqual([]);
    expect(NATIVE_FILES.some((f) => f.endsWith("src/ui/base.tsx"))).toBe(true);
  });

  it("fontSize and lineHeight are assigned only in src/theme/type.ts", () => {
    const offenders = LITERALS.filter((d) => !isGlyph(d))
      .map((d) => `${d.file}:${d.line} ${d.text}`);
    expect(
      offenders,
      `${offenders.join("; ")} — a size typed into a screen is outside the phone type step, so it `
        + "does not move when the step does. Use a `variant`, or add the role to `type`.",
    ).toEqual([]);
  });

  it("every preset's size is a value of `size`, never a number typed into the preset", () => {
    /* The census above says no screen types a size; this says the theme does not either. Without
       it a preset could carry a literal and every screen would read the theme, correctly, and
       still be outside the step. */
    expect(Object.keys(type).length, "the preset table is empty — this case covers nothing")
      .toBeGreaterThan(25);
    const known = new Set<number>(Object.values(size));
    const off = Object.entries(type)
      .filter(([, style]) => !known.has(style.fontSize as number))
      .map(([role, style]) => `${role} ${String(style.fontSize)}`);
    expect(off, `${off.join("; ")} — not a value of \`size\`, so it does not carry PHONE_STEP`)
      .toEqual([]);
  });
});

/* ------------------------------------------- the role every screen reads at */

/**
 * ═══ EVERY LINE A SCREEN READS AT IS A ROLE IN THE STEPPED BAND ═════════════════════════
 *
 * The two cases above answer "is the table right" and "does a screen type a size". Neither
 * answers the question between them: WHICH ROLE a screen picked. A role is not a size, and the
 * table has roles on both sides of the band — `h1` at 22, `cardTitle` at 16.5 and `h4` at 16 do
 * not step, by design, because they are already at or above what the platforms put on a title.
 * So a body line written `variant="h4"` renders 16pt on every phone, takes no step, types no
 * literal, and passes every guard in this file.
 *
 * That is not a hypothetical shape: it is the one the AI capsule had. It reached for
 * `pileTitle` — a real role, correctly spelled, in the table — and was a point off the capsule
 * beside it for as long as it stood.
 *
 * ── WHAT IS JUDGED, AND WHAT IS NOT ─────────────────────────────────────────────────────────
 *
 * A screen's TITLE is allowed above the band and the fourth door's spec puts it there. So the
 * rule is not "everything steps" — it is that every role a screen reads at is either in the
 * stepped band or one of the roles NAMED here as a title, and that the named ones are the ones
 * the table says are above the band. A role added to the table under 16 without the step would
 * be caught by the case above; a screen reaching for an above-band role for reading text is
 * caught here.
 *
 * ── THE PARSER ANSWERS IT, AND `variant` IS THREE DIFFERENT PROPS ───────────────────────────
 *
 * `Txt` takes `variant={keyof Theme["type"]}` — a type role. `Chip` takes
 * `"neutral" | "pending" | "outline"` and `Button` takes `"plain" | "solid" | "quiet"`, on the
 * same attribute name. A text search for `variant="…"` reads all three and would report
 * `variant="solid"` as a missing type role, so the classifier gets widened until it stops
 * saying anything. Only the JSX tag tells them apart, and only a parser can see the tag.
 *
 * A `Txt` with no `variant` is `body` (the component's own default), which is in the band — so
 * an absent attribute is a reading, not a skip.
 */
const TXT_SCREENS = [
  "app/standalone.tsx",
  "app/settings.tsx",
  "app/welcome.tsx",
  "src/ui/Doors.tsx",
  "src/ui/Field.tsx",
] as const;

/**
 * Roles a screen may read at above the band — titles, which are already at or past what the
 * platforms put on a heading, so stepping them would redesign the hierarchy rather than fix a
 * legibility gap. The last case below asserts that each of these really does sit outside the
 * step, so the exemption cannot quietly come to cover a role that ought to be stepping.
 */
const TITLE_ROLES = new Set(["h1", "h2", "readerTitle", "cardTitle", "heldTitle", "protectedCode"]);

/* `wordmark` is deliberately NOT in that set. It is exempt from the step for a different reason —
   it is a mark rather than something read — and a screen that reached for it to set a line of text
   should be refused rather than exempted. */

/**
 * WHETHER A ROLE STEPS IS READ OUT OF `type.ts`, not inferred from its rendered size.
 *
 * The sizes overlap across the band's top: `prose` renders 15.5 and steps, `h4` renders 16 and
 * does not, `proseReader` renders 16.5 and steps, `cardTitle` renders 16.5 and does not. So a
 * threshold on the rendered number cannot tell a stepped role from an exempt one — a rule
 * written that way admits a title as "in the band" and exempts a body role for being a pixel
 * over. The two facts that actually decide it are both written in the module: the `size` table
 * says which KEYS carry `+ PHONE_STEP`, and the `type` table says which key each ROLE reads.
 */
const TYPE_MODULE_SRC = readFileSync(join(APP_DIR, "src", "theme", "type.ts"), "utf8");

/** `size` keys whose initializer adds the step. */
function steppedSizeKeys(): Set<string> {
  const sf = ts.createSourceFile("type.ts", TYPE_MODULE_SRC, ts.ScriptTarget.Latest, true);
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "size"
      && node.initializer) {
      let obj: ts.Node = node.initializer;
      while (ts.isAsExpression(obj) || ts.isParenthesizedExpression(obj)) obj = obj.expression;
      if (ts.isObjectLiteralExpression(obj)) {
        for (const p of obj.properties) {
          if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
          if (/\bPHONE_STEP\b/.test(p.initializer.getText(sf))) out.add(p.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** role → the `size` key its preset reads. */
function roleSizeKeys(): Map<string, string> {
  const sf = ts.createSourceFile("type.ts", TYPE_MODULE_SRC, ts.ScriptTarget.Latest, true);
  const out = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "type"
      && node.initializer) {
      let obj: ts.Node = node.initializer;
      while (ts.isAsExpression(obj) || ts.isParenthesizedExpression(obj)) obj = obj.expression;
      if (ts.isObjectLiteralExpression(obj)) {
        for (const p of obj.properties) {
          if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
          const key = /\bsize\s*:\s*size\.([A-Za-z0-9_]+)/.exec(p.initializer.getText(sf))?.[1];
          if (key !== undefined) out.set(p.name.text, key);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const STEPPED_KEYS = steppedSizeKeys();
const ROLE_KEY = roleSizeKeys();

/** `Txt`'s own default when the attribute is absent. */
const TXT_DEFAULT_ROLE = "body";

interface TxtSite { file: string; line: number; role: string }

function txtRoles(files: readonly string[]): { sites: TxtSite[]; unread: string[] } {
  const sites: TxtSite[] = [];
  const unread: string[] = [];
  for (const rel of files) {
    const full = join(APP_DIR, rel);
    const sf = ts.createSourceFile(full, readFileSync(full, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      const opening = ts.isJsxElement(node)
        ? node.openingElement
        : ts.isJsxSelfClosingElement(node)
          ? node
          : null;
      if (opening && ts.isIdentifier(opening.tagName) && opening.tagName.text === "Txt") {
        const line = sf.getLineAndCharacterOfPosition(opening.getStart(sf)).line + 1;
        const attr = opening.attributes.properties.find(
          (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === "variant",
        );
        if (attr === undefined) {
          sites.push({ file: rel, line, role: TXT_DEFAULT_ROLE });
        } else {
          /* A literal, or a conditional between literals (`variant={ai ? "a" : "b"}`) — both
             arms are roles and both are judged. Anything else is REPORTED rather than skipped:
             a role computed at runtime is outside this reading, and a guard that shrugged at it
             would pass over exactly the site most likely to be wrong. */
          const named: string[] = [];
          const collect = (n: ts.Node): void => {
            if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) named.push(n.text);
            else if (ts.isConditionalExpression(n)) { collect(n.whenTrue); collect(n.whenFalse); }
            else if (ts.isJsxExpression(n) && n.expression) collect(n.expression);
            else if (ts.isParenthesizedExpression(n)) collect(n.expression);
            else unread.push(`${rel}:${line} ${n.getText(sf).replace(/\s+/g, " ").slice(0, 48)}`);
          };
          if (attr.initializer) collect(attr.initializer);
          for (const role of named) sites.push({ file: rel, line, role });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { sites, unread };
}

const TXT = txtRoles(TXT_SCREENS);

describe("every role a screen reads at takes the phone step, or is a title", () => {
  it("reads the screens at all, and can see a role", () => {
    /* Anti-vacuity, the same shape as its neighbours: 40 today across five files. A parser that
       stopped finding `Txt` elements would report a clean phone step over screens it never read. */
    expect(TXT.sites.length, "the parser found almost no Txt elements — this case covers nothing")
      .toBeGreaterThan(25);
    for (const rel of TXT_SCREENS) {
      expect(TXT.sites.some((s) => s.file === rel), `${rel} contributed no Txt element`).toBe(true);
    }
    /* AND THE PREDICATE MUST BE ABLE TO SEE ONE. If the tag name were mis-spelled here, or the
       visitor never reached a JSX element, every case below would pass on a tree full of roles. */
    const probe = ts.createSourceFile("probe.tsx", 'const a = <Txt variant="caption">x</Txt>;',
      ts.ScriptTarget.Latest, true);
    let seen = 0;
    const visit = (n: ts.Node): void => {
      if (ts.isJsxElement(n) && ts.isIdentifier(n.openingElement.tagName)
        && n.openingElement.tagName.text === "Txt") seen += 1;
      ts.forEachChild(n, visit);
    };
    visit(probe);
    expect(seen, "the predicate cannot see a Txt element — this case cannot fail").toBe(1);
  });

  it("every role named is a role in the table", () => {
    const unknown = TXT.sites
      .filter((s) => !(s.role in type))
      .map((s) => `${s.file}:${s.line} variant="${s.role}"`);
    expect(unknown, `${unknown.join("; ")} — not a role in \`type\``).toEqual([]);
    /* A ROLE COMPUTED AT RUNTIME IS OUTSIDE THIS READING. None today; reported rather than
       skipped, because a variant read from a prop or a map is where the next off-band line
       would come from and no case here would see it. */
    expect(TXT.unread, `${TXT.unread.join("; ")} — the role is not a literal, so it is outside `
      + "this reading. Name the roles at the call site, or teach this case the shape.").toEqual([]);
  });

  it("the two tables were read out of the module, not assumed", () => {
    /* Anti-vacuity for the derivation itself: a parse that found no keys would make the rule
       below exempt every role, and a parse that found no roles would make it cover none. */
    expect(STEPPED_KEYS.size, "no `size` key was found carrying the step — the parse of `size` failed")
      .toBeGreaterThan(8);
    expect(ROLE_KEY.size, "no role was found reading a `size` key — the parse of `type` failed")
      .toBeGreaterThan(25);
    /* AND THE DERIVATION MUST AGREE WITH THE VALUES. Both tables are read as TEXT, so a parse
       that matched the wrong node would be self-consistent and wrong: this ties each role back
       to the number it actually renders at. */
    for (const [role, key] of ROLE_KEY) {
      expect(type[role as keyof typeof type].fontSize, `${role} reads size.${key}`)
        .toBe(size[key as keyof typeof size]);
    }
    /* Every role in the table is accounted for — a preset whose size the regex could not read
       would silently leave that role out of the rule below. */
    const missing = Object.keys(type).filter((role) => !ROLE_KEY.has(role));
    expect(missing, `${missing.join(", ")} — the role's size key could not be read from type.ts`)
      .toEqual([]);
  });

  it("every role a screen reads at carries the step, or is a title named above it", () => {
    const off = TXT.sites
      .filter((s) => !STEPPED_KEYS.has(ROLE_KEY.get(s.role) ?? ""))
      .filter((s) => !TITLE_ROLES.has(s.role))
      .map((s) => `${s.file}:${s.line} variant="${s.role}" (size.${ROLE_KEY.get(s.role) ?? "?"}, `
        + `${String(type[s.role as keyof typeof type].fontSize)}pt)`);
    expect(
      off,
      `${off.join("; ")} — the role does not carry PHONE_STEP, so that line renders at its `
        + "desktop size on every phone. Read at a role in the band, or name it in TITLE_ROLES.",
    ).toEqual([]);
    /* BOTH HALVES ARE READ. A run in which every role happened to be stepped would never
       exercise the title exemption, and a run with no stepped role would not exercise the rule. */
    expect(TXT.sites.some((s) => STEPPED_KEYS.has(ROLE_KEY.get(s.role) ?? "")),
      "no screen read at a role carrying the step — the rule measured nothing").toBe(true);
    expect(TXT.sites.some((s) => TITLE_ROLES.has(s.role)),
      "no screen read at a title role — the exemption has no subject on these screens").toBe(true);
  });

  it("the titles named above the band really are outside the step", () => {
    /* The exemption is only honest while its members are what it says they are. A role that
       started carrying the step would be exempted here from a rule it already obeys, and the
       next body line written at it would inherit that exemption. */
    const wrong = [...TITLE_ROLES]
      .filter((role) => STEPPED_KEYS.has(ROLE_KEY.get(role) ?? ""))
      .map((role) => `${role} reads size.${ROLE_KEY.get(role) ?? "?"}, which carries the step`);
    expect(wrong, `${wrong.join("; ")} — named as a title outside the step and carrying it`)
      .toEqual([]);
    /* AND EACH ONE MUST EXIST. A renamed role would leave a dead name in the set exempting
       nothing, which is how an allowlist stops being one. */
    const gone = [...TITLE_ROLES].filter((role) => !(role in type));
    expect(gone, `${gone.join(", ")} — named as a title and not a role in the table`).toEqual([]);
  });
});
