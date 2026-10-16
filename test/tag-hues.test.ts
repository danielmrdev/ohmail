import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RENDERABLE_HUES } from "@trafficflow/services";
import { color } from "@ohmail/tokens";

/**
 * THE TAG PALETTE IS A SIX-PLACE LOCKSTEP, AND IT HAS COME APART BEFORE.
 *
 * A tag's colour is one string (`tags.hue`, plain `text`, no CHECK — mail 0031), and rendering it
 * takes six files agreeing:
 *
 *   1. `packages/services/src/tags-service.ts`   — RENDERABLE_HUES, the closed set the API validates
 *   2. `packages/ui/src/primitives/Chip.tsx`     — TAG_HUES, the set the client offers
 *   3. `packages/ui/src/primitives/chip.css`     — a `.tagchip.hue-*` AND a `.tdot.hue-*` rule each
 *   4. `packages/tokens/src/tokens.css`          — a `--tg-*-ink` / `--tg-*-bg` pair, in THREE blocks
 *   5. `packages/tokens/src/tokens.ts`           — the same families, typed
 *   6. `apps/webapp/messages/{en,de}.json`       — the swatch's accessible name
 *
 * Any one of those missing is a SILENT failure, and each fails differently: a hue the server
 * accepts with no `chip.css` rule is an invisible dot; a hue the client offers that the server
 * refuses is a 400 on a swatch the user just clicked; a `--tg-*` pair present in `:root` but
 * missing from the dark blocks is a chip that vanishes when the theme flips; a missing label is
 * a swatch that announces itself as `settings.hue_iris` to a screen reader.
 *
 * This is not hypothetical. `client-engine/src/types.ts` records that the server's list and the
 * client's were six names against three, overlapping only on `moss`, for the whole time the
 * recolour verb sat unwired — every colour a picker could have offered was one the other half
 * could not honour. The comments in all six files have said "these must be equal" ever since.
 * A comment is the claim, not the evidence, so the equality is asserted here.
 *
 * It lives in the ROOT test directory because it belongs to no single workspace: it is the only
 * place that can reach the server's list, the client's, the tokens and both catalogues at once.
 * Filing it under any one of them is how it ends up unowned.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (rel: string) => readFileSync(`${HERE}../${rel}`, "utf8");

const chipSrc = read("packages/ui/src/primitives/Chip.tsx");
const chipCss = read("packages/ui/src/primitives/chip.css");
const tokensCss = read("packages/tokens/src/tokens.css");
// `settings` is NOT a flat string map — `languageName` is a nested { en, de } — so the values are
// typed `unknown` and narrowed at the assertion rather than cast to a shape the file does not have.
const catalogue = (locale: string): Record<string, unknown> =>
  (JSON.parse(read(`apps/webapp/messages/${locale}.json`)) as { settings: Record<string, unknown> })
    .settings;
const en = catalogue("en");
const de = catalogue("de");

/**
 * `TAG_HUES` and the `TagHueName` union, read out of `Chip.tsx` as TEXT.
 *
 * Importing them would be better and is not available: `@ohmail/ui`'s barrel reaches
 * `ThemeProvider.tsx`, and React does not resolve from the root test directory. Parsing is
 * therefore the price of asserting this at the one level that can see both halves — so the parse
 * itself is guarded below ("the parse is not silently empty"), because a regex that matches
 * nothing would make every assertion in this file vacuously true.
 */
const list = (name: string): string[] => {
  const m = chipSrc.match(new RegExp(`export const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`));
  if (!m) throw new Error(`${name} not found in Chip.tsx`);
  return [...m[1]!.matchAll(/"([\w-]+)"/g)].map((x) => x[1]!);
};
const TAG_HUES = list("TAG_HUES");

/** The union members, from the same file. TypeScript does NOT require the array to be exhaustive
 *  over them — `readonly TagHueName[]` accepts a short list — so this pair is checked by hand. */
const UNION_MEMBERS = (() => {
  const m = chipSrc.match(/export type TagHueName\s*=([\s\S]*?);/);
  if (!m) throw new Error("TagHueName union not found in Chip.tsx");
  return [...m[1]!.matchAll(/"([\w-]+)"/g)].map((x) => x[1]!);
})();

/**
 * The three the Blanc prototype extracted, with the token family each one has always resolved to.
 * These are the BACKWARD-COMPATIBILITY pins: a tag stores its colour as this NAME, so renaming
 * one or repointing it at a different family silently repaints every tag already carrying it.
 * Written out literally rather than derived, because deriving them from the code under test would
 * make the assertion vacuous.
 */
const ORIGINAL: ReadonlyArray<readonly [string, string]> = [
  ["moss", "pottery"],
  ["ochre", "buch"],
  ["rosewood", "privat"],
];

/**
 * The names `TagsService` accepted on its own before the reconciliation. Rows carrying them are
 * still in the database, and `hueOf` clamps them to moss. Re-admitting one to the palette would
 * change the colour of a tag nobody touched, which is the one thing widening the palette may not
 * do — so the set stays retired.
 */
const RETIRED = ["clay", "slate", "plum", "amber", "teal"];

/** `--tg-<family>-ink` / `-bg` referenced by `.tagchip.hue-<hue>` and `.tdot.hue-<hue>`. */
function familyOf(hue: string): { chip: string | null; dot: string | null } {
  const chip = chipCss.match(
    new RegExp(`\\.tagchip\\.hue-${hue}\\{color:var\\(--tg-([\\w-]+)-ink\\);background:var\\(--tg-([\\w-]+)-bg\\)\\}`),
  );
  const dot = chipCss.match(
    new RegExp(`\\.tdot\\.hue-${hue}\\{background:var\\(--tg-([\\w-]+)-ink\\)`),
  );
  return {
    chip: chip && chip[1] === chip[2] ? chip[1]! : null,
    dot: dot ? dot[1]! : null,
  };
}

/** The body of one custom-property block in tokens.css, brace-matched. */
function block(selectorRe: RegExp): string {
  const m = tokensCss.match(selectorRe);
  if (!m || m.index === undefined) throw new Error(`selector not found: ${selectorRe}`);
  const open = tokensCss.indexOf("{", m.index);
  let depth = 0;
  for (let i = open; i < tokensCss.length; i++) {
    if (tokensCss[i] === "{") depth++;
    else if (tokensCss[i] === "}" && --depth === 0) return tokensCss.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces after ${selectorRe}`);
}

const THEME_BLOCKS: ReadonlyArray<readonly [string, string]> = [
  [":root (light)", block(/(^|\n):root[^{]*\{/)],
  ['[data-theme="dark"]', block(/\n\[data-theme="dark"\]\s*\{/)],
  [
    "@media prefers-color-scheme: dark",
    block(/:root:not\(\[data-theme="light"\]\):not\(\[data-theme="dark"\]\)\s*\{/),
  ],
];

describe("the tag palette is one set across the server, the client, the CSS and the tokens", () => {
  it("the parse is not silently empty (guard against parser rot)", () => {
    expect(TAG_HUES.length, "TAG_HUES parsed as empty — every assertion below would pass")
      .toBeGreaterThanOrEqual(10);
    expect(UNION_MEMBERS.length).toBeGreaterThanOrEqual(10);
    expect(TAG_HUES).toContain("moss");
  });

  it("the TagHueName union and TAG_HUES are the same set", () => {
    // `readonly TagHueName[]` does not make the array exhaustive: adding a member to the union and
    // forgetting the array compiles clean and ships a colour no picker offers.
    expect([...UNION_MEMBERS].sort()).toEqual([...TAG_HUES].sort());
  });

  it("the server accepts exactly the hues the client offers", () => {
    // Sorted, so the failure is about MEMBERSHIP and not about picker order — the order of
    // TAG_HUES is presentation (hue-wheel order) and carries no data.
    expect([...RENDERABLE_HUES].sort()).toEqual([...TAG_HUES].sort());
  });

  it("is a palette worth calling one — at least ten distinct hues", () => {
    expect(new Set(TAG_HUES).size, "a duplicated hue name is a swatch that does nothing").toBe(
      TAG_HUES.length,
    );
    expect(TAG_HUES.length).toBeGreaterThanOrEqual(10);
  });

  it("every hue has BOTH a chip rule and a dot rule, on the same token family", () => {
    for (const hue of TAG_HUES) {
      const { chip, dot } = familyOf(hue);
      expect(chip, `.tagchip.hue-${hue} is missing from chip.css — an unpaintable chip`).not.toBeNull();
      expect(dot, `.tdot.hue-${hue} is missing from chip.css — an invisible rail dot`).not.toBeNull();
      expect(dot, `hue-${hue}: the dot and the chip read different token families`).toBe(chip);
    }
  });

  it("chip.css carries no rule for a hue the palette does not have", () => {
    const declared = [...chipCss.matchAll(/\.(?:tagchip|tdot)\.hue-([\w-]+)\{/g)].map((m) => m[1]!);
    const orphans = [...new Set(declared)].filter((h) => !TAG_HUES.includes(h));
    expect(orphans, `chip.css paints hues nothing can select: ${orphans.join(", ")}`).toEqual([]);
  });

  it("every hue's token family is defined in ALL THREE theme blocks", () => {
    // The third block is the one that gets forgotten: with no explicit `data-theme`, a viewer on
    // a dark OS reads the @media fallback and nothing else. A pair present in the first two and
    // absent from the third is a chip that renders on a toggled theme and disappears on a
    // system-preference one — which is why this loops the blocks rather than checking `:root`.
    for (const hue of TAG_HUES) {
      const family = familyOf(hue).chip;
      for (const [label, body] of THEME_BLOCKS) {
        expect(body, `--tg-${family}-ink (hue ${hue}) is missing from ${label}`).toMatch(
          new RegExp(`--tg-${family}-ink\\s*:`),
        );
        expect(body, `--tg-${family}-bg (hue ${hue}) is missing from ${label}`).toMatch(
          new RegExp(`--tg-${family}-bg\\s*:`),
        );
      }
    }
  });

  it("tokens.ts types the same hues as light and dark scheme entries", () => {
    expect(Object.keys(color.light.tag).sort()).toEqual([...TAG_HUES].sort());
    expect(Object.keys(color.dark.tag).sort()).toEqual([...TAG_HUES].sort());
  });

  it("stays inside the family's stated envelope — muted, never candy", () => {
    // tokens.ts writes the rule down ("muted, warm-adjacent, never candy") and the prototype's
    // three sit at chroma .07–.10. A derived hue that reached past that would be a different
    // design decision wearing the same variable name.
    for (const scheme of [color.light.tag, color.dark.tag]) {
      for (const [hue, pair] of Object.entries(scheme)) {
        for (const value of [pair.ink, pair.bg]) {
          const m = value.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)/);
          expect(m, `${hue}: ${value} is not an oklch triple`).not.toBeNull();
          const chroma = Number(m![2]);
          expect(chroma, `${hue}: chroma ${chroma} is outside .07–.10`).toBeGreaterThanOrEqual(0.07);
          expect(chroma, `${hue}: chroma ${chroma} is outside .07–.10`).toBeLessThanOrEqual(0.1);
        }
      }
    }
  });

  it("every value is inside sRGB, so no browser silently clips one into another hue", () => {
    /**
     * FOUND BY MEASURING, AFTER THE PALETTE WAS ALREADY WRITTEN: `denim`'s light ink began life
     * at `oklch(0.44 0.08 214)`, and sRGB's chroma ceiling at that lightness and hue is 0.0778.
     * A browser does not refuse an out-of-gamut oklch — it CLIPS, which moves the colour off the
     * hue that was chosen and toward whichever channel saturated. The failure is invisible in the
     * source (the value reads like every other one) and invisible in review (it renders as *a*
     * blue), so it is measured here instead. The cyan-to-blue arc is where sRGB is narrowest,
     * which is exactly where a hue wheel wants to put swatches.
     */
    const lin = (L: number, C: number, hDeg: number): number[] => {
      const h = (hDeg * Math.PI) / 180;
      const a = C * Math.cos(h);
      const b = C * Math.sin(h);
      const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
      const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
      const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
      return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
      ];
    };
    for (const [theme, scheme] of [["light", color.light.tag], ["dark", color.dark.tag]] as const) {
      for (const [hue, pair] of Object.entries(scheme)) {
        for (const [role, value] of Object.entries(pair)) {
          const m = value.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)/)!;
          const channels = lin(Number(m[1]), Number(m[2]), Number(m[3]));
          const out = channels.filter((c) => c < -0.0005 || c > 1.0005);
          expect(
            out,
            `${theme} ${hue} ${role} (${value}) is outside sRGB — a browser will clip it to a ` +
              "colour nobody chose. Lower the chroma.",
          ).toEqual([]);
        }
      }
    }
  });

  it("no two hues collapse into each other at chip size", () => {
    // Distinguishability is the point of a ten-colour palette. Compared in OKLab, where Euclidean
    // distance is roughly perceptual: ~0.02 is a just-noticeable difference for large flat areas,
    // and a tag chip is small, so the floor is set well above it.
    const lab = (value: string): [number, number, number] => {
      const m = value.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)/)!;
      const [L, C, h] = [Number(m[1]), Number(m[2]), (Number(m[3]) * Math.PI) / 180];
      return [L, C * Math.cos(h), C * Math.sin(h)];
    };
    for (const [theme, scheme] of [["light", color.light.tag], ["dark", color.dark.tag]] as const) {
      const inks = Object.entries(scheme).map(([h, p]) => [h, lab(p.ink)] as const);
      for (let i = 0; i < inks.length; i++) {
        for (let j = i + 1; j < inks.length; j++) {
          const [a, b] = [inks[i]![1], inks[j]![1]];
          const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
          expect(
            d,
            `${theme}: ${inks[i]![0]} and ${inks[j]![0]} are ${d.toFixed(4)} apart in OKLab — ` +
              "two swatches a user cannot tell apart are one swatch",
          ).toBeGreaterThan(0.035);
        }
      }
    }
  });

  it("both catalogues name every swatch", () => {
    // The swatch's only accessible name is `t(\`hue_${h}\`)`. A missing key renders the dotted
    // key itself, so a screen reader announces "settings.hue_iris" as a colour.
    for (const hue of TAG_HUES) {
      expect(typeof en[`hue_${hue}`], `en.json has no settings.hue_${hue}`).toBe("string");
      // No "German differs from English" check: Denim, Indigo and Iris are the same word in both,
      // so such an assertion would be false about correct translations.
      expect(typeof de[`hue_${hue}`], `de.json has no settings.hue_${hue}`).toBe("string");
    }
  });
});

describe("widening the palette cannot repaint a tag that already exists", () => {
  it("the prototype's three keep their names AND their token families", () => {
    for (const [hue, family] of ORIGINAL) {
      expect(TAG_HUES, `${hue} left the palette — every tag storing it would fall back to moss`)
        .toContain(hue);
      expect(familyOf(hue).chip, `${hue} no longer resolves to --tg-${family}-*`).toBe(family);
    }
  });

  it("the retired server-only names stay out", () => {
    // `moss` was in both the old server list and the renderable one, so it is not a collision.
    const readmitted = RETIRED.filter((h) => TAG_HUES.includes(h));
    expect(
      readmitted,
      `re-admitting ${readmitted.join(", ")} would give existing rows carrying those strings a ` +
        "colour they have never rendered — they clamp to moss today",
    ).toEqual([]);
  });

  it("the colour is stored by NAME, so the picker's order carries no data", () => {
    // The guard against someone "fixing" the wheel order back into an index: the schema column is
    // text with a text default, not an integer into this list.
    const schema = read("packages/db/src/schema-mail.ts");
    expect(schema).toMatch(/hue:\s*text\("hue"\)\.notNull\(\)\.default\("moss"\)/);
    // And no CHECK to widen — which is why this slice ships without a migration.
    expect(read("packages/db-mail/drizzle/0031_tags.sql")).not.toMatch(/CHECK[\s\S]*hue/i);
  });
});
