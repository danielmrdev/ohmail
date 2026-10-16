/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import {
  act, answerConsentWith, goTo, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";
import { LocaleShell } from "../app/(product)/LocaleShell";
import { AccountLocale } from "../app/(product)/mailbox/AccountLocale";
import { LOCALE_COOKIE, LOCALE_STORAGE_KEY, fillFrom, localeFromCookieHeader, type AppLocale } from "../app/shell/locale";
import { loadCatalog, type Messages } from "../i18n/catalog";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * ONE PRESS ON A LANGUAGE TAKES, through the Cloud's own composition: `LocaleShell` above
 * `AccountLocale` above the real `AppShell`. What was reported: with the account on
 * German, pressing English wrote the account (PATCH 200, the account then read English) while
 * the page, `<html lang>`, the cookie and the stored preference stayed German, and a reload
 * rendered German. The shell's boot adoption held the account's last READ and re-adopted it
 * the moment the press moved the page off it. Mutation: drop the refusal in `AccountLocale`'s
 * `adoptLocale` and the first two cases go red.
 */

const h = React.createElement;
const GERMAN = fillFrom(en as never, de as never) as unknown as Messages;

/** The account row as the route stores it: English is the default and is stored as null. */
let accountLocale: AppLocale | null;
let patches: Array<Record<string, unknown>>;
/** A held first `GET /consent` — the boot read in flight when the press lands. */
let heldRead: { release: () => void } | null;

const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

function scriptAccount(opts: { holdFirstRead?: boolean } = {}): void {
  const inner = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/consent/settings") && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      patches.push(body);
      if ("locale" in body) accountLocale = body.locale === "en" ? null : (body.locale as AppLocale | null);
      answerConsentWith({ locale: accountLocale });
      return json({ locale: accountLocale });
    }
    if (url.includes("/consent") && (init?.method ?? "GET") === "GET" && opts.holdFirstRead && reads++ === 0) {
      // The answer is the account BEFORE the write, taken now; only its delivery waits.
      const before = await inner(input as RequestInfo, init);
      return new Promise<Response>((resolve) => { heldRead = { release: () => resolve(before) }; });
    }
    return inner(input as RequestInfo, init);
  }) as typeof globalThis.fetch;
}

/** The device as a German session and a reload left it; the host's layout reads the cookie. */
function device(locale: AppLocale): void {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/`;
}

async function mountCloud(): Promise<HTMLElement> {
  const initialLocale = localeFromCookieHeader(document.cookie) ?? "en";
  return mountShell([mailbox()], {
    locale: initialLocale,
    wrap: (shell) => h(LocaleShell, {
      initialLocale,
      initialMessages: initialLocale === "de" ? GERMAN : (en as unknown as Messages),
      children: h(AccountLocale, { children: shell }),
    }),
  });
}

const languageButton = (host: HTMLElement, name: string): HTMLButtonElement => {
  const b = [...host.querySelectorAll<HTMLButtonElement>(".lang-seg button")].find((n) => n.textContent === name);
  expect(b, `no "${name}" in the language row`).toBeTruthy();
  return b!;
};
const pressedLanguage = (host: HTMLElement): string[] =>
  [...host.querySelectorAll(".lang-seg button[aria-pressed='true']")].map((n) => n.textContent ?? "");

/** What this browser will render next time: all three local mediums, and the live page. */
function rendering(host: HTMLElement): Record<string, unknown> {
  return {
    lang: document.documentElement.lang,
    stored: window.localStorage.getItem(LOCALE_STORAGE_KEY),
    cookie: localeFromCookieHeader(document.cookie),
    pressed: pressedLanguage(host),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await tick(20);
}

beforeAll(async () => {
  // Both catalogues warm before the fake clock starts, so a switch resolves inside `act`.
  await loadCatalog("en");
  await loadCatalog("de");
});

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  document.cookie = `${LOCALE_COOKIE}=; Path=/; Max-Age=0`;
  document.documentElement.lang = "";
  patches = [];
  heldRead = null;
});
afterEach(async () => {
  await teardownShellEnv();
});

describe("Settings → General → Language, on a German account", () => {
  it("one press of English takes at once: page, lang, cookie and storage move with the account write", async () => {
    accountLocale = "de";
    answerConsentWith({ locale: "de" });
    scriptAccount();
    device("de");
    const host = await mountCloud();
    await goTo("settings/general");
    await settle();
    expect(rendering(host)).toEqual({ lang: "de", stored: "de", cookie: "de", pressed: ["Deutsch"] });

    await act(async () => { languageButton(host, "English").click(); });
    await settle();

    expect(patches, "one account write, and nothing PATCHed back by an adoption").toEqual([{ locale: "en" }]);
    expect(accountLocale).toBeNull();
    expect(rendering(host), "the account says English and this browser stayed German").toEqual({
      lang: "en", stored: "en", cookie: "en", pressed: ["English"],
    });
    expect(host.textContent).toContain(en.settings.language);
  });

  it("a boot read still in flight when the press lands cannot put the old language back", async () => {
    accountLocale = "de";
    answerConsentWith({ locale: "de" });
    scriptAccount({ holdFirstRead: true });
    device("de");
    const host = await mountCloud();
    await goTo("settings/general");
    await settle();
    await act(async () => { languageButton(host, "English").click(); });
    await settle();
    expect(heldRead, "the boot read was never asked").not.toBeNull();
    await act(async () => { heldRead!.release(); });
    await settle();
    expect(rendering(host), "a read taken before the write outvoted it").toEqual({
      lang: "en", stored: "en", cookie: "en", pressed: ["English"],
    });
    expect(patches).toEqual([{ locale: "en" }]);
  });

  it("and a reload keeps it: the cookie renders English and the account's null moves nothing", async () => {
    accountLocale = null;
    answerConsentWith({ locale: null });
    scriptAccount();
    device("en");
    const host = await mountCloud();
    await goTo("settings/general");
    await settle();
    expect(rendering(host)).toEqual({ lang: "en", stored: "en", cookie: "en", pressed: ["English"] });
    expect(patches).toEqual([]);
  });

  it("CONTROL: an English browser signing in to a German account still follows the account, unasked", async () => {
    accountLocale = "de";
    answerConsentWith({ locale: "de" });
    scriptAccount();
    device("en");
    const host = await mountCloud();
    await goTo("settings/general");
    await settle();
    expect(rendering(host)).toEqual({ lang: "de", stored: "de", cookie: "de", pressed: ["Deutsch"] });
    expect(patches, "an adoption wrote the account").toEqual([]);
  });
});
