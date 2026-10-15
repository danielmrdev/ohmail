import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* @reads: packages/client-engine/src/press-forecast.ts packages/client-engine/src/press-outcome.ts packages/client-engine/src/consent-cutline.ts
   Read by a path built at runtime, so no landing pass selects this file when those sources
   move — the shape `reads-list.mjs` exists for. */

/**
 * THE PRESS MODULES HOLD NO ORDER OF THEIR OWN. The forecast, the after-press reading and the
 * commit planner place a row with the partition's `placedRule` and lift with the engine's
 * `outrankCoveringDomains`; importing the rule order directly, or bringing back a second overlay
 * or placement model, is how a forecast comes to disagree with the list.
 */
const SRC = resolve(import.meta.dirname ?? ".", "../src");
const PRESS_MODULES = ["press-forecast.ts", "press-outcome.ts"];
const RETIRED = ["rulesAfterPress", "isTwin", "winnerFor", "FOLDER_OF_DEST", "pressConflicts"];

describe("the press modules import no rule order and no second model", () => {
  for (const file of PRESS_MODULES) {
    it(file, () => {
      const text = readFileSync(resolve(SRC, file), "utf8");
      expect(text.length, "the module was not read").toBeGreaterThan(500);
      expect(text).not.toMatch(/from\s+["']@trafficflow\/core\/rule-order["']/);
      for (const name of RETIRED) expect(text, name).not.toMatch(new RegExp(`\\b${name}\\b`));
    });
  }

  it("positive control: the order's own importer is seen by the same reading", () => {
    const text = readFileSync(resolve(SRC, "consent-cutline.ts"), "utf8");
    expect(text).toMatch(/from\s+["']@trafficflow\/core\/rule-order["']/);
  });
});
