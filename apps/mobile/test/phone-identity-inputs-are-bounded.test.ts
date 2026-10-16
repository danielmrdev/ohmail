/**
 * THE PHONE'S OWN BUILD OF THE IDENTITY FACT READS A CRAFTED INPUT IN BOUNDED TIME (mail 0148). The
 * fact is bundled with the artifact's own plugin, aliases and platform and loaded from that bundle.
 * A crafted name, local part and subject thousands of characters long, and a long local part the
 * fold expands, each answer no claim within the bound the unbounded reading exceeds several times
 * over, and the real claim at the end of a name or of a 256-unit local part, or in the lead-in, is
 * still found.
 */
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { REPO, bundleProbe } from "../scripts/bundle-engine.mjs";

const require_ = createRequire(import.meta.url);
type Fact = { brand: string; via: string } | undefined;
type Phone = { claimedIdentity(i: { fromName: string | null; fromAddress: string; subject: string }): Fact };

let dir = "";
let phone: Phone;
beforeAll(async () => {
  const src = JSON.stringify(join(REPO, "packages", "core", "src", "sender-check.ts"));
  const probe = await bundleProbe(`export { claimedIdentity } from ${src};\n`);
  dir = probe.dir;
  phone = require_(probe.bundlePath) as Phone;
}, 120_000);
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const fastest = (f: () => unknown): number => {
  let best = Infinity;
  for (let k = 0; k < 3; k++) { const t = performance.now(); f(); best = Math.min(best, performance.now() - t); }
  return best;
};
const fact = (fromName: string | null, fromAddress: string, subject = "Hallo") => phone.claimedIdentity({ fromName, fromAddress, subject });
const NAME = "a".repeat(2000) + " ubs".repeat(250);
const LOCAL = "ab1cd2".repeat(500);
const SUBJECT = "Aa" + " ".repeat(2997) + "x";
const PAREN = Array.from({ length: 4096 }, (_, i) => String.fromCodePoint(0x249c + ((i * 7 + (i >> 3)) % 26))).join("");

describe("the phone's identity fact over crafted inputs", () => {
  it("a name of 3,000 characters claims nothing within 250 ms, and a brand at its end is found", () => {
    expect(fastest(() => expect(fact(NAME, "x@freemail.example")).toBeUndefined())).toBeLessThan(250);
    expect(fact(`${NAME.slice(0, 2988)} PostFinance`, "x@freemail.example")).toEqual({ brand: "PostFinance", via: "name" });
  });

  it("a local part of 3,000 characters claims nothing within 100 ms, and a brand ending its first 256 units is found", () => {
    expect(fastest(() => expect(fact("Crafted Sender", `${LOCAL}@example.com`)).toBeUndefined())).toBeLessThan(100);
    expect(fact(null, `${LOCAL.slice(0, 244)}.postfinance@freemail.example`)).toEqual({ brand: "PostFinance", via: "local_part" });
  });

  it("a local part of 4,096 characters the fold expands claims nothing within 100 ms", () => {
    expect(fastest(() => expect(fact("Crafted Sender", `${PAREN}@example.com`)).toBeUndefined())).toBeLessThan(100);
  });

  it("a subject of 3,000 characters claims nothing within 40 ms, and a lead-in naming the brand is found", () => {
    expect(fastest(() => expect(fact("Anna", "x@freemail.example", SUBJECT)).toBeUndefined())).toBeLessThan(40);
    expect(fact("Anna", "x@freemail.example", `PostFinance: Ihre Karte${SUBJECT.slice(23)}`)).toEqual({ brand: "PostFinance", via: "subject_lead" });
  });
});
