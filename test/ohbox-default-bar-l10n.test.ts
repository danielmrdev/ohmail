import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_OHBOX_BAR, OHBOX_BAR_MAX_BYTES } from "@trafficflow/services";

/**
 * THE DRIFT GUARD BETWEEN A SERVER CONSTANT AND THE TWO SENTENCES A READER SEES IN ITS PLACE.
 *
 * `DEFAULT_OHBOX_BAR` (`packages/services/src/screening-preference.ts`) is the bar the CLASSIFIER
 * receives whenever `account_settings.ohbox_bar` is NULL. It travels to every client as `defaultBar`
 * on `GET /account/screening`, and the bar editor prefills the box with it — not as a greyed
 * placeholder but as editable text, because you tweak words you can see.
 *
 * That prefill is the only English sentence a German reader was left staring at, and it is a long
 * one. So the editor renders `settings.screening.defaultBar` from the catalogue instead: English
 * byte-identical to the constant, German a DISPLAY TWIN. Nothing about the wire changed — a German
 * account that leaves the prefill alone still stores NULL, and the classifier still receives the
 * English constant that was tested against it. The twin is what the box shows, never what it saves.
 *
 * ── WHY THIS FILE IS AT THE ROOT AND NOT IN EITHER WORKSPACE ────────────────────────────────────
 *
 * It binds a `packages/services` constant to an `apps/webapp` catalogue. Neither owns the pair:
 * `apps/webapp` cannot import the constant (it does not depend on that package, and its tsconfig
 * would reject the specifier), and a test under `packages/services` reaching up into an app's
 * message files files a repository-wide invariant under the workspace that happens to hold one half
 * of it. `test/` is where the config says checks like this belong.
 *
 * ── THE THREE WAYS THIS GOES RED, WHICH ARE THE THREE WAYS THE PAIR CAN ROT ─────────────────────
 *
 *  1. THE CONSTANT MOVES AND ENGLISH DOES NOT. Byte equality, so an edit to the product default
 *     shows up here rather than as a box whose words differ from the words the model is given.
 *  2. THE GERMAN KEY VANISHES (or was never added). Asserted present, non-empty, and NOT the
 *     English sentence — a `de.json` that copied English would satisfy a mere existence check while
 *     leaving the German reader exactly where they started.
 *  3. THE ENGLISH SENTENCE CHANGES WHICH PILES IT NAMES AND THE GERMAN DOES NOT. Equality on
 *     English alone cannot see this: somebody fixes the constant, fixes `en.json`, and leaves a
 *     German twin describing a filing scheme the product no longer has. The pile names are checked
 *     BOTH ways — named in English ⇒ named in German, absent from English ⇒ absent from German —
 *     against the glossary `apps/webapp/test/locale-catalog.test.ts` already enforces elsewhere.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MESSAGES = path.join(HERE, "..", "apps", "webapp", "messages");

const catalogue = (locale: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(MESSAGES, `${locale}.json`), "utf8")) as Record<string, unknown>;

/** `settings.screening.defaultBar` out of one catalogue, or `undefined` when the path is broken. */
function defaultBarOf(locale: string): string | undefined {
  const settings = catalogue(locale).settings as Record<string, unknown> | undefined;
  const screening = settings?.screening as Record<string, unknown> | undefined;
  const bar = screening?.defaultBar;
  return typeof bar === "string" ? bar : undefined;
}

/**
 * The piles the default sentence routes mail to, English → the one German name for each. Every one
 * of these is already the glossary's answer for that view (`Receipts` is `Belege`; `News`,
 * `Ohbox` and `Screener` keep their English names in every language; the folder behind the News
 * pile stays `ohmail/Reads` on the server).
 */
const PILES: Array<[english: string, german: string]> = [
  ["Ohbox", "Ohbox"],
  ["News", "News"],
  ["Receipts", "Belege"],
  ["Screener", "Screener"],
];

describe("the product default bar, in both languages", () => {
  it("en.json carries the server constant BYTE FOR BYTE", () => {
    const english = defaultBarOf("en");
    expect(
      english,
      "apps/webapp/messages/en.json has no settings.screening.defaultBar — the editor would prefill a dotted key",
    ).toBeTypeOf("string");
    expect(
      english,
      "settings.screening.defaultBar drifted from DEFAULT_OHBOX_BAR: the box would show words the "
        + "classifier is not given. Update apps/webapp/messages/en.json — and the German twin one line below it.",
    ).toBe(DEFAULT_OHBOX_BAR);
  });

  it("de.json carries a German TWIN — present, its own sentence, and inside the column's cap", () => {
    const german = defaultBarOf("de");
    expect(
      german,
      "apps/webapp/messages/de.json has no settings.screening.defaultBar — a German reader gets the English default back",
    ).toBeTypeOf("string");
    expect(german!.trim().length).toBeGreaterThan(80);
    // Not a copy of English. `fillFrom` would have produced exactly that for free, so a twin that
    // equals the English sentence is a key somebody added without translating.
    expect(german, "the German twin IS the English sentence — nothing was translated").not.toBe(DEFAULT_OHBOX_BAR);
    // It can be typed into the box and saved as the reader's own words, so it must fit the column.
    expect(Buffer.byteLength(german!, "utf8")).toBeLessThanOrEqual(OHBOX_BAR_MAX_BYTES);
    // No ICU argument syntax: this message is rendered with no values, and a stray brace throws
    // inside the render rather than showing a sentence.
    expect(german).not.toMatch(/[{}]/);
  });

  it("both sentences name the SAME piles — the drift equality alone cannot see", () => {
    const english = defaultBarOf("en")!;
    const german = defaultBarOf("de")!;
    const drift: string[] = [];
    let named = 0;
    for (const [en, de] of PILES) {
      const inEnglish = english.includes(en);
      if (inEnglish) named++;
      const inGerman = german.includes(de);
      if (inEnglish !== inGerman) {
        drift.push(
          inEnglish
            ? `the English default files to ${en} and the German twin never mentions ${de}`
            : `the German twin files to ${de} and the English default no longer mentions ${en}`,
        );
      }
    }
    expect(drift, `the two defaults describe different filing:\n  ${drift.join("\n  ")}`).toEqual([]);
    // ANTI-VACUITY: a sentence that named no pile at all would otherwise pass this silently.
    expect(named, "the English default names none of the piles — is this still the same sentence?").toBe(PILES.length);
  });
});
