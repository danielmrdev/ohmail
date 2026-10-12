/**
 * `Copy` — the accessor every screen already imports, now resolving a language per read.
 * `Copy.settings`, `Copy.doorbell(n)`, `Object.entries(Copy)` all mean what they meant before:
 * the English text lives in `copy.en.ts`, German in `copy.de.ts`, and this table's string
 * members are getters over whichever deck the register names. A getter cannot go stale: these
 * modules load before any provider renders, so a value captured at construction would be
 * English for the life of the process. Enumerable, because the guards walk it (`copy-tails`
 * reads `Object.entries`, `doors` reads `Object.keys`). No per-key fallback: the German deck is
 * typed `Deck`, so a missing key cannot build — a fallback would ship untranslated strings quietly.
 */

import { EN, type Deck } from "./copy.en";
import { DE } from "./copy.de";
import { activeLocale, type AppLocale } from "./i18n/locale";
import { deviceNoun, isPadDevice } from "./i18n/device";

export type { Deck };

/**
 * Every deck this build carries, by locale. Held against `LOCALES` by `test/locale.test.ts`, so a
 * locale added to the closed set without a deck fails there rather than answering `undefined` for
 * every string on somebody's phone.
 */
export const DECKS: Record<AppLocale, Deck> = { en: EN, de: DE };

type AnyDeck = Record<string, string | ((...args: never[]) => string)>;

/** A sentence as this device reads it: the deck's own words, the phone named as an iPad on one. */
function named(text: string, locale: AppLocale): string {
  return isPadDevice() && typeof text === "string" ? deviceNoun(text, locale) : text;
}

function liveDeck(): Deck {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(EN)) {
    if (typeof (EN as unknown as AnyDeck)[key] === "function") {
      out[key] = (...args: never[]): string => {
        const locale = activeLocale();
        const member = (DECKS[locale] as unknown as AnyDeck)[key];
        return named((member as (...a: never[]) => string)(...args), locale);
      };
      continue;
    }
    Object.defineProperty(out, key, {
      enumerable: true,
      get(): string {
        const locale = activeLocale();
        return named((DECKS[locale] as unknown as AnyDeck)[key] as string, locale);
      },
    });
  }
  return out as Deck;
}

export const Copy: Deck = liveDeck();
