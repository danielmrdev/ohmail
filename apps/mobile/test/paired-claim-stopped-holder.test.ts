import { beforeEach, describe, expect, it } from "vitest";
import { DECKS } from "../src/copy";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { claimChipLabel, claimFrom, claimHolderOf, claimNoteLine } from "../src/ui/standalone-form";
import { phoneBannerLines, phoneOrganizer } from "../src/state/live";

/**
 * THE PAIRED CLAIM CARD ASKS WHETHER THE HOLDER STILL ORGANIZES. It named the roster's holder
 * whatever its lease said, so a laptop that had stopped read "Organized by Studio laptop" with the
 * reader's sentence under it. The card now asks the reader refusal's decider (`holderIsLive`,
 * through `@ohmail/client-engine`): a holder that stopped is nobody, the card's own "Nothing
 * organizes this mailbox". The row goes through `claimHolderOf`, as the panel renders it. The More
 * tab's banner headed "Organized by" the same machine; its lines are `phoneBannerLines`'.
 */

const HOLDER = "Studio laptop";
const row = (organizerState: "held" | "stopped" | null, name: string | null = HOLDER) => ({
  organizedBy: { kind: "local", name },
  organizerState,
});
const card = (r: ReturnType<typeof row>) => claimFrom({
  known: true, role: "reader", serverHolds: false, organizer: claimHolderOf(r),
});

beforeEach(() => {
  resetLocaleRegisterForTests();
});

describe("the paired claim card over a holder that stopped", () => {
  for (const locale of ["en", "de"] as const) {
    it(`says nothing organizes the mailbox, and names no machine (${locale})`, () => {
      setActiveLocale(locale);
      const claim = card(row("stopped"));
      expect(claim).toEqual({ k: "free", starting: false });
      expect(claimChipLabel(claim)).toBe(DECKS[locale].phoneStateNotOrganized);
      expect(claimNoteLine(claim, "android"), "the note named the machine that stopped").toBeNull();
    });
  }

  it("CONTROL: a holder that still renews is named, and so is one not looked at yet", () => {
    setActiveLocale("en");
    for (const state of ["held", null] as const) {
      const claim = card(row(state));
      expect(claim).toEqual({ k: "theirs", name: HOLDER, kind: "local" });
      expect(claimChipLabel(claim)).toBe(DECKS.en.phoneStateReader(HOLDER));
    }
  });

  it("a live holder that recorded no name is still somebody, by the same decider", () => {
    setActiveLocale("en");
    const claim = card(row("held", null));
    expect(claim).toEqual({ k: "theirsUnnamed", kind: "local" });
    expect(claimChipLabel(claim)).toBe(DECKS.en.phoneStateReaderLegacy);
    expect(card(row("stopped", null))).toEqual({ k: "free", starting: false });
  });
});

describe("the More tab's banner over a holder that stopped", () => {
  for (const locale of ["en", "de"] as const) {
    it(`heads with nothing organizing the mailbox, and names the machine that stopped (${locale})`, () => {
      setActiveLocale(locale);
      const o = phoneOrganizer([row("stopped")])!;
      expect(phoneBannerLines(o)).toEqual({
        head: DECKS[locale].phoneStateNotOrganized, why: DECKS[locale].phoneBannerStopped(HOLDER),
      });
    });
  }

  it("CONTROL: a holder that still renews heads the banner by name", () => {
    setActiveLocale("en");
    const o = phoneOrganizer([row("held")])!;
    expect(phoneBannerLines(o)).toEqual({ head: DECKS.en.phoneBanner(HOLDER), why: DECKS.en.phoneBannerWhy });
  });
});

/**
 * A MAILBOX THE CLOSED ACCOUNT PAUSED (mail 0135) is neither free nor stopped: the paired server
 * resumes it on its own once the account is open. The web's `stateParked`, in this app's decks.
 */
describe("a mailbox the closed account paused", () => {
  const PARKED = "2026-09-23T02:15:07.000Z";
  const paused = (r: ReturnType<typeof row> | { organizedBy: null; organizerState: null }) => claimFrom({
    known: true, role: "reader", serverHolds: false, parked: true, organizer: claimHolderOf(r),
  });

  for (const locale of ["en", "de"] as const) {
    it(`reads paused, with no verb and no platform rule (${locale})`, () => {
      setActiveLocale(locale);
      const claim = paused({ organizedBy: null, organizerState: null });
      expect(claim).toEqual({ k: "parked" });
      expect(claimChipLabel(claim)).toBe(DECKS[locale].phoneStateParked);
      expect(claimNoteLine(claim, "android")).toBeNull();
    });
  }

  it("Cloud's own stale claim, named after the reopening, is still paused — not a stop", () => {
    expect(paused(row("stopped", "ohmail Cloud"))).toEqual({ k: "parked" });
  });

  it("the banner names no machine that stopped over a paused row; CONTROL: an unpaused one it does", () => {
    setActiveLocale("en");
    expect(phoneOrganizer([{ ...row("stopped"), organizerParkedAt: PARKED }])).toBeNull();
    expect(phoneOrganizer([{ ...row("stopped"), organizerParkedAt: null }])).not.toBeNull();
  });

  it("CONTROL: the marker absent keeps today's answer", () => {
    expect(card(row("stopped"))).toEqual({ k: "free", starting: false });
  });
});

/* @reads: apps/mobile/app/settings.tsx
   Read by a path built at runtime, so no landing pass selects this file when that source
   moves — the shape `reads-list.mjs` exists for. */
describe("Settings hands the roster's pause to the card", () => {
  it("the paired card's read carries `parked` from the row's marker", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../app/settings.tsx", import.meta.url), "utf8");
    const call = src.slice(src.indexOf("claim: claimFrom({"), src.indexOf("}),", src.indexOf("claim: claimFrom({")));
    expect(call, "the card never learns the mailbox is paused").toMatch(/parked: \(row\.organizerParkedAt \?\? null\) !== null/);
  });
});
