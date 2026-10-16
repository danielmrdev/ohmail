/**
 * The committed ohmarchy outputs are the MAPPING'S output, never hand-edited.
 *
 * Re-runs the exact generation `scripts/generate-ohmarchy.mjs` performs — mapping.js over the
 * tokyo-night and flexoki-light fixtures — and asserts both committed artifacts
 * (src/ohmarchy.css, src/ohmarchy.json) carry precisely those values. A hand edit of either
 * file, or a mapping.js change without regeneration, fails here. This is the production-side
 * half of the spec's own `_provenance.rule` ("never hand-picked").
 *
 * Mutation-proven at authoring time: flipping one hex in src/ohmarchy.css went red on the CSS
 * assertion; flipping one value in src/ohmarchy.json went red on the JSON assertion.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

await import(here("../omarchy/mapping.js")); // UMD: registers globalThis.OHMARCHY_MAP
const MAP = (globalThis as Record<string, unknown>).OHMARCHY_MAP as {
  mapTheme: (fixture: unknown) => { tokens: Record<string, string> };
};

const load = (slug: string) =>
  JSON.parse(readFileSync(here(`../omarchy/fixtures/${slug}.json`), "utf8")) as unknown;

const dark = MAP.mapTheme(load("tokyo-night")).tokens;
const light = MAP.mapTheme(load("flexoki-light")).tokens;
/** The CSS face blocks carry the contract's `--teach: 1` beside the mapping's output; the
 *  JSON stays the mapping's PURE output (the spec-identity pin). generate-ohmarchy.mjs says why. */
const darkCss = { ...dark, "--teach": "1" };
const lightCss = { ...light, "--teach": "1" };

/** All `--prop: value` (plus color-scheme) declarations of one brace-matched rule body. */
function declarations(body: string): Map<string, string> {
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, string>();
  for (const m of clean.matchAll(/(--[\w-]+|color-scheme)\s*:\s*([^;}]+)/g)) {
    out.set(m[1], m[2].replace(/\s+/g, " ").trim());
  }
  return out;
}

function ruleBody(css: string, selectorRe: RegExp): string {
  const m = css.match(selectorRe);
  if (!m || m.index === undefined) throw new Error(`selector not found: ${selectorRe}`);
  const open = css.indexOf("{", m.index);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces after ${selectorRe}`);
}

const css = readFileSync(here("../src/ohmarchy.css"), "utf8");
const json = JSON.parse(readFileSync(here("../src/ohmarchy.json"), "utf8")) as Record<
  string,
  Record<string, string>
>;

describe("src/ohmarchy.json is the mapping's output", () => {
  it("dark == mapTheme(tokyo-night)", () => {
    expect(json["ohmarchy-dark"]).toEqual(dark);
  });
  it("light == mapTheme(flexoki-light)", () => {
    expect(json["ohmarchy-light"]).toEqual(light);
  });
});

describe("src/ohmarchy.css is the mapping's output", () => {
  it("the base (light) block carries every flexoki-light value verbatim", () => {
    const got = declarations(ruleBody(css, /\[data-face="ohmarchy"\],\s*\n?\s*\[data-face="ohmarchy"\]\[data-theme="light"\]\s*\{/));
    expect(Object.fromEntries(got)).toEqual(lightCss);
  });
  it("the explicit-dark block (self AND descendant forms) carries every tokyo-night value verbatim", () => {
    const got = declarations(
      ruleBody(css, /\[data-face="ohmarchy"\]\[data-theme="dark"\],\s*\n?\s*\[data-face="ohmarchy"\] \[data-theme="dark"\]\s*\{/),
    );
    expect(Object.fromEntries(got)).toEqual(darkCss);
  });
  it("a light SUBTREE inside an ohmarchy page resolves the ohmarchy light set", () => {
    // face and scheme on one element is the base block's shape; the descendant form is what a
    // forced-light subtree (the dark viewer's per-message override) actually matches.
    const got = declarations(ruleBody(css, /\[data-face="ohmarchy"\] \[data-theme="light"\]\s*\{/));
    expect(Object.fromEntries(got)).toEqual(lightCss);
  });
  it("the system-dark media block repeats the dark set completely (no light-through)", () => {
    const got = declarations(
      ruleBody(css, /\[data-face="ohmarchy"\]:not\(\[data-theme="light"\]\):not\(\[data-theme="dark"\]\)\s*\{/),
    );
    expect(Object.fromEntries(got)).toEqual(darkCss);
  });
});
