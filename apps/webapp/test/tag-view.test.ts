/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ISO, act, answerSyncWith, goTo, installShellEnv, mailbox, mountShell, teardownShellEnv,
  textOf, tick,
} from "./fixtures/live-walk-shell";

/**
 * TAG — one tag, across everything, read WITHOUT leaving it, and managed from its own page.
 *
 * What only the rendered tag page can be wrong about:
 *
 *   1. a row reads IN PLACE — the route stays on the tag, it does not jump to the message's
 *      home view (the aliasing that was objected to);
 *   2. the page IS the two-pane layout — no mode to pick — and a row reads in the column
 *      rather than in a sheet;
 *   3. Rename and Delete are present, and Delete STATES THE COUNT and that the mail stays put
 *      BEFORE it asks — the two-step the Settings pane and the rules pane also hold.
 *
 * The WIRE for `tag_rename`/`tag_delete` is proven in `packages/client-engine`; this is about
 * the surface. The fixture tags two ordinary Ohbox messages, so the OLD `openMessage` row would
 * have navigated to the Ohbox — which is exactly what assertion 1 watches for.
 */

const message = (o: { id: string; from: string; labels?: string[]; subject?: string }, seq: number) => ({
  type: "message", op: "create", id: o.id, seq, updatedAt: ISO,
  entity: {
    id: o.id, accountId: "acct_live_1", mailboxId: "mb_1",
    threadId: null, messageIdHeader: null,
    subject: o.subject ?? `subject of ${o.id}`,
    from: { name: `Sender ${o.id}`, address: o.from },
    to: [], cc: [], date: ISO, folder: "INBOX",
    snippet: `snippet of ${o.id}`, unread: false,
    hasAttachments: false, attachmentCount: 0, sensitivity: {},
    triage: null, labels: o.labels ?? [], remoteContent: "none", updatedAt: ISO,
  },
});

const rule = (address: string, seq: number) => ({
  type: "rule", op: "create", id: `rule_${address}`, seq, updatedAt: ISO,
  entity: {
    id: `rule_${address}`, kind: "sender", match: address, destination: "INBOX", priority: 0,
    provenance: "seeded-from-sent", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
  },
});

const tag = (id: string, name: string, seq: number) => ({
  type: "tag", op: "create", id, seq, updatedAt: ISO,
  entity: { id, name, hue: "moss", createdAt: ISO, updatedAt: ISO },
});

const world = (): Response =>
  new Response(
    JSON.stringify({
      changes: {
        creates: [
          tag("tg1", "Invoices", 1),
          // Consented sender ⇒ these present in the Ohbox. Their home view is NOT the tag, which
          // is what makes "the route stays on the tag" a real assertion.
          rule("friend@example.invalid", 2),
          message({ id: "tg-a", from: "friend@example.invalid", labels: ["tg1"] }, 3),
          message({ id: "tg-b", from: "friend@example.invalid", labels: ["tg1"] }, 4),
          // An untagged sibling, to prove the list is the tag's and not the whole Ohbox.
          message({ id: "plain", from: "friend@example.invalid" }, 5),
        ],
        updates: [], moves: [], deletes: [],
      },
      cursor: "c1", hasMore: false, serverTime: ISO,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const rowIds = (c: HTMLElement): string[] =>
  [...c.querySelectorAll(".row[data-id]")].map((n) => n.getAttribute("data-id") ?? "");

const clickText = async (c: HTMLElement, label: string): Promise<void> => {
  const btn = [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!btn) throw new Error(`no button "${label}" — have: ${[...c.querySelectorAll("button")].map((b) => b.textContent?.trim()).join(" | ")}`);
  await act(async () => { btn.click(); await Promise.resolve(); });
  await tick(0);
};

describe("Tag view", () => {
  beforeEach(() => {
    installShellEnv();
    answerSyncWith(world);
  });
  afterEach(teardownShellEnv);

  it("lists only the tagged mail, under the tag's name", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("tag/tg1");

    const ids = rowIds(c);
    expect(ids).toContain("tg-a");
    expect(ids).toContain("tg-b");
    expect(ids).not.toContain("plain");
    expect(textOf(c)).toContain("Invoices");
  });

  it("reads a row IN PLACE — the route stays on the tag, it does not jump to the Ohbox", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("tag/tg1");

    const row = c.querySelector('.row[data-id="tg-a"]') as HTMLElement | null;
    await act(async () => { row!.click(); await Promise.resolve(); });
    await tick(0);

    // `openMessage` would have set the hash to `#/ohbox`. The reader-in-place keeps the tag up,
    // and the address names the letter on the tag's route.
    expect(window.location.hash).toBe("#/tag/tg1/m/tg-a");
    expect(textOf(c)).toContain("subject of tg-a");
  });

  it("is the two-pane layout on arrival, with no mode to pick, and a row reads in the column", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("tag/tg1");

    const view = c.querySelector(".view-tag")!;
    // Mutation watched: restore `layout === "split" ? … : "view center"` and this goes red.
    expect(view.classList.contains("split")).toBe(true);
    expect(view.classList.contains("center")).toBe(false);
    // The `List` / `Split` control is gone with the solo mode it selected — and its absence is
    // what makes that a deletion rather than a new default with the old path still reachable.
    const modes = [...c.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(modes, "the layout toggle is still on screen").not.toContain("Split");
    expect(modes, "the layout toggle is still on screen").not.toContain("List");

    const row = c.querySelector('.row[data-id="tg-b"]') as HTMLElement | null;
    await act(async () => { row!.click(); await Promise.resolve(); });
    await tick(0);

    expect(window.location.hash).toBe("#/tag/tg1/m/tg-b");
    expect(c.querySelector(".view-tag .read-col")!.textContent ?? "").toContain("subject of tg-b");
  });

  it("offers Rename and Delete, and Delete states the count and what survives BEFORE it asks", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("tag/tg1");

    const labels = [...c.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(labels).toContain("Rename");
    expect(labels).toContain("Delete");

    // The first Delete opens the confirm — it must NOT delete on the first press. The count is
    // the number of tagged messages, and the sentence about the mail is on screen before the ask.
    await clickText(c, "Delete");
    expect(window.location.hash, "still on the tag — the first press only asks").toBe("#/tag/tg1");
    expect(textOf(c)).toContain("Delete “Invoices”?");
    expect(textOf(c)).toContain("It's on 2 of your messages.");
    expect(textOf(c)).toContain("The messages stay where they are.");
  });

  it("Rename opens a field starting from the current name", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("tag/tg1");

    await clickText(c, "Rename");
    const input = c.querySelector<HTMLInputElement>(".tag-manage-input");
    expect(input, "renaming replaces the controls with a field").not.toBeNull();
    expect(input!.value).toBe("Invoices");
  });
});
