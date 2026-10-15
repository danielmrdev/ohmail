/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { draftsList, type EngineDraft, type EngineMutation } from "@ohmail/client-engine";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";
import {
  NOW, act, message, mountShell, press, replyDraft, replySurface, stubDom, unmountAll, waitFor, type DraftShell,
} from "./_draft-shell.js";

/**
 * A REPLY STARTED INLINE IS A DRAFT ON THE ACCOUNT (tester round 24). The web's inline editor kept
 * an unsent reply only in this browser's storage, while Drafts says drafts are "saved to your
 * account, so they're here on every device". The editor now writes a row after the same pause as
 * the composer, keeps writing that one row, reopens it on Reply on another device, and Send sends it.
 */

beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
});
afterEach(unmountAll);

type Save = Extract<EngineMutation, { kind: "draft_save" }>;
const saves = (s: DraftShell): Save[] => s.sent.filter((m): m is Save => m.kind === "draft_save");
const sends = (s: DraftShell) => s.sent.filter((m) => m.kind === "mail_send") as Array<Extract<EngineMutation, { kind: "mail_send" }>>;
const rowsFor = (s: DraftShell, id: string): EngineDraft[] =>
  s.store.list<EngineDraft>("draft").filter((d) => d.inReplyToMessageId === id && d.status === "draft");
/** Past the composer's two-second pause, in real time: this harness runs real timers. */
const PAUSE_ROUNDS = 200;

async function key(k: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
  await settleEditor();
}

async function openReplyOn(s: DraftShell, id: string): Promise<void> {
  await waitFor(() => s.el.querySelector(`.view-ohbox .row[data-id='${id}']`) != null, "the row");
  await press(s.el.querySelector(`.view-ohbox .row[data-id='${id}']`), "the row");
  await key("r");
  await waitFor(() => replySurface(s.el) != null, "the reply editor");
}

async function typeAndPause(s: DraftShell, text: string, nth: number): Promise<Save> {
  await act(async () => { typeInto(replySurface(s.el)!, text); });
  await waitFor(() => saves(s).length >= nth, `draft save ${nth} on the wire`, PAUSE_ROUNDS);
  return saves(s)[nth - 1]!;
}

const sendButton = (el: HTMLElement): HTMLButtonElement | undefined =>
  [...el.querySelectorAll<HTMLButtonElement>(".reply .reply-actions button")]
    .find((b) => (b.textContent ?? "").startsWith("Send"));

describe("a reply typed inline is a draft on the account", () => {
  it("the pause writes one row, and the next pause writes that row again", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await openReplyOn(s, "m1");

    const first = await typeAndPause(s, "See you on Thursday", 1);
    expect([first.draftId, first.inReplyToMessageId, first.body]).toEqual([null, "m1", "See you on Thursday"]);
    const rows = rowsFor(s, "m1");
    expect(rows.map((d) => d.body), "the account holds no draft of the reply").toEqual(["See you on Thursday"]);

    const second = await typeAndPause(s, "See you on Thursday at ten", 2);
    expect(second.draftId, "the second pause made a second row").toBe(rows[0]!.id);
    expect(rowsFor(s, "m1").map((d) => d.body)).toEqual(["See you on Thursday at ten"]);
  }, 30_000);

  it("closed and opened again with Reply, it is the same row", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await openReplyOn(s, "m1");
    await typeAndPause(s, "Thursday works", 1);
    const row = rowsFor(s, "m1")[0]!.id;
    await key("Escape");
    await waitFor(() => replySurface(s.el) == null, "the editor closed");

    await key("r");
    await waitFor(() => replySurface(s.el) != null, "the reply editor again");
    expect(replySurface(s.el)!.textContent).toContain("Thursday works");
    const again = await typeAndPause(s, "Thursday works, at ten", 2);
    expect(again.draftId, "Reply again made a second row").toBe(row);
    expect(rowsFor(s, "m1").map((d) => d.id)).toEqual([row]);
  }, 30_000);

  it("another device lists it, opens it on Reply, keeps writing it and sends it", async () => {
    const first = await mountShell("#/ohbox", [message("m1")]);
    await openReplyOn(first, "m1");
    await typeAndPause(first, "Thursday works", 1);
    const written = first.store.list<EngineDraft>("draft");
    const row = rowsFor(first, "m1")[0]!.id;
    await unmountAll();

    // Another device: the account's rows, none of this browser's storage.
    try { window.localStorage.clear(); } catch { /* storage blocked */ }
    stubDom();
    const other = await mountShell("#/drafts", [message("m1")], written);
    await waitFor(() => other.el.querySelector(`.draft-row[data-id='${row}']`) != null, "the reply listed in Drafts");
    // …and in the shared list the phone's Drafts is drawn from.
    expect(draftsList(other.store, NOW).map((d) => d.id), "the phone's Drafts would not list it").toContain(row);

    await act(async () => {
      window.location.hash = "#/ohbox";
      window.dispatchEvent(new Event("hashchange"));
    });
    await openReplyOn(other, "m1");
    expect(replySurface(other.el)!.textContent, "Reply did not open the account's draft").toContain("Thursday works");
    for (let i = 0; i < 100; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(saves(other), "opening the draft wrote it").toEqual([]);

    const more = await typeAndPause(other, "Thursday works, I will bring the samples", 1);
    expect(more.draftId, "the other device made a second row").toBe(row);
    await act(async () => { sendButton(other.el)!.click(); });
    await waitFor(() => sends(other).length === 1, "the send on the wire");
    expect(sends(other)[0]!.draftId, "the send made a row of its own").toBe(row);
  }, 40_000);

  it("Send while the first save is in the air leaves no copy of the sent reply", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await openReplyOn(s, "m1");
    let release: () => void = () => {};
    s.saveGate.wait = new Promise<void>((r) => { release = r; });
    await typeAndPause(s, "On my way", 1);
    await act(async () => { sendButton(s.el)!.click(); });
    s.saveGate.wait = null;
    await act(async () => { release(); });
    await waitFor(() => sends(s).length === 1, "the send on the wire");
    await waitFor(() => s.sent.some((m) => m.kind === "draft_discard"), "the copy undone");
    expect(rowsFor(s, "m1"), "a draft of the sent reply stayed in Drafts").toEqual([]);
  }, 30_000);

  it("a reply edited on another device since opens here with that device's text", async () => {
    const first = await mountShell("#/ohbox", [message("m1")]);
    await openReplyOn(first, "m1");
    await typeAndPause(first, "Thursday works", 1);
    const row = rowsFor(first, "m1")[0]!;
    await unmountAll();

    // This browser keeps its storage; the phone has since written the row.
    stubDom();
    const edited = { ...row, body: "Thursday works, the phone says ten", updatedAt: "2026-09-27T09:10:00.000Z" };
    const back = await mountShell("#/ohbox", [message("m1")], [edited]);
    await openReplyOn(back, "m1");
    expect(replySurface(back.el)!.textContent, "this browser's older text won over the phone's")
      .toContain("the phone says ten");
    for (let i = 0; i < 100; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(saves(back), "opening the phone's text wrote it back").toEqual([]);
  }, 40_000);

  it("typing this browser never saved, beside a draft written elsewhere, writes over neither", async () => {
    const first = await mountShell("#/ohbox", [message("m1")]);
    await openReplyOn(first, "m1");
    // Typed and closed inside the pause: the words are in this browser only.
    await act(async () => { typeInto(replySurface(first.el)!, "the words typed here"); });
    await unmountAll();
    expect(saves(first), "the words reached the account after all").toEqual([]);

    stubDom();
    const phone = { ...replyDraft("d-phone", "m1", "the words typed on the phone"), updatedAt: "2026-09-27T09:10:00.000Z" };
    const back = await mountShell("#/ohbox", [message("m1")], [phone]);
    await openReplyOn(back, "m1");
    expect(replySurface(back.el)!.textContent).toContain("the words typed here");
    const saved = await typeAndPause(back, "the words typed here, and more", 1);
    expect(saved.draftId, "this browser's words were written over the phone's draft").toBeNull();
    expect(rowsFor(back, "m1").map((d) => d.body).sort())
      .toEqual(["the words typed here, and more", "the words typed on the phone"]);
  }, 40_000);

  it("Send before the pause sends the text and leaves no draft behind", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await openReplyOn(s, "m1");
    await act(async () => { typeInto(replySurface(s.el)!, "On my way"); });
    await act(async () => { sendButton(s.el)!.click(); });
    await waitFor(() => sends(s).length === 1, "the send on the wire");
    for (let i = 0; i < 120; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(saves(s), "the pause wrote the sent text as a draft").toEqual([]);
    expect(sends(s)[0]!.draftId ?? null).toBeNull();
  }, 30_000);
});
