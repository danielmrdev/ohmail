/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import {
  COMPOSER_KEY, EMPTY_COMPOSE, clearComposeDraft, composeDraftKey, composeRowKey, composeSessionId,
  composeSessionKey, composeStillHolds, handOffComposer, readComposeDraft, readComposeRow,
  resetComposerForTest, setComposerScope, writeComposeDraft, writeComposeRow,
} from "../app/shell/compose";

/**
 * CROSS-TAB-COMPOSE-IDENTITY-CLEARED-BY-ANOTHER-TAB. The scratch buffer, the compose session and
 * the draft row were keyed per ACCOUNT, so every tab on the origin held one message-in-progress
 * and a tab settling its own cleared the one another tab was writing. They are keyed per composer
 * now. Two tabs share `localStorage` and keep their own `sessionStorage`; a case switches tabs by
 * giving the page a composer id, exactly the state a second tab starts in.
 */
const tab = (id: string): void => {
  resetComposerForTest();
  window.sessionStorage.setItem(COMPOSER_KEY, id);
};
const slotKeys = ["ohmail.ui.compose.local", "ohmail.compose.session.local", "ohmail.compose.row.local"];
const message = (subject: string) => ({ ...EMPTY_COMPOSE, to: "ana@example.com", subject, body: `${subject} body` });

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetComposerForTest();
});

describe("each tab's composer owns its own message-in-progress", () => {
  it("CONTROL: two tabs build different keys for all three halves", () => {
    tab("tab-a");
    const a = [composeDraftKey(), composeSessionKey(), composeRowKey()];
    tab("tab-b");
    const b = [composeDraftKey(), composeSessionKey(), composeRowKey()];
    a.forEach((k, i) => expect(k).not.toBe(b[i]));
  });

  it("one tab clearing its message leaves the other tab's text, session and row standing", () => {
    tab("tab-a");
    writeComposeDraft(message("from A"));
    const sessionA = composeSessionId();
    writeComposeRow("row-a");
    tab("tab-b");
    writeComposeDraft(message("from B"));
    const sessionB = composeSessionId();
    writeComposeRow("row-b");
    expect(sessionB).not.toBe(sessionA);

    tab("tab-a");
    clearComposeDraft();
    expect(readComposeDraft()).toEqual(EMPTY_COMPOSE);

    tab("tab-b");
    expect(readComposeDraft().subject).toBe("from B");
    expect(composeSessionId(), "B's session survived A's clear").toBe(sessionB);
    expect(readComposeRow(), "B's row survived A's clear").toBe("row-b");
    expect(composeStillHolds({ draftId: "row-b", session: sessionB })).toBe(true);
    expect(composeStillHolds({ draftId: null, session: sessionB })).toBe(true);
  });

  it("a tab that closes hands its message to the next composer, as one unit", () => {
    tab("tab-a");
    writeComposeDraft(message("unsent"));
    const session = composeSessionId();
    writeComposeRow("row-a");
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
    expect(window.localStorage.getItem(composeDraftKey()), "nothing left under the closed tab").toBeNull();

    tab("tab-c");
    expect(readComposeDraft().subject).toBe("unsent");
    expect(composeSessionId()).toBe(session);
    expect(readComposeRow()).toBe("row-a");
    for (const k of slotKeys) expect(window.localStorage.getItem(k), `${k} still waiting`).toBeNull();
  });

  it("a page kept for back/forward keeps its message where it is", () => {
    tab("tab-a");
    writeComposeDraft(message("kept"));
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    expect(readComposeDraft().subject).toBe("kept");
    for (const k of slotKeys) expect(window.localStorage.getItem(k)).toBeNull();
  });

  it("a composer already holding a message leaves a handed-off one for the next", () => {
    tab("tab-b");
    writeComposeDraft(message("B's own"));
    tab("tab-a");
    writeComposeDraft(message("A's"));
    composeSessionId();
    handOffComposer();
    tab("tab-b");
    expect(readComposeDraft().subject).toBe("B's own");
    expect(window.localStorage.getItem("ohmail.ui.compose.local"), "A's message still waits").not.toBeNull();
  });

  it("a handoff replaces the slot whole: no stale row beside the new text", () => {
    window.localStorage.setItem("ohmail.ui.compose.local", JSON.stringify(message("older")));
    window.localStorage.setItem("ohmail.compose.session.local", "older-session");
    window.localStorage.setItem("ohmail.compose.row.local", "older-row");
    tab("tab-b");
    writeComposeRow(null);
    writeComposeDraft(message("newer"));
    // B read nothing yet, so it adopted nothing; its own unit is text and a session, no row.
    const sessionB = window.localStorage.getItem(composeSessionKey()) ?? composeSessionId();
    handOffComposer();
    expect(window.localStorage.getItem("ohmail.compose.row.local"), "the older row went with the older text").toBeNull();
    expect(window.localStorage.getItem("ohmail.compose.session.local")).toBe(sessionB);
  });

  it("a window the host names keeps its message across a restart that fired no pagehide", () => {
    setComposerScope("window");
    writeComposeDraft(message("before the quit"));
    const session = composeSessionId();
    // A restart: a fresh page, sessionStorage gone, nothing handed off.
    resetComposerForTest();
    window.sessionStorage.clear();
    setComposerScope("window");
    expect(readComposeDraft().subject).toBe("before the quit");
    expect(composeSessionId()).toBe(session);
    for (const k of slotKeys) expect(window.localStorage.getItem(k)).toBeNull();
  });

  it("a browser upgraded mid-message keeps it: the per-account keys are adopted by the first composer", () => {
    window.localStorage.setItem("ohmail.ui.compose.local", JSON.stringify(message("before the upgrade")));
    window.localStorage.setItem("ohmail.compose.session.local", "session-before");
    window.localStorage.setItem("ohmail.compose.row.local", "row-before");
    tab("tab-a");
    expect(readComposeDraft().subject).toBe("before the upgrade");
    expect(composeSessionId()).toBe("session-before");
    expect(readComposeRow()).toBe("row-before");
  });
});
