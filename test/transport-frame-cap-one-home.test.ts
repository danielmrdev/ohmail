import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PAGE_MAX_ROW_BYTES, SYNC_PAGE_MAX_BYTES, TRANSPORT_FRAME_ENVELOPE_RESERVE_BYTES, TRANSPORT_FRAME_MAX_BODY_BYTES,
} from "@trafficflow/core/transport-frame";
import { MAX_BODY_BYTES } from "@ohmail/sidecar";
import { DRAFT_ROW_MAX_BYTES } from "@trafficflow/services";
import { withoutCommentsAndLiterals } from "../scripts/lib/source-scan.mjs";

/**
 * THE TRANSPORT'S CAP HAS ONE HOME, AND BOTH READERS READ IT.
 *
 * It used to be a literal in the frame codec and a comment in the IMAP adapter saying the two
 * matched. Nothing held them there, and the page BUILDER — the third party that has to know the
 * number — knew nothing at all: it bounded a `/sync` page by rows, so 100 stored drafts inside
 * every documented limit made a page past the frame cap in bytes, and the
 * bootstrap refused for ever.
 *
 * A census rather than an equality assertion in one file: a second literal is how the first pair
 * drifted, and a census is the only shape that notices one arriving.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/**
 * The spellings of the cap a source file could carry — DERIVED from the constant, so a day when
 * the number moves does not leave this census asking about the old one.
 */
const CAP = TRANSPORT_FRAME_MAX_BODY_BYTES;
const MIB = CAP / (1024 * 1024);
const SPELLINGS = [
  new RegExp(String.raw`\b${CAP}\b`),
  new RegExp(String.raw`\b${String(CAP).replace(/\B(?=(\d{3})+$)/g, "_")}\b`),
  new RegExp(String.raw`\b${MIB}\s*\*\s*1_?024\s*\*\s*1_?024\b`),
  new RegExp(String.raw`\b${MIB}\s*<<\s*20\b`),
];

/**
 * Every source file that takes part in carrying a `/sync` page: the codec that refuses the frame,
 * the two files that hand it a response, and the builder that has to fit one. The leaf itself is
 * excluded — it IS the home.
 */
const CARRIERS = [
  "apps/sidecar/src/frame.ts",
  "apps/sidecar/src/host.ts",
  "apps/sidecar/src/client.ts",
  "apps/sidecar/src/protocol.ts",
  "packages/services/src/sync-service.ts",
  "packages/services/src/sync-page-byte-budget.ts",
];

describe("the frame cap is one constant", () => {
  it("the leaf's numbers agree, and the reserve leaves the page most of its budget", () => {
    expect(TRANSPORT_FRAME_MAX_BODY_BYTES).toBe(67_108_864);
    // A page is bounded apart from the frame: the frame grew for a send's attachments, a page did not.
    expect(SYNC_PAGE_MAX_BYTES).toBe(33_554_432);
    expect(SYNC_PAGE_MAX_BYTES).toBeLessThanOrEqual(TRANSPORT_FRAME_MAX_BODY_BYTES);
    expect(PAGE_MAX_ROW_BYTES)
      .toBe(SYNC_PAGE_MAX_BYTES - TRANSPORT_FRAME_ENVELOPE_RESERVE_BYTES);
    // A reserve that ate the page would be a page bound in name only.
    expect(TRANSPORT_FRAME_ENVELOPE_RESERVE_BYTES).toBeLessThan(SYNC_PAGE_MAX_BYTES / 16);
  });

  it("the codec's exported cap IS the leaf's — read through the package, not the source", () => {
    expect(MAX_BODY_BYTES).toBe(TRANSPORT_FRAME_MAX_BODY_BYTES);
  });

  it("the draft floor is under the page budget and over what one draft may legally weigh", () => {
    // Held back by the message walk so the first draft of a page never has to overshoot. Over the
    // two 256 KiB text ceilings, or an ordinary draft would be withheld for nothing; far under the
    // page budget, or the walk would have nothing left to spend.
    expect(DRAFT_ROW_MAX_BYTES).toBeGreaterThan(2 * 262_144);
    expect(DRAFT_ROW_MAX_BYTES).toBeLessThan(PAGE_MAX_ROW_BYTES / 8);
  });

  it.each(CARRIERS)("%s spells the number nowhere — it reads the constant", (rel) => {
    // Comments and strings are blanked first: a docblock naming the figure is documentation, and
    // a refusal message interpolates it rather than repeating it.
    const code = withoutCommentsAndLiterals(read(rel));
    const hit = SPELLINGS.find((re) => re.test(code));
    expect(
      hit === undefined,
      `${rel} carries its own copy of the frame cap (${String(hit)}) — import ` +
        "TRANSPORT_FRAME_MAX_BODY_BYTES from @trafficflow/core/transport-frame instead",
    ).toBe(true);
  });

  it("the census can see a literal at all — the same scan over a file that HAS one", () => {
    // The positive control, and it is chosen from a subject that HAS the property: the desktop's
    // Rust shell mirrors the frame cap in its own language, so it spells the number.
    const code = withoutCommentsAndLiterals(read("apps/desktop/src-tauri/src/engine.rs"));
    expect(SPELLINGS.some((re) => re.test(code)), "the scan found nothing in a file that has one").toBe(true);
  });
});
