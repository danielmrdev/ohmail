/** @vitest-environment jsdom */
/**
 * A DRAFT SENT FROM ANOTHER DEVICE WHILE IT IS OPEN HERE SAYS SO. The shipped shell over
 * an engine whose next `/sync` carries the server's own delta for that send: the row comes back
 * `status: "sent"` with its text withheld (`draftRowToSnapshotDTO`). The editor then said nothing, kept
 * "Saved to your drafts after a moment" while saving nothing, Send did nothing in silence, and Cancel
 * said the letter stays in Drafts. Every word typed after the send was lost on reload.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineDraft, EngineMutation, SyncChange } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { AUTOSAVE_DELAY_MS } from "../app/shell/compose-autosave";
import { act, mountShell, NOW, press, stubDom, unmountAll, waitFor, type DraftShell } from "./_draft-shell.js";

const compose = messages.compose as unknown as Record<string, string>;
const D = "d-elsewhere";

const letter = (over: Partial<EngineDraft> = {}): EngineDraft => ({
  id: D, mailboxId: "mb1", threadId: null, inReplyToMessageId: null,
  subject: "Plans for Friday", body: "Written in this tab.",
  to: [{ name: null, address: "lena@example.invalid" }], cc: [], bcc: [],
  rationale: null, status: "draft",
  createdAt: "2026-09-27T08:40:00.000Z", updatedAt: "2026-09-27T08:40:00.000Z",
  ...over,
} as unknown as EngineDraft);

/** The server's delta for a send another device made of this row — the row, not a delete. */
const sentElsewhere = (): SyncChange => ({
  type: "draft", op: "update", id: D, seq: 0, updatedAt: NOW.toISOString(),
  entity: { ...letter(), status: "sent", body: null, html: null, bodyOmitted: "sent" },
} as unknown as SyncChange);

let shell: DraftShell;
const q = <T extends Element>(sel: string): T | null => shell.el.querySelector<T>(sel);
const text = (): string => shell.el.textContent ?? "";
const button = (label: string): HTMLButtonElement | null =>
  Array.from(shell.el.querySelectorAll<HTMLButtonElement>(".view-compose button"))
    .find((b) => (b.textContent ?? "").trim().startsWith(label) && !/later/i.test(b.textContent ?? "")) ?? null;
const saves = (): EngineMutation[] => shell.sent.filter((m) => m.kind === "draft_save");
const sends = (): EngineMutation[] => shell.sent.filter((m) => m.kind === "mail_send");

async function typeSubject(value: string): Promise<void> {
  const input = q<HTMLInputElement>("#compose-subject")!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const pause = async (ms: number): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };

/** Open the letter from Drafts, as the tester did, and let the other device's send arrive. */
async function openThenSentElsewhere(): Promise<void> {
  shell = await mountShell("#/drafts", [], [letter()]);
  await waitFor(() => q(`.draft-row[data-id="${D}"] .draft-open`) !== null, "the letter in Drafts");
  await press(q(`.draft-row[data-id="${D}"] .draft-open`), "open the letter");
  await waitFor(() => q<HTMLInputElement>("#compose-subject")?.value === "Plans for Friday", "the editor on the letter");
  shell.remote.push(sentElsewhere());
  await act(async () => { await shell.engine.syncOnce().catch(() => undefined); });
  await waitFor(() => (shell.engine.read().get<{ status?: string }>("draft", D)?.status) === "sent", "the delta applied");
}

beforeEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); stubDom(); });
afterEach(async () => { await unmountAll(); });

describe("a draft sent from another device while it is open here", () => {
  it("says so at once, and stops promising to save", async () => {
    await openThenSentElsewhere();
    await waitFor(() => text().includes(compose.sentElsewhere ?? "\u0000"), "the sentence", 20).catch(() => undefined);
    expect({ says: text().includes(compose.sentElsewhere ?? "\u0000"), promises: text().includes(compose.draftNote!) },
      "the editor stayed silent over a sent letter, or still promised a save").toEqual({ says: true, promises: false });
  }, 30_000);

  it("keeps what is typed afterwards as a NEW draft, and never writes to the sent row", async () => {
    await openThenSentElsewhere();
    const before = saves().length;
    await typeSubject("Plans for Friday, and Saturday");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => saves().length > before, "a save of the new text", 40).catch(() => undefined);
    const after = saves().slice(before) as Array<{ draftId?: string | null; subject?: string }>;
    expect(after.map((m) => ({ row: m.draftId ?? null, subject: m.subject })),
      "the words typed after the send were not kept, or were written to the sent row")
      .toEqual([{ row: null, subject: "Plans for Friday, and Saturday" }]);
  }, 30_000);

  it("Send says why, never sends the sent row again, and offers the new text as a new letter", async () => {
    await openThenSentElsewhere();
    await typeSubject("Plans for Friday, and Saturday");
    await press(button("Send"), "Send");
    await pause(200);
    expect({ sentRowAgain: sends().filter((m) => (m as { draftId?: string }).draftId === D).length, why: text().includes(compose.sentElsewhereSend ?? "\u0000") },
      "Send did nothing in silence, or sent the sent row again").toEqual({ sentRowAgain: 0, why: true });
    const offer = button(compose.sendAsNew ?? "\u0000");
    expect(offer, "no offer to send the new text as a new letter").not.toBeNull();
    await press(offer, "send as a new letter");
    await waitFor(() => sends().length > 0, "the new letter on the wire");
    const m = sends()[0] as { draftId?: string | null; subject?: string };
    expect({ row: m.draftId === D ? "the sent row" : "a new row", subject: m.subject })
      .toEqual({ row: "a new row", subject: "Plans for Friday, and Saturday" });
  }, 30_000);

  it("an unchanged sent letter is not offered again: Send says it already went", async () => {
    await openThenSentElsewhere();
    await press(button("Send"), "Send");
    await pause(200);
    expect({ sends: sends().length, why: text().includes(compose.sentElsewhereSend ?? "\u0000"), offer: button(compose.sendAsNew ?? "\u0000") !== null })
      .toEqual({ sends: 0, why: true, offer: false });
  }, 30_000);

  it("Cancel states the true state: the letter was sent, nothing stays in Drafts", async () => {
    await openThenSentElsewhere();
    await press(q<HTMLButtonElement>(".compose-foot .compose-cancel, .compose-cancel"), "Cancel");
    const what = q<HTMLElement>("#compose-cancel-what")?.textContent ?? "";
    expect(what, "Cancel said the sent letter stays in Drafts").toBe(compose.cancelWhatSentElsewhere);
  }, 30_000);

  it("a reload brings nothing back as a draft: the unchanged sent letter leaves this browser's buffer", async () => {
    await openThenSentElsewhere();
    const { readComposeDraft, readComposeRow } = await import("../app/shell/compose.js");
    await waitFor(() => text().includes(compose.sentElsewhere!), "the sentence");
    expect({ subject: readComposeDraft().subject, row: readComposeRow() }, "a reload would restore the sent letter and save it as a draft")
      .toEqual({ subject: "", row: null });
  }, 30_000);

  it("words typed before the send's word arrived, and never saved, are kept as the new draft", async () => {
    shell = await mountShell("#/drafts", [], [letter()]);
    await waitFor(() => q(`.draft-row[data-id="${D}"] .draft-open`) !== null, "the letter in Drafts");
    await press(q(`.draft-row[data-id="${D}"] .draft-open`), "open the letter");
    await waitFor(() => q<HTMLInputElement>("#compose-subject")?.value === "Plans for Friday", "the editor on the letter");
    await typeSubject("Plans for Friday, typed in the pause");
    shell.remote.push(sentElsewhere());
    await act(async () => { await shell.engine.syncOnce().catch(() => undefined); });
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => saves().length > 0, "a save of the typed words", 40).catch(() => undefined);
    expect((saves() as Array<{ draftId?: string | null; subject?: string }>).map((m) => ({ row: m.draftId ?? null, subject: m.subject })),
      "the words typed in the pause were counted as the sent letter and dropped")
      .toEqual([{ row: null, subject: "Plans for Friday, typed in the pause" }]);
    expect(text().includes(compose.sentElsewhere!)).toBe(true);
  }, 30_000);

  it("Discard after typing deletes only the new draft, and says what it deletes", async () => {
    await openThenSentElsewhere();
    await typeSubject("Plans for Friday, and Saturday");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => saves().length > 0, "the new draft");
    const fresh = (shell.sent.find((m) => m.kind === "draft_save") as { draftId?: string | null }).draftId ?? null;
    expect(fresh, "premise: the new draft is a create").toBeNull();
    await press(q<HTMLButtonElement>(".compose-cancel"), "Cancel");
    expect(q<HTMLElement>("#compose-cancel-what")?.textContent).toBe(compose.cancelWhatSentElsewhereTyped);
    const confirm = Array.from(shell.el.querySelectorAll<HTMLButtonElement>(".compose-confirm button"))
      .find((b) => (b.textContent ?? "").trim() === compose.cancelConfirm) ?? null;
    await press(confirm, "Discard message");
    await waitFor(() => shell.sent.some((m) => m.kind === "draft_discard"), "the delete");
    const gone = shell.sent.filter((m) => m.kind === "draft_discard").map((m) => (m as { draftId?: string }).draftId);
    expect(gone.length === 1 && gone[0] !== D, `the delete named ${String(gone)}`).toBe(true);
  }, 30_000);
});

describe("CONTROLS — nothing here is called sent elsewhere", () => {
  it("editing offline: the save waits on the outbox, the ordinary sentence stands, nothing is called sent", async () => {
    shell = await mountShell("#/drafts", [], [letter()]);
    await waitFor(() => q(`.draft-row[data-id="${D}"] .draft-open`) !== null, "the letter in Drafts");
    await press(q(`.draft-row[data-id="${D}"] .draft-open`), "open the letter");
    await waitFor(() => q<HTMLInputElement>("#compose-subject")?.value === "Plans for Friday", "the editor on the letter");
    shell.offline.on = true;
    await typeSubject("Plans for Friday, written offline");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await act(async () => { await shell.engine.syncOnce().catch(() => undefined); });
    await waitFor(() => shell.engine.pendingMutations().length > 0, "the save on the outbox");
    expect({ note: text().includes(compose.draftNote!), elsewhere: text().includes(compose.sentElsewhere!) })
      .toEqual({ note: true, elsewhere: false });
  }, 30_000);

  it("an ordinary open letter autosaves to its own row and says the ordinary sentence", async () => {
    shell = await mountShell("#/drafts", [], [letter()]);
    await waitFor(() => q(`.draft-row[data-id="${D}"] .draft-open`) !== null, "the letter in Drafts");
    await press(q(`.draft-row[data-id="${D}"] .draft-open`), "open the letter");
    await waitFor(() => q<HTMLInputElement>("#compose-subject")?.value === "Plans for Friday", "the editor on the letter");
    await act(async () => { await shell.engine.syncOnce().catch(() => undefined); });
    await typeSubject("Plans for Friday, edited");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => saves().length > 0, "the save");
    expect((saves() as Array<{ draftId?: string }>).map((m) => m.draftId)).toEqual([D]);
    expect({ note: text().includes(compose.draftNote!), elsewhere: text().includes(compose.sentElsewhere ?? "\u0000") })
      .toEqual({ note: true, elsewhere: false });
  }, 30_000);

  it("this tab's own send is not 'sent from another device'", async () => {
    shell = await mountShell("#/drafts", [], [letter()]);
    await waitFor(() => q(`.draft-row[data-id="${D}"] .draft-open`) !== null, "the letter in Drafts");
    await press(q(`.draft-row[data-id="${D}"] .draft-open`), "open the letter");
    await waitFor(() => q<HTMLInputElement>("#compose-subject")?.value === "Plans for Friday", "the editor on the letter");
    await press(button("Send"), "Send");
    await waitFor(() => sends().length === 1, "the send");
    await pause(300);
    expect((sends()[0] as { draftId?: string }).draftId).toBe(D);
    expect(text().includes(compose.sentElsewhere ?? "\u0000"), "our own send was called another device's").toBe(false);
  }, 30_000);

  it("this tab's own send, the server's sent row arriving on /sync before the send's answer", async () => {
    shell = await mountShell("#/drafts", [], [letter()]);
    await waitFor(() => q(`.draft-row[data-id="${D}"] .draft-open`) !== null, "the letter in Drafts");
    await press(q(`.draft-row[data-id="${D}"] .draft-open`), "open the letter");
    await waitFor(() => q<HTMLInputElement>("#compose-subject")?.value === "Plans for Friday", "the editor on the letter");
    let answer: () => void = () => {};
    shell.sendGate.wait = new Promise<void>((r) => { answer = r; });
    await press(button("Send"), "Send");
    await waitFor(() => sends().length === 1, "the send on the wire");
    shell.remote.push(sentElsewhere());
    await act(async () => { await shell.engine.syncOnce().catch(() => undefined); });
    await pause(300);
    expect(text().includes(compose.sentElsewhere!), "this tab's own send, still on the wire, was called another device's").toBe(false);
    shell.sendGate.wait = null;
    await act(async () => { answer(); });
    await pause(300);
    expect(text().includes(compose.sentElsewhere!)).toBe(false);
  }, 30_000);

  it("Discard of a live draft still deletes it, and says so", async () => {
    shell = await mountShell("#/drafts", [], [letter()]);
    await waitFor(() => q(`.draft-row[data-id="${D}"] .draft-open`) !== null, "the letter in Drafts");
    await press(q(`.draft-row[data-id="${D}"] .draft-open`), "open the letter");
    await waitFor(() => q<HTMLInputElement>("#compose-subject")?.value === "Plans for Friday", "the editor on the letter");
    await press(q<HTMLButtonElement>(".compose-cancel"), "Cancel");
    expect(q<HTMLElement>("#compose-cancel-what")?.textContent).toBe(compose.cancelWhat);
    const confirm = Array.from(shell.el.querySelectorAll<HTMLButtonElement>(".compose-confirm button"))
      .find((b) => (b.textContent ?? "").trim() === compose.cancelConfirm) ?? null;
    await press(confirm, "Discard message");
    await waitFor(() => shell.sent.some((m) => m.kind === "draft_discard"), "the delete");
    expect(shell.sent.filter((m) => m.kind === "draft_discard").map((m) => (m as { draftId?: string }).draftId)).toEqual([D]);
  }, 30_000);
});
