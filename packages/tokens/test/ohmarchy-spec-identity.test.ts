/**
 * App-vs-spec identity, token level (OHMARCHY-PLAN.md §3a: "the ohmarchy face renders the
 * gallery's values EXACTLY").
 *
 * The spec statement of the ohmarchy defaults is `packages/tokens/spec/ohmarchy.tokens.json`
 * — mapping.js's output over tokyo-night/flexoki-light, the same values the gallery and the
 * Zero demo render. This test holds the SHIPPING token set (src/ohmarchy.json, which
 * ohmarchy-regeneration.test.ts proves equal to src/ohmarchy.css) equal to that spec,
 * slot for slot, byte for byte. If mapping.js changes in the spec without the production
 * copy following (or vice versa), this is the test that says so.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

const spec = JSON.parse(
  readFileSync(here("../spec/ohmarchy.tokens.json"), "utf8"),
) as Record<string, Record<string, string>>;
const shipped = JSON.parse(readFileSync(here("../src/ohmarchy.json"), "utf8")) as Record<
  string,
  Record<string, string>
>;

describe("the shipping ohmarchy defaults equal the spec's", () => {
  it("dark (tokyo-night)", () => {
    expect(shipped["ohmarchy-dark"]).toEqual(spec["ohmarchy-dark"]);
  });
  it("light (flexoki-light)", () => {
    expect(shipped["ohmarchy-light"]).toEqual(spec["ohmarchy-light"]);
  });
  it("the production mapping.js is byte-identical to the spec's", () => {
    // The mapping is the law and it lives in the spec first (omarchy/README.md); a drifted
    // copy would let the two identity checks above pass while the other 20 themes diverge.
    const specJs = readFileSync(
      here("../spec/mapping.js"),
      "utf8",
    );
    const prodJs = readFileSync(here("../omarchy/mapping.js"), "utf8");
    expect(prodJs).toBe(specJs);
  });
});
