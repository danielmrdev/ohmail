import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as mail from "../src/mail.js";
import * as classify from "../src/ai/classify.js";
import * as draft from "../src/ai/draft.js";

/**
 * THE FOUR PROMPT CONSTANTS ARE UNCHANGED WHERE THEY ARE USED. Each top-level call carries a pure
 * annotation so a bundle that never asks a model (the phone engine) drops the text; the value the
 * classifier, the screener and the drafter send is pinned here by its digest from before the
 * annotation (read at the lane's DONE-2 tip).
 */
const digest = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");

const BEFORE = {
  TAXONOMY_PREFIX: "1578eddc020dada5496db04a51b9d37fa3fd2da75638cad25b5cd378bc548eb4",
  SCREENING_PREFIX: "c38417aa16e243a6ce33a5cc86749904bae4084b32a6fba0ccc22d412047031e",
  DRAFT_PREFIX: "e31298c46e8f26f9e4c4e64156185a31e18c15303c960f16f79ef71486319c14",
  SCREEN_DESTINATIONS: "9bbccf79cc7347ffa9c68857318c3185180b3a9aa97ecfd7fcdf7924d89c6c20",
};

describe("the prompt constants read the same where a model is asked", () => {
  it("the classifier and the screener send the text they sent before the annotation", () => {
    expect(digest(classify.TAXONOMY_PREFIX)).toBe(BEFORE.TAXONOMY_PREFIX);
    expect(digest(classify.SCREENING_PREFIX)).toBe(BEFORE.SCREENING_PREFIX);
    expect(digest(classify.SCREEN_DESTINATIONS)).toBe(BEFORE.SCREEN_DESTINATIONS);
  });

  it("the drafter sends the text it sent before the annotation", () => {
    expect(digest(draft.DRAFT_PREFIX)).toBe(BEFORE.DRAFT_PREFIX);
  });

  it("the mail leaf hands out the same values the model calls read", () => {
    expect(mail.TAXONOMY_PREFIX).toBe(classify.TAXONOMY_PREFIX);
    expect(mail.SCREENING_PREFIX).toBe(classify.SCREENING_PREFIX);
    expect(mail.SCREEN_DESTINATIONS).toBe(classify.SCREEN_DESTINATIONS);
    expect(mail.DRAFT_PREFIX).toBe(draft.DRAFT_PREFIX);
  });
});
