/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import type { StayVerdict } from "@ohmail/client-engine";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { readFileSync } from "node:fs";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { verdictSentence } from "../app/shell/shell-verbs";
import { sliceOfDeclaration } from "./source-anchor";

/**
 * THE SHELL'S TOAST NAMES ONE STAYING PLACE AS THE SHEET DOES: History in the person's language, a
 * folder by its label. Driven through `shell-verbs.ts` itself, the function `sayVerdict` calls.
 */
type T = Parameters<typeof verdictSentence>[0];
const tEn = createTranslator({ locale: "en", messages: en as Record<string, unknown> }) as unknown as T;
const tDe = createTranslator({ locale: "de", messages: de as Record<string, unknown> }) as unknown as T;
const still = (stillPlace: string | null): Exclude<StayVerdict, { key: "none" }> =>
  ({ key: "still", count: 5, still: 1, stillPlace, ids: ["h-1"], movable: true }) as Exclude<StayVerdict, { key: "none" }>;

describe("the shell's verdict sentence names the one staying place", () => {
  it("a row kept in History is said to be in History, in en and de", () => {
    expect(verdictSentence(tEn, still(null), "info@shop.example", "Ohbox")).toBe("5 are in Ohbox · 1 is still in History.");
    const de1 = verdictSentence(tDe, still(null), "info@shop.example", "Ohbox");
    expect(de1).toContain(de.screening.placeHistory);
    expect(de1).not.toContain("History");
  });

  it("the positive control: a row in a folder is said to be in that folder", () => {
    expect(verdictSentence(tEn, still("Fixture"), "info@shop.example", "Ohbox")).toBe("5 are in Ohbox · 1 is still in Fixture.");
  });

  it("sayVerdict toasts this function's sentence, never its own copy", () => {
    const src = withoutComments(readFileSync(`${process.cwd()}/apps/webapp/app/shell/shell-verbs.ts`, "utf8"));
    const body = sliceOfDeclaration(src, "sayVerdict");
    expect(body).toMatch(/verdictSentence\(t, v, who, place\)/);
    expect(body).not.toMatch(/placeHistory/);
  });
});
