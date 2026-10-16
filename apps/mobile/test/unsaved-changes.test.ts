/**
 * THE PHONE'S HALF OF "COULD NOT BE SAVED" — parity with the browser, asserted rather than assumed.
 *
 * The engine gives up on a verb after a bounded number of server-answered failures and moves it out
 * of the replay set. That bound is SHARED code, so it applies to this app whether or not it renders
 * anything — which is exactly why this file exists. A phone with no surface for it would drop a
 * person's work silently while the browser explained it, and nothing would fail: the engine would
 * be behaving correctly and the app would be quietly lying by omission.
 *
 * So the assertions here are about the two things a platform actually owes: a sentence for every
 * verb, and a door to both answers.
 */
import { describe, expect, it } from "vitest";
import type { AbandonedMutation } from "@ohmail/client-engine";
import { MUTATION_KINDS } from "@ohmail/client-engine";
import { Copy } from "../src/copy";
import { describeKind, reason, retrySaid } from "../src/ui/unsaved-copy";

const row = (kind: string, error: Partial<AbandonedMutation["error"]> = {}): AbandonedMutation => ({
  id: `id-${kind}`,
  key: `key-${kind}`,
  mutation: { kind } as never,
  at: 1,
  attempts: 8,
  error: { message: "nope", code: "conflict", status: 409, ...error },
  superseded: false,
  retryable: true,
  refusedCode: null,
});

describe("every verb the engine can abandon has words on the phone", () => {
  it("names each shipped mutation kind, and never shows a raw kind", () => {
    // Derived from `MUTATION_KINDS` — the shipped list, not a copy — so a verb added later is
    // covered by this assertion the day it lands rather than the day somebody remembers.
    const unnamed: string[] = [];
    for (const kind of MUTATION_KINDS) {
      const label = describeKind(row(kind));
      // The failure this catches is not a missing translation; it is `folder_op_dismiss` appearing
      // on screen in front of a person trying to understand why their mail did not send.
      if (label.includes("_")) unnamed.push(`${kind} → ${label}`);
      expect(label.length, kind).toBeGreaterThan(0);
    }
    expect(unnamed).toEqual([]);
  });

  it("degrades to a generic sentence for a kind it has no words for, rather than throwing", () => {
    // The web half's identical guard: a computed lookup would throw here, inside the one surface
    // that only renders when something has already gone wrong.
    expect(describeKind(row("verb_added_next_tuesday"))).toBe(Copy.unsavedKindOther);
  });
});

describe("what the phone says about WHY, and what it refuses to repeat", () => {
  it("quotes a refusal a person can act on", () => {
    expect(reason(row("move", { message: "that folder is gone", code: "not_found", status: 404 })))
      .toBe("that folder is gone");
  });

  it("never quotes the unhandled-fault envelope", () => {
    // `{"code":"internal","message":"internal error"}` is the API's envelope for a throw nobody
    // modelled. Repeating it puts the app's own noise in front of a person.
    expect(reason(row("mail_send", { message: "internal error", code: "internal", status: 500 })))
      .toBe(Copy.unsavedNoReason);
    // A blank sentence is the same failure with fewer characters.
    expect(reason(row("mail_send", { message: "   ", code: "weird", status: 500 })))
      .toBe(Copy.unsavedNoReason);
    // …and an adapter-side rejection that carried no code at all.
    expect(reason(row("mail_send", { message: "boom", code: null, status: null })))
      .toBe(Copy.unsavedNoReason);
  });
});

describe("the phone and the browser say the same words", () => {
  it("uses the same sentences as the web copy for every shared key", async () => {
    // PARITY IS A RULE (mobile/web), and copy is where it rots first: one platform gets a reword,
    // the other keeps the old sentence, and a person who uses both learns two names for one state.
    // Read from the web's message catalogue rather than restated here, so a change on either side
    // has to be a change on both.
    const web = (await import("../../webapp/messages/en.json")).default.sync as Record<string, string>;

    expect(Copy.unsavedShow).toBe(web.unsavedShow);
    expect(Copy.unsavedHide).toBe(web.unsavedHide);
    expect(Copy.unsavedRetry).toBe(web.unsavedRetry);
    expect(Copy.unsavedDiscard).toBe(web.unsavedDiscard);
    expect(Copy.unsavedNoReason).toBe(web.unsavedNoReason);
    expect(Copy.unsavedKindOther).toBe(web.unsavedKindOther);
    expect(Copy.unsavedKindSend).toBe(web.unsavedKindSend);
    expect(Copy.unsavedKindMove).toBe(web.unsavedKindMove);
    expect(Copy.unsavedKindRead).toBe(web.unsavedKindRead);

    // The count is a plural on the web and a function here; the rendered strings must still match.
    expect(Copy.unsavedCount(1)).toBe("1 change could not be saved");
    expect(Copy.unsavedCount(3)).toBe("3 changes could not be saved");
    expect(web.unsavedCount).toContain("change could not be saved");
    expect(web.unsavedCount).toContain("changes could not be saved");
  });
});

describe("I7 — every surface that can abandon work can show it", () => {
  it("the chrome renders the notice on the pushed screens, not only the tab roots", async () => {
    // A verb can be abandoned from the message, sender, triage, scheduled, folder, settings and
    // server screens — all of which render `DetailBar`. Until this, the notice appeared nowhere
    // until the reader navigated back to a tab root: a recovery surface found by accident.
    const { readFileSync } = await import("node:fs");
    const chrome = readFileSync(new URL("../src/ui/chrome.tsx", import.meta.url), "utf8");
    const detail = chrome.slice(chrome.indexOf("export function DetailBar"));
    const top = chrome.slice(chrome.indexOf("export function TopBar"), chrome.indexOf("export function DetailBar"));
    expect(top, "TopBar must render it").toContain("<UnsavedChanges />");
    expect(detail, "DetailBar must render it too").toContain("<UnsavedChanges />");
  });

  it("the recovery controls sit INSIDE the scroller, not merely beside the word", async () => {
    /**
     * ── WHAT THIS USED TO BE, AND WHY IT WAS WORTH NOTHING ─────────────────────────────────
     *
     * `expect(src).toContain("ScrollView")` plus `toMatch(/maxHeight/)`. Round four named the
     * mutation that walks straight through it: replace the JSX `<ScrollView>` with `<View>` and
     * leave the import, the comment and the `maxHeight` style. Both assertions still pass, and
     * the controls are unreachable again — the exact defect this test was added for.
     *
     * A substring is not a structure. What matters is CONTAINMENT: Try again and Discard have to
     * be inside the element that scrolls. So the JSX is bracket-matched and the controls are
     * required to fall between the scroller's open and close tags.
     *
     * ── AND THIS IS STILL NOT A MOUNT ──────────────────────────────────────────────────────
     *
     * It reads source, which is the weaker instrument. Mounting a React Native tree needs a
     * renderer this repository does not have — `react-test-renderer` and
     * `@testing-library/react-native` are absent from the workspace and from the pnpm store — so
     * adding one means a lockfile change and an install. That is a shared-file decision, not an
     * implementer's, and it is recorded here rather than quietly skipped.
     */
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/ui/UnsavedChanges.tsx", import.meta.url), "utf8");

    const open = src.indexOf("<ScrollView");
    expect(open, "the expanded list is not inside a ScrollView at all").toBeGreaterThan(-1);
    const close = src.indexOf("</ScrollView>", open);
    expect(close, "the ScrollView is never closed — the list cannot be inside it").toBeGreaterThan(open);

    const openTagEnd = src.indexOf(">", open);
    const openTag = src.slice(open, openTagEnd + 1);
    expect(openTag, "the scroller has no height bound, so it cannot scroll").toMatch(/maxHeight/);

    const inside = src.slice(openTagEnd, close);
    expect(
      inside,
      "Try again is outside the scroller: with enough rows it sits below the viewport and cannot "
        + "be reached",
    ).toContain("Copy.unsavedRetry");
    expect(
      inside,
      "Discard is outside the scroller — the same unreachability, on the control that clears it",
    ).toContain("Copy.unsavedDiscard");
  });

  it("the notice survives its last row, or the check-Sent warning has nowhere to appear", async () => {
    /**
     * ── ROUND FOUR, FINDING 10 ─────────────────────────────────────────────────────────────
     *
     * A retried send whose answer was lost ends with the record gone: the retry moves it to the
     * live collection, and the terminal outcome removes that row too. The warning that says "this
     * may have been sent — check Sent" lives in the notice's own `said` state, and the notice
     * returned `null` the moment the collection emptied. So the one outcome a person MUST see was
     * rendered into a component that had just decided not to exist.
     *
     * Reverting the early return to `rows.length === 0` alone restores that, and round four
     * found nothing in the mobile suite that would notice. The web test does not cover the phone.
     *
     * Structural, not a mount, for the reason given above: this repository has no React Native
     * renderer. What it pins is the half of the condition that is load-bearing.
     */
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/ui/UnsavedChanges.tsx", import.meta.url), "utf8");
    const early = src.match(/if \(([^)]*)\)\s*return null;/);
    expect(early, "the notice has no early return at all any more — check this guard, not the code")
      .not.toBeNull();
    expect(
      early![1],
      "the notice disappears as soon as the last row goes, taking the check-Sent warning with it",
    ).toMatch(/said/);
  });

  it("the row actions stack below 380px rather than clipping", async () => {
    // THE STATED REASON USED TO BE GERMAN, and that was a claim about a state this app cannot
    // reach: `copy.ts` is one hard-coded English deck with no locale mechanism, so the phone
    // cannot render "Erneut versuchen" at all. The assertion is the same; the justification now
    // matches what is measurable — the threshold, and the two labels that share the row.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/ui/UnsavedChanges.tsx", import.meta.url), "utf8");
    expect(src).toContain("useWindowDimensions");
    expect(src).toMatch(/narrow \? "column" : "row"/);
    expect(src).toMatch(/width < 380/);
    // Both labels do share one row, which is what makes the threshold load-bearing.
    expect(Copy.unsavedRetry).not.toBe("");
    expect(Copy.unsavedDiscard).not.toBe("");
  });

  it("a send retried from the strip whose key had already delivered says so", () => {
    expect(retrySaid({ status: "confirmed", firstSend: { status: "sent", at: "x" } })).toBe(Copy.unsavedSendAlreadyWent);
    expect(retrySaid({ status: "confirmed" }), "CONTROL: an ordinary confirmation says nothing").toBeNull();
  });
});

