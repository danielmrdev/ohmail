/**
 * THE ABOUT BLOCK STATES WHAT SHIPS. It said "Compose from scratch arrives with a later update" on every build since
 * New mail shipped (`app/compose.tsx`), on every paired phone and in the store's settings frames. A promise of a later
 * feature goes false the day the feature ships and nothing re-reads it, so the About block makes none: every sentence
 * Settings renders there, in both decks, is refused a future promise, no sentence in either deck promises a later
 * update, and a feature this build has a route for is named live there. The standalone door, paired with nothing,
 * read "Paired with ohmail on a phone"; it has its own sentence.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { EN, type Deck } from "../src/copy.en";
import { DE } from "../src/copy.de";

/* @reads: apps/mobile/app/settings.tsx apps/mobile/app/compose.tsx
   Read by a path built at runtime, so no landing pass selects this file when that source
   moves — the shape `reads-list.mjs` exists for. */

const APP = fileURLToPath(new URL("..", import.meta.url));
const SETTINGS = withoutComments(readFileSync(`${APP}/app/settings.tsx`, "utf8"));
const DECKS: [string, Deck][] = [["en", EN], ["de", DE]];

/** What a sentence says when it promises something this build does not have yet. */
const PROMISE: Record<string, RegExp> = {
  en: /\b(?:later|future|coming) updates?\b|\bcoming soon\b|\barrives? (?:with|in) a (?:later|future)\b|\bwill (?:arrive|ship|be added)\b/i,
  de: /\b(?:späteren?|künftigen?|kommenden?) Updates?\b|\bkommt (?:mit|bald|später)\b|\bdemnächst\b/i,
};

/** The About keys Settings renders, read off the screen rather than listed here. */
const ABOUT_KEYS = [...new Set([...SETTINGS.matchAll(/Copy\.(about\w*)/g)].map((m) => m[1]!))];

/** Every argument list a rendered About function is called with, so each branch is read. */
const SAMPLES: Record<string, unknown[][]> = {
  aboutLive: [["srv.example"]],
  aboutOnDeviceBackup: [["excluded"], ["included"], ["unknown"]],
};

function rendered(deck: Deck, key: string): string[] {
  const v = (deck as unknown as Record<string, unknown>)[key];
  if (typeof v === "string") return [v];
  if (typeof v !== "function") throw new Error(`${key} is neither a sentence nor a sentence function`);
  const calls = SAMPLES[key];
  if (!calls) throw new Error(`${key} renders on the About block: give it SAMPLES so every branch is read`);
  return calls.map((args) => String((v as (...a: unknown[]) => unknown)(...args)));
}

/** A feature this build ships, by the route that draws it, and how each deck names it live. */
const SHIPPED = [{ route: "app/compose.tsx", en: "writing new mail", de: "neue Nachrichten schreiben" }];

describe("the About block states what this build is, and promises nothing", () => {
  it("reads the sentences Settings renders there — the census is not empty", () => {
    expect(ABOUT_KEYS).toContain("aboutLive");
    expect(ABOUT_KEYS.length).toBeGreaterThanOrEqual(3);
  });

  it.each(DECKS)("no About sentence in %s promises a later feature", (lang, deck) => {
    const promising = ABOUT_KEYS.flatMap((k) => rendered(deck, k).filter((s) => PROMISE[lang]!.test(s)).map(() => k));
    expect(promising).toEqual([]);
  });

  it.each(DECKS)("no sentence anywhere in %s promises a later update", (lang, deck) => {
    const strings = Object.entries(deck).flatMap(([k, v]) =>
      typeof v === "string" ? [[k, v] as const] : typeof v === "function" && SAMPLES[k] ? rendered(deck, k).map((s) => [k, s] as const) : []);
    expect(strings.length).toBeGreaterThan(100);
    expect(strings.filter(([, s]) => /updates?\b/i.test(s) && PROMISE[lang]!.test(s)).map(([k]) => k)).toEqual([]);
  });

  it("the rule refuses the sentence that shipped — its positive control", () => {
    expect(PROMISE.en!.test("Compose from scratch arrives with a later update.")).toBe(true);
    expect(PROMISE.de!.test("Neue Nachrichten schreiben kommt mit einem späteren Update.")).toBe(true);
    expect(PROMISE.en!.test("reading, triage, reply, forward, tags and search are live.")).toBe(false);
    expect(PROMISE.de!.test("Lesen, Sortieren, Antworten, Weiterleiten, Tags und Suche sind live.")).toBe(false);
  });

  it.each(SHIPPED)("a shipped feature ($route) is named live in both decks, on either door", ({ route, en, de }) => {
    expect(existsSync(`${APP}/${route}`), `${route} is gone: this row's premise moved`).toBe(true);
    for (const key of ["aboutLive", "aboutLiveHere"]) {
      expect(rendered(EN, key).join(" "), key).toContain(en);
      expect(rendered(DE, key).join(" "), key).toContain(de);
    }
  });

  it("the standalone door's About names no pairing", () => {
    expect(SETTINGS).toMatch(/\{w\.standalone \? Copy\.aboutLiveHere : Copy\.aboutLive\(w\.account\.name\)\}/);
    expect(EN.aboutLiveHere).not.toMatch(/pair/i);
    expect(DE.aboutLiveHere).not.toMatch(/gekoppelt|kopplung/i);
  });
});
