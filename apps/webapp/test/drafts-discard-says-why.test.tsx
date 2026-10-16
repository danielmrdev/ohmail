/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import {
  FixturesAdapter, MutationRejectedError,
  type EngineMutation, type MutationAnswer, type MutationOutcome,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { composeRowKey } from "../app/shell/compose";
import { AUTOSAVE_DELAY_MS } from "../app/shell/compose-autosave";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * `if (res.status !== "confirmed") return;` stood at the Drafts list's delete: three of the four
 * `MutationStatus` values answered with nothing while the engine had already put the row back with
 * the rejection's sentence on the result. The rig settled the reported arm — marker present and
 * marker absent AT LOAD both put a DELETE on the wire; only a marker removed under a LIVE window
 * latches the gate `revoked`, refuses retryably and yields `queued`. All four are driven here, and
 * `FixturesAdapter`'s `mutate` is scripted per case so the ENGINE classifies each ending.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

const q = <T extends Element>(sel: string): T | null => host!.querySelector<T>(sel);
const press = async (el: HTMLElement): Promise<void> => { await act(async () => { el.click(); }); };
const settle = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); });
};

async function goto(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await settle(6);
  await settleFirstPaint();
}

async function mountShell(): Promise<void> {
  await unmount();
  const { AppShell } = await import("../app/shell/AppShell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-09-16T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  await settle(10);
}

async function typeInto(sel: string, value: string): Promise<void> {
  const input = q<HTMLInputElement>(sel)!;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Write a message on `#/compose` and let the autosave give it a row. Returns the row's id. */
async function makeADraft(): Promise<string> {
  await goto("#/compose");
  await typeInto("#compose-to", "lena@atelier.example");
  await typeInto("#compose-subject", "Bis Montag");
  await act(async () => { await new Promise((r) => setTimeout(r, AUTOSAVE_DELAY_MS + 400)); });
  await settle(10);
  const id = window.localStorage.getItem(composeRowKey());
  expect(id, "the compose never wrote a row, so there is nothing to press Delete on").not.toBeNull();
  return id!;
}

const rowOf = (id: string): HTMLElement | null => q<HTMLElement>(`.draft-row[data-id="${id}"]`);
const toastText = (): string => q<HTMLElement>(".toast[role='status']")?.textContent ?? "";

async function pressDelete(id: string): Promise<void> {
  await press(q<HTMLButtonElement>(`.draft-row[data-id="${id}"] .draft-discard`)!);
  await settle(4);
  // By its LABEL: Keep comes first in the confirm on purpose, so "the first button" is the wrong one.
  const confirm = Array.from(host!.querySelectorAll<HTMLButtonElement>(".draft-confirm button"))
    .find((b) => (b.textContent ?? "").trim() === messages.drafts.discardConfirm) ?? null;
  expect(confirm, "the confirm behind Delete did not open, or lost its destructive button").not.toBeNull();
  await press(confirm!);
  await settle(12);
}

/**
 * What the adapter answers for the NEXT `draft_discard`. Everything else is served by the real
 * fixture, so the list, the row and the compose binding are all the shipped ones.
 */
type Scripted =
  | { kind: "refuse"; error: MutationRejectedError }
  | { kind: "organizerQueued" };
let scripted: Scripted | null = null;

beforeEach(() => {
  window.location.hash = "";
  scripted = null;
  try { window.localStorage.clear(); } catch { /* blocked storage; the in-memory half still runs */ }
  const real = FixturesAdapter.prototype.mutate;
  vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(
    async function (this: FixturesAdapter, m: EngineMutation, opts: { idempotencyKey: string }) {
      if (m.kind === "draft_discard" && scripted !== null) {
        if (scripted.kind === "refuse") throw scripted.error;
        /* `EngineAdapter.mutate` answers `MutationAnswer` — outcome OR queued — and the engine
           branches on `settlement === "queued"`. `FixturesAdapter` DECLARES the narrower
           `MutationOutcome` because its world has no organizer, so the 202 shape needs the cast
           to travel through this spy. The value is the adapter contract's own, built here in
           full. */
        const queued: MutationAnswer = {
          settlement: "queued", queuedWith: { name: "Mila's laptop" },
          requestId: "req-1", changes: [], seq: null,
        };
        return queued as unknown as MutationOutcome;
      }
      return await real.call(this, m, opts);
    },
  );
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {} unobserve(): void {} disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await unmount();
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

describe("Every ending of a draft discard says what happened", () => {
  /**
   * `confirmed` — the ending that already worked, kept here so the three below cannot be
   * satisfied by a Delete that refuses everybody. A sentence for a discard that HAPPENED would be
   * narration, so the assertion is that nothing is said and the row is gone.
   */
  it("says nothing and takes the row when the discard is confirmed", async () => {
    await mountShell();
    const id = await makeADraft();
    await goto("#/drafts");
    expect(rowOf(id), "the draft that was just written is not in the list").not.toBeNull();

    await pressDelete(id);

    expect(rowOf(id), "a confirmed discard left the row in the list").toBeNull();
    expect(toastText(), "a discard that happened narrated itself").toBe("");
  }, 30_000);

  /**
   * `rolled_back` with a code that is NOT `send_recorded` — the server's own `conflict` 409 (a
   * scheduled row, or one holding a live send key: `drafts-service.ts` `remove`). The engine drops
   * the overlay, the row reverts, and the rejection carries the server's sentence. Before this
   * slice the whole handling was `return`.
   *
   * Mutation: put `if (res.status !== "confirmed") return;` back in place of the switch.
   * Real failure text: expected '' to contain 'Not discarded'.
   */
  it("quotes the server when the discard is rolled back", async () => {
    await mountShell();
    const id = await makeADraft();
    await goto("#/drafts");
    scripted = {
      kind: "refuse",
      error: new MutationRejectedError(
        "this message is scheduled to send; cancel the schedule to discard it",
        { status: 409, code: "conflict", retryable: false },
      ),
    };

    await pressDelete(id);

    expect(
      rowOf(id),
      "the engine reverts a rolled-back discard, so the row must be back in the list",
    ).not.toBeNull();
    expect(
      toastText(),
      "the server said why it refused and the surface threw the sentence away — this is the "
      + "silent comeback that was reported: the row vanishes for a frame and returns",
    ).toContain("Not discarded");
    expect(
      toastText(),
      "the refusal was rendered without the server's own reason, so it names no way forward",
    ).toContain("cancel the schedule to discard it");
  }, 30_000);

  /**
   * A refusal that carries no sentence still says SOMETHING. A server that answers 500 with an
   * empty body is the case, and "nothing happened, silently" is the one answer that may not be
   * given.
   */
  it("says the draft is still here when a refusal names no reason", async () => {
    await mountShell();
    const id = await makeADraft();
    await goto("#/drafts");
    scripted = {
      kind: "refuse",
      error: new MutationRejectedError("", { status: 500, code: null, retryable: false }),
    };

    await pressDelete(id);

    expect(rowOf(id), "a rolled-back discard must leave the row in the list").not.toBeNull();
    expect(
      toastText(),
      "a refusal with no sentence was answered with silence",
    ).toContain(messages.drafts.discardRefusedUnnamed);
  }, 30_000);

  /**
   * `queued` — THE ARM THE RIG MEASURED. A retryable rejection keeps the overlay, so the row is
   * gone on this screen and still there on the server; the verb replays under the same key when
   * the gate opens. The engine's own gate refuses exactly this way when the storage-owner marker changes
   * under a live window (`sync-scheduler.ts`, `{ retryable: true }`), which is how a person gets
   * a row that disappears and is back on the next load.
   *
   * Mutation: drop the `case "queued"` arm. Real failure text:
   *   expected '' to contain 'Not discarded yet'.
   */
  it("says it has not gone through yet when the verb is queued", async () => {
    await mountShell();
    const id = await makeADraft();
    await goto("#/drafts");
    scripted = {
      kind: "refuse",
      error: new MutationRejectedError(
        "ohmail: this mailbox is not the account this browser is signed in to",
        { retryable: true },
      ),
    };

    await pressDelete(id);

    expect(
      toastText(),
      "a queued discard is painted as done and says nothing — the row is gone here, still there "
      + "on the server, and back on the next load with no explanation",
    ).toContain("Not discarded yet");
  }, 30_000);

  /**
   * `awaiting_organizer` — the server recorded the request for whichever install organizes this
   * mailbox. The optimistic paint goes back (`holdForOrganizer`), so the row is ON SCREEN: without
   * a sentence the press reads as having done nothing at all.
   *
   * Mutation: drop the `case "awaiting_organizer"` arm. Real failure text:
   *   expected '' to contain 'Asked for'.
   */
  it("says it was recorded when the discard waits on the organizer", async () => {
    await mountShell();
    const id = await makeADraft();
    await goto("#/drafts");
    scripted = { kind: "organizerQueued" };

    await pressDelete(id);

    expect(
      rowOf(id),
      "the organizer hold drops the optimistic paint, so the row belongs on screen",
    ).not.toBeNull();
    expect(
      toastText(),
      "a request the server recorded for another install was reported as nothing happening",
    ).toContain("Asked for");
  }, 30_000);
});
