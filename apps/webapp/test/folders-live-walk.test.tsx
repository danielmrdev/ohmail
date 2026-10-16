/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ISO, act, answerConsentWith, answerSyncWith, installShellEnv, mailbox, mountShell,
  teardownShellEnv, textOf, tick,
} from "./fixtures/live-walk-shell";

/**
 * FOLDERS, WALKED THROUGH THE SHIPPED SHELL — the foundation stage end to end
 * (FOLDERS-SPEC.md; owner decisions 1, 3 and 7):
 *
 *  1. FLAG OFF IS TODAY, RENDERED: an account whose `/sync` already carries `folder` entities
 *     (a mirror that heard them before the flag went off) still shows the pre-feature rail —
 *     no Folders group, nothing to collapse. The flag is the authority; entities are data.
 *  2. FLAG ON: the rail grows the Folders group under Tags, with the folder and its unread
 *     count; pressing the row routes to `#/folder/<id>` and the view lists the folder's mail
 *     in the standard New / Earlier grouping, read in place.
 *  3. HISTORY IS A LENS: an old, read message from an unscreened sender that lives in a user
 *     folder appears in History wearing its folder as the place badge — and it is still in its
 *     folder's own list, because a lens never empties the place it looks at.
 */

const message = (
  o: {
    id: string; from: string; folder?: string; date?: string; unread?: boolean;
    subject?: string;
  },
  seq: number,
) => ({
  type: "message", op: "create", id: o.id, seq, updatedAt: o.date ?? ISO,
  entity: {
    id: o.id, accountId: "acct_live_1", mailboxId: "mb_1",
    threadId: null, messageIdHeader: null,
    subject: o.subject ?? `subject of ${o.id}`,
    from: { name: `Sender ${o.id}`, address: o.from },
    to: [], cc: [], date: o.date ?? ISO, folder: o.folder ?? "INBOX",
    snippet: `snippet of ${o.id}`, unread: o.unread ?? false,
    hasAttachments: false, attachmentCount: 0, sensitivity: {},
    triage: null, labels: [], remoteContent: "none", updatedAt: o.date ?? ISO,
  },
});

const folderEntity = (id: string, name: string, seq: number) => ({
  type: "folder", op: "create", id, seq, updatedAt: ISO,
  entity: { id, name, mailboxId: "mb_1", mailbox: "live@example.invalid", updatedAt: ISO },
});

/** Comfortably before the 60-day window measured from the fixture clock. */
const OLD = "2024-03-02T09:00:00.000Z";

const world = (): Response =>
  new Response(
    JSON.stringify({
      changes: {
        creates: [
          folderEntity("fd1", "Projects/Acme", 1),
          // Recent, unread, folder-filed: the rail badge's source.
          message({ id: "fm-new", from: "acme@example.invalid", folder: "Projects/Acme", unread: true }, 2),
          // Old + read + unscreened: the History lens row.
          message({ id: "fm-old", from: "acme@example.invalid", folder: "Projects/Acme", date: OLD }, 3),
          // An ordinary Ohbox arrival, so the shell has a pile to stand on.
          message({ id: "inbox-1", from: "acme@example.invalid" }, 4),
        ],
        updates: [], moves: [], deletes: [],
      },
      cursor: "c1", hasMore: false, serverTime: ISO,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
});
afterEach(async () => {
  await teardownShellEnv();
});

const goHash = async (hash: string): Promise<void> => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
    await Promise.resolve();
  });
  await tick(0);
};

describe("flag off — the pre-feature rail, rendered", () => {
  it("folder entities in the mirror grow NO rail group while the flag is off", async () => {
    answerSyncWith(world);
    const el = await mountShell([mailbox()]);
    await tick(30_000);
    // The group's toggle would say "Folders"; the rail must not carry it, nor any folder row.
    expect(el.querySelector(".frow")).toBeNull();
    const toggles = [...el.querySelectorAll(".rlabel-toggle")].map((n) => n.textContent?.trim());
    expect(toggles).not.toContain("Folders");
    // And the folder deep link falls back to the Ohbox rather than opening a hidden view.
    await goHash("#/folder/fd1");
    expect(el.querySelector(".view-folder")).toBeNull();
  });
});

describe("flag on — the rail group, the view, the lens", () => {
  beforeEach(() => {
    answerConsentWith({ foldersEnabledAt: ISO });
    answerSyncWith(world);
  });

  it("the rail grows Folders under Tags, badged; the row opens the folder's own list", async () => {
    const el = await mountShell([mailbox()]);
    await tick(30_000);

    const toggles = [...el.querySelectorAll(".rlabel-toggle")].map((n) => n.textContent?.trim());
    // Under Tags: both groups present, Tags first.
    expect(toggles.indexOf("Folders")).toBeGreaterThan(toggles.indexOf("Tags"));

    const row = el.querySelector('[data-rail-folder-id="fd1"]') as HTMLElement;
    expect(row, "the folder row is missing from the rail").not.toBeNull();
    // "Projects/Acme" has no parent row in this inventory, so it renders as a ROOT showing its
    // leaf — the label is the leaf, the title carries the full path.
    expect(row.getAttribute("title")).toBe("Projects/Acme");
    // One unread message in the folder — the badge says so.
    expect(row.querySelector(".cnt")?.textContent).toBe("1");

    await act(async () => { row.click(); await Promise.resolve(); });
    await tick(0);
    expect(window.location.hash).toBe("#/folder/fd1");
    const view = el.querySelector(".view-folder") as HTMLElement;
    expect(view).not.toBeNull();
    // The standard grouping: the unread arrival under New, the old read one under Earlier.
    expect(textOf(view)).toContain("New");
    expect(textOf(view)).toContain("Earlier");
    expect(textOf(view)).toContain("subject of fm-new");
    expect(textOf(view)).toContain("subject of fm-old");
  });

  it("History shows the folder-filed old read mail, badged with its folder — and the folder keeps it", async () => {
    const el = await mountShell([mailbox()]);
    await tick(30_000);

    await goHash("#/history");
    const history = textOf(el.querySelector(".view") as HTMLElement);
    expect(history).toContain("subject of fm-old");
    // The place badge is the server's own folder — the lens, not a move.
    const row = [...el.querySelectorAll(".row")].find((r) => textOf(r as HTMLElement).includes("fm-old"));
    expect(row).toBeDefined();
    expect(textOf(row as HTMLElement)).toContain("Projects/Acme");

    // The lens never empties the place it looks at: the folder's list still holds the row.
    await goHash("#/folder/fd1");
    expect(textOf(el.querySelector(".view-folder") as HTMLElement)).toContain("subject of fm-old");
  });
});
