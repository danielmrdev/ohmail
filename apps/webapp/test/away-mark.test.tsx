/** @vitest-environment jsdom */
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { setActiveCatalog, setActiveFormatZone } from "../app/shell/locale";

/**
 * ═══ "ANSWERED BY THE AWAY RESPONDER · <when>" — WHEN IT IS DRAWN, AND ON WHICH MESSAGE ═══
 *
 * The away responder answers on your behalf while you are away and the reply lands in Sent,
 * which is not where anyone looks. So the fact is put on the ORIGINAL: the message itself says
 * that a machine answered it, and when. Everything here is about WHICH message wears the mark
 * and WHEN it appears at all, because both directions are wrong in a way nothing else catches:
 *
 *   · a mark that fails to appear leaves the reader thinking a correspondent heard nothing;
 *   · a mark on the wrong message tells them somebody was answered who was not.
 *
 * The header is `MessageHeader` (`MessageCard.tsx`), which is the SAME header the reading pane
 * composes for the focused message and each panel wears on an open thread — so this one mount is
 * every surface the mark reaches, and driving the header directly measures the real component
 * rather than a copy of its markup.
 *
 * `useMessageChrome`'s default is inert by design (the desktop shell mounts the pane with no
 * provider), so no chrome is wired here: the mark reads nothing off it, and its absence keeps
 * this file about the mark instead of about the shell.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A FIXED ZONE AND A FIXED CLOCK, so the relative stamp is a fact rather than a function of when
 * the suite runs. `NOW` is two hours after `ANSWERED_AT` and on the same calendar day in UTC, so
 * `messageStamp` takes its same-day band and the stamp is a bare wall clock — the shape the mark
 * is read in most.
 */
const NOW = new Date("2026-09-09T10:15:00.000Z");
const ANSWERED_AT = "2026-09-09T08:15:00.000Z";
const ARRIVED_AT = "2026-09-09T07:00:00.000Z";

interface Seed {
  id?: string;
  awayRepliedAt?: string | null;
  /** Omitted entirely ⇒ the key is ABSENT, which is a mirror or server older than the field. */
  omitStamp?: boolean;
  from?: string;
  subject?: string;
}

function msg(s: Seed = {}): Record<string, unknown> {
  const id = s.id ?? "m1";
  return {
    id,
    accountId: "a",
    mailboxId: "mb",
    threadId: "t1",
    messageIdHeader: null,
    subject: s.subject ?? "the roundup",
    from: { name: "The Roundup", address: s.from ?? "news@sender.test" },
    to: [{ name: null, address: "me@trafficflow.test" }],
    cc: [],
    date: ARRIVED_AT,
    folder: "ohmail/News",
    snippet: `snippet-${id}`,
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: {
      sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false,
    },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: ARRIVED_AT,
    ...(s.omitStamp ? {} : { awayRepliedAt: s.awayRepliedAt ?? null }),
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

async function mountHeader(
  message: Record<string, unknown>, locale: "en" | "de" = "en",
): Promise<void> {
  await unmount();
  const { MessageHeader } = await import("../app/shell/MessageCard.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale, messages: locale === "de" ? de : en, timeZone: "UTC", now: NOW,
        children: h(MessageHeader as never, { message, now: NOW }),
      }),
    );
  });
}

const mark = (): HTMLElement | null => host!.querySelector(".away-mark");

/* The stylesheet's path from the RUN ROOT, which is the repository root (the root vitest
   config owns the setup files, so a webapp test never runs from `apps/webapp`). `import.meta.url`
   is not a file URL under jsdom, which is what a first draft of the CSS assertion tried;
   `away-notice.test.tsx` already resolves its sources this way. */
const APP = existsSync("apps/webapp/app") ? "apps/webapp/app" : "app";

beforeEach(() => {
  setActiveFormatZone("UTC");
  setActiveCatalog("en", null);
});
afterEach(async () => {
  await unmount();
  setActiveFormatZone(null);
  setActiveCatalog("en", null);
});

describe("the away-answer mark", () => {
  it("is drawn, with the label and the relative stamp, when the server stamped the message", async () => {
    await mountHeader(msg({ awayRepliedAt: ANSWERED_AT }));
    const el = mark();
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe("Answered by the away responder · 08:15");
    /* The stamp is the RESPONDER's instant, not the message's arrival — a mark reading the
       message's own date would look entirely plausible and be about the wrong event. */
    expect(el!.textContent).not.toContain("07:00");
  });

  /**
   * THE THREE ABSENCES, AND THEY ARE THREE DIFFERENT ROWS. `null` is "the server asked its ledger
   * and the responder never answered this message"; an ABSENT key is a mirror row written before
   * the field existed, or a server older than it. All of them must draw nothing, because "not
   * known" has to look exactly like "did not happen" — that is the behaviour every mirror had
   * before the field, and it is what lets a client and a server be deployed in either order.
   */
  it("is absent when the stamp is null — the responder did not answer this message", async () => {
    await mountHeader(msg({ awayRepliedAt: null }));
    expect(mark()).toBeNull();
  });

  it("is absent when the key is missing entirely — a mirror or server older than the field", async () => {
    await mountHeader(msg({ omitStamp: true }));
    expect(mark()).toBeNull();
  });

  /**
   * AN INSTANT THAT DOES NOT PARSE. The server stamped SOMETHING, so the claim stands — a
   * correspondent was answered — but there is no time to name, and both formatters answer "" for
   * an unparseable date rather than a string. So the line is the CLAIM ALONE: no stamp, no
   * separator, no "Invalid Date", and the accessible name falls back to the same label instead of
   * a sentence with an empty hole in it. Asserted unconditionally in both directions, because a
   * `if (el) expect(…)` here would pass whether or not the mark rendered.
   */
  it("draws the claim alone for an instant that does not parse — never an invalid date", async () => {
    await mountHeader(msg({ awayRepliedAt: "not-a-date" }));
    expect(host!.textContent).not.toContain("Invalid Date");
    const el = mark();
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe("Answered by the away responder");
    expect(el!.querySelector(".when")).toBeNull();
    expect(el!.getAttribute("aria-label")).toBe("Answered by the away responder");
  });

  /**
   * ═══ THE PERSON'S OWN REPLY, AND THE RESPONDER'S SENT COPY — NEITHER WEARS THE MARK ═══
   *
   * The hard stop, from the render side. The server keys the stamp on the ORIGINAL's id, so a
   * reply — the reader's own, or the responder's Sent copy — carries `awayRepliedAt: null` and
   * draws nothing. Both rows are mounted here rather than argued about, because the whole
   * question the reader asks of a thread is "which of these messages was answered for me".
   */
  it("is absent on the person's own reply in the thread", async () => {
    await mountHeader(msg({
      id: "mine", from: "me@trafficflow.test", subject: "Re: the roundup", awayRepliedAt: null,
    }));
    expect(mark()).toBeNull();
  });

  it("is absent on the responder's own Sent copy", async () => {
    await mountHeader(msg({
      id: "auto", from: "me@trafficflow.test", subject: "Re: the roundup",
      // The Sent copy is what `autoReplyByUs` marks; the STAMP is never on it. A row carrying
      // both would be the projection stamping whatever message it was handed.
      awayRepliedAt: null,
    }));
    expect(mark()).toBeNull();
  });

  /**
   * `role="note"` WITH THE ABSOLUTE INSTANT. The visible " · 08:15" is relative to a clock a
   * screen reader has nothing to resolve it against, and below 640 px CSS hides that span
   * altogether — so the accessible name carries the exact instant at every width and the narrow
   * rendering loses nothing for a reader using one. Not focusable: it is a fact, not a control.
   */
  it("carries role=note and an accessible name naming the absolute instant", async () => {
    await mountHeader(msg({ awayRepliedAt: ANSWERED_AT }));
    const el = mark()!;
    expect(el.getAttribute("role")).toBe("note");
    expect(el.getAttribute("aria-label")).toBe("Answered by the away responder Wed 9 Sep 2026, 08:15");
    expect(el.hasAttribute("tabindex")).toBe(false);
    expect(el.querySelector("a,button,input,[tabindex]")).toBeNull();
  });

  /**
   * THE STAMP IS ITS OWN ELEMENT, AND THE SEPARATOR IS INSIDE IT. `@media (max-width: 640px)`
   * hides `.away-mark .when`, and the dot travels with it — a rule that hid the stamp and left
   * the "·" behind would end the line with a separator introducing nothing. jsdom applies no
   * media queries, so what is asserted here is the STRUCTURE the rule needs; the rule's own
   * presence is asserted from the stylesheet below.
   */
  it("puts the separator and the stamp in one `.when` span the media rule can hide", async () => {
    await mountHeader(msg({ awayRepliedAt: ANSWERED_AT }));
    const when = mark()!.querySelector(".when");
    expect(when).not.toBeNull();
    expect(when!.textContent).toBe(" · 08:15");
    // What survives with the span hidden is the claim alone, with no trailing separator.
    const visible = mark()!.textContent!.replace(when!.textContent!, "");
    expect(visible).toBe("Answered by the away responder");
  });

  it("the stylesheet hides `.away-mark .when` under 640px and defines the mark in one ink", () => {
    const css = readFileSync(`${APP}/app.css`, "utf8");
    expect(css).toContain(".away-mark {");
    expect(css).toMatch(/@media \(max-width: 640px\) \{\s*\.away-mark \.when \{ display: none; \}/);
    // One ink, inherited: `.when` declares no colour of its own — a rule restating its parent's
    // is a rule nobody could watch work.
    expect(css).not.toMatch(/\.away-mark \.when \{\s*color:/);
  });

  /** The German face of the same line, from the German catalogue — never a literal in markup. */
  it("draws the German label and the German absolute instant", async () => {
    setActiveCatalog("de", de as never);
    await mountHeader(msg({ awayRepliedAt: ANSWERED_AT }), "de");
    const el = mark()!;
    expect(el.textContent).toBe("Vom Abwesenheitsassistenten beantwortet · 08:15");
    expect(el.getAttribute("aria-label")).toContain("Vom Abwesenheitsassistenten beantwortet");
    // The absolute form is `Intl`-named in the reader's language: "Mi" for Wednesday, "Sep".
    expect(el.getAttribute("aria-label")).toMatch(/\bMi\b/);
  });

  /**
   * BOTH CATALOGUES CARRY ALL THREE KEYS, in the shape the component reads them. The copy census
   * already refuses a key the code names and a catalogue lacks; this is the other half — the
   * `<stamp>` TAG, which is what puts the separator in the catalogue rather than in the markup.
   * A value that lost the tag would render the whole line as flat text and the media rule would
   * have nothing to hide, silently.
   */
  it("both catalogues carry the label, the composed line with its `<stamp>` tag, and the aria form", () => {
    for (const [name, cat] of [["en", en], ["de", de]] as const) {
      const m = (cat as { message: Record<string, string> }).message;
      expect(m.awayAnswered, `${name} label`).toBeTruthy();
      expect(m.awayAnsweredAt, `${name} composed`).toContain("<stamp>");
      expect(m.awayAnsweredAt, `${name} composed`).toContain("{label}");
      expect(m.awayAnsweredAt, `${name} composed`).toContain("{when}");
      expect(m.awayAnsweredAria, `${name} aria`).toContain("{whenLong}");
    }
  });
});
