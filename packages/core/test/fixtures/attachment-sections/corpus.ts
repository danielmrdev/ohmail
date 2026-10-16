import { createHash } from "node:crypto";
import { NESTED_FIXTURES } from "../nested-parts.js";
import { generateTrees, hasDescendedRfc822, shapeClass } from "./generator.js";
import { HAND_FIXTURES, type HandOutcome } from "./hand.js";

/**
 * THE SECTION CORPUS, one named source per tree: the eight nested shapes, the generator at seed
 * 2026 reduced to one tree per shape class with every descended-rfc822 tree kept, and the hand
 * shapes. Its oracle (`oracles/*.json`) was recorded over exactly these bytes, by sha256.
 */
export const GENERATOR_SEED = 2026;
export const GENERATOR_TREES = 400;

export type Group = "nested" | "generated" | "hand";
export interface CorpusEntry { name: string; group: Group; raw: Buffer; outcome: HandOutcome }

function generated(): CorpusEntry[] {
  const seen = new Set<string>();
  const out: CorpusEntry[] = [];
  for (const t of generateTrees(GENERATOR_SEED, GENERATOR_TREES)) {
    const k = shapeClass(t.root);
    const keep = !seen.has(k) || hasDescendedRfc822(t.root);
    seen.add(k);
    if (keep) out.push({ name: `gen-${String(t.index).padStart(3, "0")}`, group: "generated", raw: t.raw, outcome: "ok" });
  }
  return out;
}

export const SECTION_CORPUS: readonly CorpusEntry[] = [
  ...Object.entries(NESTED_FIXTURES).map(([name, raw]): CorpusEntry => ({ name: `nested-${name}`, group: "nested", raw, outcome: "ok" })),
  ...generated(),
  ...Object.entries(HAND_FIXTURES).map(([name, h]): CorpusEntry => ({ name: `hand-${name}`, group: "hand", raw: h.raw, outcome: h.outcome })),
];

export const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
