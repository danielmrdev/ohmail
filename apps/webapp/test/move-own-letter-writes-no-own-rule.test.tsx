/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISO, act, answerSyncWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell.js";

/**
 * A MOVE ON OUR OWN LETTER WRITES NO RULE ABOUT OUR OWN ADDRESS, through the shipped
 * shell. The Move strip's press retargeted the rule standing for our own address (one made before
 * the create door refused them) and said "Future mail from them files there too"; on a conversation
 * whose newest letter was ours it took our Sent copy out of Sent and left the reply where it was.
 * Now a conversation's press moves its received letters under their sender's rule and leaves our
 * Sent copies in Sent; a sent letter moved on its own moves with no rule and the plain sentence.
 * A friend's letter is the control: it still teaches its rule and says so.
 */
const ME = "walker@example.invalid";
const FRIEND = "friend@example.invalid";
const OTHER = "other@example.invalid";
let seq = 0;

const create = (type: string, id: string, entity: Record<string, unknown>) => ({
  type, op: "create", id, seq: ++seq, updatedAt: ISO, entity,
});
const at = (min: number): string => new Date(Date.parse(ISO) - min * 60_000).toISOString();
const message = (id: string, o: { from: string; to: string; folder: string; threadId?: string; ago: number; subject: string }) =>
  create("message", id, {
    id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: o.threadId ?? null, messageIdHeader: null, subject: o.subject,
    from: { name: null, address: o.from }, to: [{ name: null, address: o.to }], cc: [],
    date: at(o.ago), arrivedAt: at(o.ago), sortAt: at(o.ago), folder: o.folder, snippet: o.subject, unread: false,
    hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
  });
const rule = (id: string, match: string) => create("rule", id, {
  id, kind: "sender", match, destination: "INBOX", priority: 0, provenance: "manual",
  enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
});

function syncPage(): Response {
  const creates = [
    // The rule about our own address, as one made before the create door refused it stands.
    rule("rule_me", ME),
    rule("rule_friend", FRIEND),
    message("c_mine", { from: ME, to: FRIEND, folder: "Sent", threadId: "t1", ago: 300, subject: "Plans" }),
    message("c_reply", { from: FRIEND, to: ME, folder: "INBOX", threadId: "t1", ago: 200, subject: "Re: Plans" }),
    message("c_fwd", { from: ME, to: FRIEND, folder: "Sent", threadId: "t1", ago: 100, subject: "Fwd: Plans" }),
    message("solo", { from: ME, to: FRIEND, folder: "Sent", ago: 50, subject: "Just me" }),
    message("fr", { from: FRIEND, to: ME, folder: "INBOX", ago: 40, subject: "Lunch" }),
    // A conversation two people answered, our letter newest.
    rule("rule_other", OTHER),
    message("g_a", { from: FRIEND, to: ME, folder: "INBOX", threadId: "t2", ago: 30, subject: "Trip" }),
    message("g_b", { from: OTHER, to: ME, folder: "INBOX", threadId: "t2", ago: 20, subject: "Re: Trip" }),
    message("g_mine", { from: ME, to: FRIEND, folder: "Sent", threadId: "t2", ago: 10, subject: "Re: Trip" }),
    // A letter from our own address still held at the gate (one that failed its sender check).
    message("held_me", { from: ME, to: ME, folder: "ohmail/Screener", ago: 5, subject: "Held note" }),
  ];
  return new Response(JSON.stringify({
    changes: { creates, updates: [], moves: [], deletes: [] }, cursor: `c${seq}`, hasMore: false, serverTime: ISO,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await tick(50); };
const click = async (el: Element): Promise<void> => {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await settle();
};
const row = (host: HTMLElement, id: string): HTMLElement => {
  const r = host.querySelector<HTMLElement>(`.row[data-id="${id}"]`);
  if (!r) throw new Error(`no row ${id}`);
  return r;
};
const toasts = (): string[] =>
  [...document.querySelectorAll("[class*=toast]")].map((n) => (n.textContent ?? "").trim()).filter(Boolean);

/** Every write the shell sent, as `METHOD path body`. */
function writes(): string[] {
  const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[unknown, RequestInit | undefined]>;
  return calls.flatMap(([input, init]) => {
    const r = input instanceof Request ? input : null;
    const method = (init?.method ?? r?.method ?? "GET").toUpperCase();
    if (method === "GET") return [];
    const url = new URL(String(r?.url ?? input), "https://h.invalid");
    return [`${method} ${url.pathname} ${typeof init?.body === "string" ? init.body : ""}`];
  });
}

/** Open the row, press Move, press the place; then let the undo window close so held rules go. */
async function moveTo(host: HTMLElement, id: string, place: string): Promise<void> {
  await click(row(host, id));
  await click(host.querySelector(".abar-move")!);
  const target = [...host.querySelectorAll<HTMLButtonElement>(".abar-panel button")]
    .find((b) => (b.textContent ?? "").includes(`→ ${place}`));
  if (!target) throw new Error(`no move target ${place}`);
  await click(target);
}
const windowCloses = async (): Promise<void> => { for (let i = 0; i < 30; i++) await tick(1000); };

beforeEach(() => {
  installShellEnv();
  seq = 0;
  answerSyncWith(syncPage);
  window.location.hash = "#/ohbox";
});
afterEach(async () => { await teardownShellEnv(); });

const MOUNT = () => mountShell([mailbox({ id: "mb_1", address: ME, lastSyncAt: ISO } as never)]);
const named = (w: string[], needle: string): string[] => w.filter((x) => x.includes(needle));

describe("Move on our own letter", () => {
  it("a conversation whose newest letter is ours moves the reply and leaves our Sent copies in Sent", async () => {
    const host = await MOUNT();
    await settle();
    await moveTo(host, "c_fwd", "News");
    const said = toasts().join(" | ");
    await windowCloses();
    const w = writes();
    expect.soft(named(w, "rule_me"), "a rule about our own address was written").toEqual([]);
    expect.soft(named(w, "/messages/c_fwd/").concat(named(w, "/messages/c_mine/")), "our Sent copy left Sent").toEqual([]);
    expect.soft(named(w, "/messages/c_reply/move"), "the reply did not move").toEqual([`POST /api/messages/c_reply/move {"folder":"ohmail/News"}`]);
    expect.soft(named(w, "rule_friend"), "the correspondent's rule").toEqual([`PATCH /api/rules/rule_friend {"destination":"ohmail/News","applyRetro":false}`]);
    expect.soft(said).not.toContain(ME);
    expect(said).toContain(FRIEND);
  });

  it("a conversation two people answered moves both replies, each under its sender's rule", async () => {
    const host = await MOUNT();
    await settle();
    await moveTo(host, "g_mine", "News");
    const said = toasts().join(" | ");
    await windowCloses();
    const w = writes();
    expect.soft(named(w, "rule_me"), "a rule about our own address was written").toEqual([]);
    expect.soft(named(w, "/messages/g_mine/"), "our Sent copy left Sent").toEqual([]);
    expect.soft(w.filter((x) => x.includes("/move")).sort()).toEqual([
      `POST /api/messages/g_a/move {"folder":"ohmail/News"}`,
      `POST /api/messages/g_b/move {"folder":"ohmail/News"}`,
    ]);
    expect.soft(w.filter((x) => x.includes("/rules/")).sort()).toEqual([
      `PATCH /api/rules/rule_friend {"destination":"ohmail/News","applyRetro":false}`,
      `PATCH /api/rules/rule_other {"destination":"ohmail/News","applyRetro":false}`,
    ]);
    expect(said).not.toContain(ME);
  });

  it("a picked conversation whose newest letter is ours moves the reply, never our Sent copies", async () => {
    const host = await MOUNT();
    await settle();
    await act(async () => {
      row(host, "c_fwd").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    });
    await settle();
    await click(host.querySelector(".abar-move")!);
    const target = [...host.querySelectorAll<HTMLButtonElement>(".abar-panel button")].find((b) => (b.textContent ?? "").includes("→ News"));
    await click(target!);
    await windowCloses();
    const w = writes();
    expect(w).toEqual([
      `POST /api/messages/c_reply/move {"folder":"ohmail/News"}`,
      `PATCH /api/rules/rule_friend {"destination":"ohmail/News","applyRetro":false}`,
    ]);
  });

  it("a sent letter moved on its own moves, with no rule and the plain sentence", async () => {
    const host = await MOUNT();
    await settle();
    await moveTo(host, "solo", "Receipts");
    const said = toasts().join(" | ");
    await windowCloses();
    const w = writes();
    expect.soft(named(w, "/rules"), "a press on our own letter wrote a rule").toEqual([]);
    expect.soft(w).toEqual([`POST /api/messages/solo/move {"folder":"ohmail/Receipts"}`]);
    expect.soft(said).not.toContain("files there too");
    expect(said).toContain("No rule was made");
  });

  it("a letter from our own address held at the gate moves, with no decision and no rule", async () => {
    const host = await MOUNT();
    await settle();
    await moveTo(host, "held_me", "News");
    const said = toasts().join(" | ");
    await windowCloses();
    const w = writes();
    expect.soft(w).toEqual([`POST /api/messages/held_me/move {"folder":"ohmail/News"}`]);
    expect(said).toContain("No rule was made");
  });

  it("a friend's letter still teaches its rule and says so (the positive control)", async () => {
    const host = await MOUNT();
    await settle();
    await moveTo(host, "fr", "News");
    const said = toasts().join(" | ");
    await windowCloses();
    const w = writes();
    expect.soft(w).toEqual([
      `POST /api/messages/fr/move {"folder":"ohmail/News"}`,
      `PATCH /api/rules/rule_friend {"destination":"ohmail/News","applyRetro":false}`,
    ]);
    expect(said).toContain("Future mail from them files there too");
  });
});
