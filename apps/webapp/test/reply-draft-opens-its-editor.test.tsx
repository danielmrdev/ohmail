/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { message, mountShell, press, replyDraft, replySurface, stubDom, unmountAll, waitFor } from "./_draft-shell.js";

/**
 * A REPLY DRAFT PRESSED IN DRAFTS OPENS ITS CONVERSATION WITH THE DRAFT IN THE EDITOR. The press
 * set the editor and navigated in one gesture, and the route transition — which closes every
 * overlay, the inline reply included — closed it again: the conversation came up with no editor,
 * and the draft could not be finished from there.
 * Mutation: the transition's pending reply not honoured → red on the missing editor.
 */

beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
});
afterEach(unmountAll);

const DRAFT_TEXT = "Thursday works, I will bring the samples";

describe("a reply draft opens where it can be finished", () => {
  it("pressing it in Drafts opens the conversation with the draft in the reply editor", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [replyDraft("d1", "m1", DRAFT_TEXT)]);
    await waitFor(() => s.el.querySelector(".draft-row[data-id='d1'] .draft-open") != null, "the draft row");

    await press(s.el.querySelector(".draft-row[data-id='d1'] .draft-open"), "the draft's open button");

    await waitFor(() => window.location.hash.startsWith("#/ohbox"), "the conversation's view");
    await waitFor(() => replySurface(s.el) != null, "the reply editor, open on the conversation");
    expect(replySurface(s.el)!.textContent).toContain(DRAFT_TEXT);
    // …and focused, so typing goes on where the draft stopped.
    await waitFor(() => replySurface(s.el)!.contains(document.activeElement), "focus in the reply editor");
    // Nothing was sent or saved by opening it.
    expect(s.sent.filter((m) => m.kind === "mail_send" || m.kind === "draft_save")).toEqual([]);
  }, 15_000);

  it("a draft that is not a reply still opens in Compose (the control)", async () => {
    const plain = { ...replyDraft("d2", "m1", "a new message"), inReplyToMessageId: null, subject: "Plain" };
    const s = await mountShell("#/drafts", [message("m1")], [plain]);
    await waitFor(() => s.el.querySelector(".draft-row[data-id='d2'] .draft-open") != null, "the draft row");

    await press(s.el.querySelector(".draft-row[data-id='d2'] .draft-open"), "the draft's open button");

    await waitFor(() => window.location.hash === "#/compose", "the composer");
    expect(replySurface(s.el)).toBeNull();
  }, 15_000);
});
