/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, message, mountShell, press, stubDom, unmountAll, waitFor } from "./_draft-shell.js";

/**
 * A DECISION TAKEN FROM THE SENDER SHEET OFFERS THE UNDO THE LIST'S DECISION DOES. From the
 * Screener's preview, a place pressed in the sheet sent the decision at once with a sentence and
 * no Undo, where the list's own press holds it for the undo window. The sheet's press about a
 * sender still at the gate now goes through the Screener's door.
 * Mutation: the gate row not handed to `screener.decide` → red on the missing Undo.
 */

beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
});
afterEach(unmountAll);

const STRANGER = { address: "stranger@newcomer.example", name: "A newcomer" };
const held = message("h1", { from: STRANGER, folder: "ohmail/Screener", unread: true });

describe("the sender sheet's decision can be taken back", () => {
  it("a place pressed in the sheet holds the decision, offers Undo, and Undo keeps the sender waiting", async () => {
    const s = await mountShell("#/screener", [held]);
    await waitFor(() => s.el.querySelector(".view-screener .row[data-id='h1']") != null, "the waiting sender");
    await press(s.el.querySelector(".view-screener .row[data-id='h1']"), "the waiting row");
    await waitFor(() => s.el.querySelector(".hmail .hm-who") != null, "the preview's sender press");
    await act(async () => { s.el.querySelector<HTMLButtonElement>(".hmail .hm-who")!.click(); });
    await waitFor(() => document.querySelector(".senderm li[data-dest='ohbox']") != null, "the sender sheet");

    await act(async () => { document.querySelector<HTMLElement>(".senderm li[data-dest='ohbox']")!.click(); });

    await waitFor(() => document.querySelector(".toast-act") != null, "the decision's Undo");
    expect(document.querySelector(".toast-act")!.textContent).toBe("Undo");
    expect(s.sent.filter((m) => m.kind === "screener_decide"), "decided at once, with nothing to undo").toEqual([]);
    await waitFor(() => s.el.querySelector(".view-screener .row[data-id='h1']") == null, "the decided sender leaving the list");

    await act(async () => { document.querySelector<HTMLButtonElement>(".toast-act")!.click(); });
    await waitFor(() => s.el.querySelector(".view-screener .row[data-id='h1']") != null, "the sender back in the list");
    expect(s.sent.filter((m) => m.kind === "screener_decide")).toEqual([]);
  }, 20_000);

  it("the sheet's past-mail answer rides the decision when the window closes", async () => {
    const s = await mountShell("#/screener", [held]);
    await waitFor(() => s.el.querySelector(".view-screener .row[data-id='h1']") != null, "the waiting sender");
    await press(s.el.querySelector(".view-screener .row[data-id='h1']"), "the waiting row");
    await waitFor(() => s.el.querySelector(".hmail .hm-who") != null, "the preview's sender press");
    await act(async () => { s.el.querySelector<HTMLButtonElement>(".hmail .hm-who")!.click(); });
    await waitFor(() => document.querySelector(".senderm .sm-retro") != null, "the past-mail switch");
    const retro = document.querySelector<HTMLButtonElement>(".senderm .sm-retro")!;
    if (retro.getAttribute("aria-checked") === "true") await act(async () => { retro.click(); });
    expect(retro.getAttribute("aria-checked")).toBe("false");
    await act(async () => { document.querySelector<HTMLElement>(".senderm li[data-dest='ohbox']")!.click(); });
    await waitFor(() => document.querySelector(".toast-act") != null, "the decision's Undo");

    // Leaving the Screener closes the window: the decision goes, with the answer it was given.
    await act(async () => { window.location.hash = "#/ohbox"; });
    await waitFor(() => s.sent.some((m) => m.kind === "screener_decide"), "the decision on the wire");
    const decide = s.sent.find((m) => m.kind === "screener_decide") as { applyRetro?: boolean };
    expect(decide.applyRetro, "the past-mail answer was dropped on the way").toBe(false);
  }, 20_000);
});
