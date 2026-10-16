/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISO, act, answerConsentWith, answerSyncWith, installShellEnv, mailbox, mountShell,
  teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";

/**
 * FIX-025 (SCREENER-PREVIEW-SHOWS-NO-FILES, STREAM-CARDS-SHOW-NO-FILES): the Screener's preview
 * of held mail and an expanded News or Receipts card drew the body and no file strip, whatever
 * the body's type. The shipped shell over the live engine; every list is a real
 * `GET /messages/:id/attachments`, so a strip here is the one `MessageFiles` holder asking.
 */

type Wire = Record<string, unknown>;
const file = (messageId: string, id: string, filename: string, contentType: string, sizeBytes: number): Wire =>
  ({ id, filename, contentType, sizeBytes, inline: false, contentId: null, messageId });
const FILES: Record<string, Wire[]> = {
  s1: [file("s1", "a-s1", "notes.txt", "text/plain", 39)],
  s2: [file("s2", "a-s2", "brochure.pdf", "application/pdf", 2400)],
  n1: [file("n1", "a-n1", "agenda.txt", "text/plain", 120)],
  n2: [file("n2", "a-n2", "poster.png", "image/png", 1485)],
  n3: [file("n3", "a-n3", "unread.txt", "text/plain", 64)],
  r1: [file("r1", "a-r1", "invoice.pdf", "application/pdf", 2000)],
  r2: [file("r2", "a-r2", "receipt.txt", "text/plain", 300)],
};
const HTML: Record<string, string> = {
  s2: "<html><body><p>Our brochure is attached.</p></body></html>",
  n2: "<html><body><p>This week's poster.</p></body></html>",
  r1: "<html><body><table><tr><td>Total CHF 42.00</td></tr></table></body></html>",
};

let listed: string[] = [];
let fetched: string[] = [];

const message = (id: string, n: number, over: Record<string, unknown>) => ({
  type: "message", op: "create", id, seq: n, updatedAt: ISO,
  entity: {
    id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: `th-${id}`, messageIdHeader: null,
    subject: `subject of ${id}`, from: { name: `Sender ${id}`, address: `${id}@example.invalid` },
    to: [], cc: [], date: ISO, folder: "INBOX", snippet: "Here is the file.",
    unread: false, hasAttachments: true, attachmentCount: 1,
    sensitivity: {}, triage: null, labels: [], remoteContent: "none", updatedAt: ISO, ...over,
  },
});
const rule = (address: string, destination: string, n: number) => ({
  type: "rule", op: "create", id: `rule_${address}`, seq: n, updatedAt: ISO,
  entity: {
    id: `rule_${address}`, kind: "sender", match: address, destination, priority: 0,
    provenance: "seeded-from-sent", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: ISO, updatedAt: ISO,
  },
});

const STRANGER = { name: "A Stranger", address: "stranger@example.invalid" };
const world = (): Response => new Response(JSON.stringify({
  changes: {
    creates: [
      // Held at the gate: one sender, a plain-text and an html message, each with a file.
      message("s1", 1, { folder: "ohmail/Screener", from: STRANGER, date: "2026-08-04T07:00:00.000Z" }),
      message("s2", 2, { folder: "ohmail/Screener", from: STRANGER }),
      message("n1", 3, { folder: "ohmail/News" }), rule("n1@example.invalid", "ohmail/News", 4),
      message("n2", 5, { folder: "ohmail/News", date: "2026-08-04T08:00:00.000Z" }), rule("n2@example.invalid", "ohmail/News", 6),
      message("n3", 7, { folder: "ohmail/News", date: "2026-08-04T06:00:00.000Z" }), rule("n3@example.invalid", "ohmail/News", 8),
      message("r1", 9, { folder: "ohmail/Receipts" }), rule("r1@example.invalid", "ohmail/Receipts", 10),
      message("r2", 11, { folder: "ohmail/Receipts", date: "2026-08-04T08:00:00.000Z" }), rule("r2@example.invalid", "ohmail/Receipts", 12),
    ],
    updates: [], moves: [], deletes: [],
  },
  cursor: "c12", hasMore: false, serverTime: ISO,
}), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  answerConsentWith({ foldersEnabledAt: ISO });
  answerSyncWith(world);
  listed = [];
  fetched = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const inner = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
    const url = String(input);
    const list = /\/messages\/([^/?]+)\/attachments(?:$|\?)/.exec(url);
    if (list) {
      const id = decodeURIComponent(list[1]!);
      listed.push(id);
      return json({ items: FILES[id] ?? [] });
    }
    const body = /\/messages\/([^/?]+)\/body/.exec(url);
    if (body && FILES[decodeURIComponent(body[1]!)]) {
      const id = decodeURIComponent(body[1]!);
      return json({ text: "Here is the file.", html: HTML[id] ?? null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null });
    }
    if (url.includes("/messages/bodies")) {
      const ids = [...new URL(url, "https://harness.invalid").searchParams.getAll("ids")].flatMap((s) => s.split(","));
      return json({ items: ids.filter((id) => FILES[id]).map((id) => ({ id, text: "Here is the file.", html: HTML[id] ?? null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null })) });
    }
    const bytes = /\/attachments\/([^/?]+)$/.exec(url);
    if (bytes) {
      fetched.push(decodeURIComponent(bytes[1]!));
      return new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    return (inner as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
  }) as unknown as typeof globalThis.fetch;
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:harness/1";
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
});
afterEach(async () => { await teardownShellEnv(); });

const goHash = async (hash: string): Promise<void> => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
    await Promise.resolve();
  });
  await tick(0);
  await tick(500);
};
const key = async (k: string): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
  await tick(500);
};
const scopeOf = (sel: string): Element => {
  const el = document.querySelector(sel);
  expect(el, `${sel} is not on screen`).not.toBeNull();
  return el!;
};
const tilesIn = (scope: Element): string[] =>
  [...scope.querySelectorAll(".att-strip .att-name")].map((n) =>
    `${n.querySelector(".att-stem")?.textContent ?? ""}${n.querySelector(".att-ext")?.textContent ?? ""}`);

async function open(): Promise<void> {
  await mountShell([mailbox()]);
  await tick(30_000);
}

/** A tile a person can use: its name, its size, a look where the type draws, a save that fetches. */
async function expectUsableTile(scope: Element, filename: string, attachmentId: string): Promise<void> {
  const tile = [...scope.querySelectorAll<HTMLElement>(".att-item")]
    .find((t) => (t.textContent ?? "").includes(filename.replace(/\.[^.]+$/, "")));
  expect(tile, `no tile for ${filename}`).toBeTruthy();
  expect(tile!.querySelector(".att-state")?.textContent ?? "", `${filename} states no size`).toMatch(/\d/);
  expect(tile!.querySelector("button.att-tile"), `${filename} offers no open`).toBeTruthy();
  const save = tile!.querySelector<HTMLButtonElement>("button.att-side") ?? tile!.querySelector<HTMLButtonElement>("button.att-tile");
  await act(async () => { save!.click(); });
  await tick(500);
  expect(fetched, `pressing ${filename}'s save fetched nothing`).toContain(attachmentId);
}

/** The stream card for one message. */
const cardOf = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`.scast[data-sid="${id}"]`);
  expect(el, `no card for ${id}`).not.toBeNull();
  return el!;
};
async function expand(id: string): Promise<HTMLElement> {
  const pill = cardOf(id).querySelector<HTMLButtonElement>("button.sc-x");
  expect(pill, `${id} has no expand pill`).toBeTruthy();
  await act(async () => { pill!.click(); });
  await tick(500);
  return cardOf(id);
}

describe("the Screener's preview of held mail lists each message's files", () => {
  it("a plain-text and an html held message each show their file, with a size, an open and a save", async () => {
    await open();
    await goHash("#/screener");
    await key("j");
    const held = [...document.querySelectorAll(".hmail")];
    expect(held.length, "the premise: the stranger's two held messages are previewed").toBe(2);
    expect(held.map(tilesIn), "a held message shows no file").toEqual([["notes.txt"], ["brochure.pdf"]]);
    expect([...listed].sort(), "each held message's list is asked once").toEqual(["s1", "s2"]);
    await expectUsableTile(held[0]!, "notes.txt", "a-s1");
    await expectUsableTile(held[1]!, "brochure.pdf", "a-s2");
  }, 30_000);
});

describe("an expanded News or Receipts card lists its message's files", () => {
  const CASES: Array<{ view: string; id: string; name: string; att: string; shape: string }> = [
    { view: "reads", id: "n1", name: "agenda.txt", att: "a-n1", shape: "plain text" },
    { view: "reads", id: "n2", name: "poster.png", att: "a-n2", shape: "html" },
    { view: "receipts", id: "r1", name: "invoice.pdf", att: "a-r1", shape: "html receipt" },
    { view: "receipts", id: "r2", name: "receipt.txt", att: "a-r2", shape: "plain text" },
  ];
  for (const c of CASES) {
    it(`${c.view}: ${c.id} (${c.shape}) shows ${c.name} once expanded`, async () => {
      await open();
      await goHash(`#/${c.view}`);
      expect(tilesIn(cardOf(c.id)), "a collapsed card drew a strip").toEqual([]);
      const card = await expand(c.id);
      expect(tilesIn(card), `the expanded ${c.id} card shows no file`).toEqual([c.name]);
      expect(listed.filter((id) => id === c.id), "the list was asked more or less than once").toHaveLength(1);
      await expectUsableTile(card, c.name, c.att);
    }, 30_000);
  }

  it("a collapsed card asks for nothing, on mount or on scroll; collapsing lets the list go", async () => {
    await open();
    await goHash("#/reads");
    expect(document.querySelectorAll(".scast").length, "the premise: the News cards are mounted").toBeGreaterThanOrEqual(3);
    const stream = document.querySelector(".view-reads") ?? document.body;
    for (let i = 0; i < 5; i += 1) {
      await act(async () => { stream.dispatchEvent(new Event("scroll", { bubbles: true })); window.dispatchEvent(new Event("scroll")); });
      await tick(200);
    }
    expect(listed, "a card nobody expanded asked for its list").toEqual([]);
    await expand("n1");
    expect(listed, "expanding one card asked for another's list").toEqual(["n1"]);
    expect(tilesIn(cardOf("n3")), "a collapsed card drew a strip").toEqual([]);
    await expand("n1");
    expect(tilesIn(cardOf("n1")), "a collapsed card kept its strip").toEqual([]);
    // Let go, not merely undrawn: opening it again asks again.
    await expand("n1");
    expect(tilesIn(cardOf("n1"))).toEqual(["agenda.txt"]);
    expect(listed, "the collapse did not let the list go").toEqual(["n1", "n1"]);
  }, 30_000);
});
