/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import {
  deriveMailState, seedGrowth, type FilingFacts, type MailState, type MailStateInputs, type MailboxFacts,
} from "../app/shell/mail-state";

/**
 * THE STUCK STRIP COUNTS WHAT IS STUCK, UNDER ITS OWN CLOCK, FOR THE REASON ON RECORD.
 *
 * Reported: "1 message has not been filed for 75 minutes · your mail server would
 * not say why" over a filing nothing had refused, and "2 messages … 62 minutes" while a
 * seconds-old Screener move sat beside the old one. The derivation and the render are driven
 * together here; the controls keep a real refusal's class and an older server's sentence.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let current: MailState | null = null;
vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: current, refresh: () => {} }),
}));

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  document.body.innerHTML = "";
});

const NOW = Date.parse("2026-09-27T01:12:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const resting: FilingFacts = {
  due: 0, deferred: 0, oldestPendingAt: null, nextAttemptAt: null, attempts: 0,
  lastRefusalClass: null, asOf: new Date(NOW).toISOString(), lastCycleAt: ago(20_000),
};

const mailbox = (filing: Partial<FilingFacts>): MailboxFacts => ({
  id: "mb1", address: "person@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: ago(30_000),
  initialImportCompletedAt: ago(600_000), createdAt: ago(900_000),
  filing: { ...resting, ...filing },
});

const inputs = (filing: Partial<FilingFacts>): MailStateInputs => ({
  sync: { bootstrapping: false, failures: 0, terminal: false, refused: false },
  failureStreak: 3, mailboxes: [mailbox(filing)], mirrored: 495, growth: seedGrowth(495),
  freshness: { state: "current" as const, asOf: ago(30_000) },
  engineFreshness: { state: "current" as const, asOf: ago(30_000) },
  now: NOW, demo: false,
} as MailStateInputs);

async function strip(filing: Partial<FilingFacts>, locale: "en" | "de" = "en"): Promise<string> {
  current = deriveMailState(inputs(filing));
  const { SyncBar } = await import("../app/shell/SyncBar.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: locale === "en" ? en : de, timeZone: "UTC", now: new Date(NOW),
      children: h(SyncBar, null),
    }));
  });
  return container.textContent ?? "";
}

describe("the stuck filing sentence", () => {
  it("a filing nothing refused is not blamed on the mail server", async () => {
    const text = await strip({
      due: 1, oldestPendingAt: ago(75 * MIN), stuck: 1, stuckSince: ago(75 * MIN), stuckRefusalClass: null,
    });
    expect(text).toContain("1 message has not been filed for 75 minutes");
    expect(text, "a filing nothing refused was blamed on the server").not.toContain("would not say why");
    expect(text).not.toContain("refused");
    expect(text).toContain("no refusal is recorded");
  });

  it("a seconds-old move beside a stuck one is not counted under the old one's clock", async () => {
    const text = await strip({
      due: 2, oldestPendingAt: ago(62 * MIN), stuck: 1, stuckSince: ago(62 * MIN), stuckRefusalClass: null,
    });
    expect(text, "the fresh move was counted as stuck").toContain("1 message has not been filed for 62 minutes");
    expect(text).not.toContain("2 messages");
  });

  it("the clock is the stuck rows' own, and the reason is theirs", async () => {
    // The oldest outstanding row (40 min, never refused) and a refused row stuck on its attempts
    // (3 min old): the count and the clock name the stuck row, never the other one.
    const text = await strip({
      due: 1, deferred: 1, attempts: 2, oldestPendingAt: ago(4 * MIN), lastRefusalClass: "over_quota",
      stuck: 1, stuckSince: ago(3 * MIN), stuckRefusalClass: "over_quota",
    });
    expect(text).toContain("1 message has not been filed for 3 minutes");
    expect(text).toContain("the mailbox is full");
  });

  it("CONTROL — a real refusal still reads its class", async () => {
    const text = await strip({
      deferred: 1, attempts: 3, oldestPendingAt: ago(10 * MIN), lastRefusalClass: "read_only",
      nextAttemptAt: new Date(NOW + 3_600_000).toISOString(),
      stuck: 1, stuckSince: ago(10 * MIN), stuckRefusalClass: "read_only",
    });
    expect(text).toContain("1 message has not been filed for 10 minutes");
    expect(text).toContain("the folder will not take it");
  });

  it("CONTROL — a seconds-old move alone is filing, not stuck", async () => {
    const text = await strip({ due: 1, oldestPendingAt: ago(20_000), stuck: 0, stuckSince: null, stuckRefusalClass: null });
    expect(text).toContain("Filing 1 message on your mail server");
    expect(text).not.toContain("not been filed");
  });

  it("CONTROL — an older server without the stuck fields keeps the old count", async () => {
    const text = await strip({ due: 2, oldestPendingAt: ago(62 * MIN) });
    expect(text).toContain("2 messages have not been filed for 62 minutes");
    expect(text).toContain("no refusal is recorded");
  });

  it("is German in German", async () => {
    const text = await strip({
      due: 1, oldestPendingAt: ago(75 * MIN), stuck: 1, stuckSince: ago(75 * MIN), stuckRefusalClass: null,
    }, "de");
    expect(text).toContain("1 Nachricht wurde seit 75 Minuten nicht einsortiert");
    expect(text).toContain("keine Ablehnung verzeichnet");
    expect(text).not.toContain("nennt keinen Grund");
  });
});
