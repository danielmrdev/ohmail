/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ISO, act, answerConsentWith, answerSyncWith, installShellEnv, mailbox, mountShell,
  teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE NINE KEYCAPS THAT DID NOTHING IN FOLDER, TAG AND HISTORY
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Those three views mount the message pane, and the pane's action bar prints each verb's keycap
 * READ FROM THE LIVE REGISTRY. Nine of those caps were advertising dead keys: `r`, `⇧R`, `a`,
 * `e`, `b`, `s`, `t`, `m` and `d` produced nothing in these views while the button beside the
 * cap worked and the same key worked in the Ohbox.
 *
 * The cause is structural. The shell's bindings act on `focused`; in a SPLIT view the message on
 * screen is the view's own `shown`, which the shell cannot see — so those bindings register
 * `disabled` here, and `MessagePane`'s `Key` prints a cap for a bound-but-disabled chord on
 * purpose ("a disabled owner still owns the key, and the cap must not vanish while the verb
 * rests"). That rule is right for a RESTING verb and produces a lie for an UNWIRED one, and the
 * two are indistinguishable from the bar. So the verbs are wired (`useMessageVerbs`) rather than
 * the caps suppressed.
 *
 * ── WHY THESE ASSERTIONS ─────────────────────────────────────────────────────────────────
 *
 * Every case pins the CLAIM and the OUTCOME as one pair: the bar prints the cap, and the key
 * produces the thing the cap promises. A binding-table check would pass for a binding that is
 * registered and wrong, which is the failure this file exists to catch.
 *
 * `m` and `d` are the two verbs chosen for the outcome half because they change only UI state —
 * the bar's destination strip and the delete ceremony's ask — so a jsdom walk observes them
 * without a mutation reaching the wire. `d` is the verb whose absence was most expensive: the
 * ceremony's first press is the only thing standing between a keyboard user and an un-undoable
 * delete. It used to need the folders consent, which this world turns on for the Folders RAIL;
 * it does not need it any more, and the last describe here is that change's control — `d` in a
 * split view with the consent answering folders OFF.
 *
 * ── HOW TO WATCH IT FAIL ─────────────────────────────────────────────────────────────────
 *
 * Delete the `useMessageVerbs` call from any one of the three views and that view's cases go red
 * while its keycaps are unchanged — which is the defect, exactly as it shipped. Drop the `m`
 * entry from `message-verbs.ts` and all three views' move cases redden together.
 */

const message = (
  o: { id: string; from: string; folder?: string; date?: string; unread?: boolean;
       labels?: string[] },
  seq: number,
) => ({
  type: "message", op: "create", id: o.id, seq, updatedAt: o.date ?? ISO,
  entity: {
    id: o.id, accountId: "acct_live_1", mailboxId: "mb_1",
    threadId: null, messageIdHeader: null,
    subject: `subject of ${o.id}`,
    from: { name: `Sender ${o.id}`, address: o.from },
    to: [], cc: [], date: o.date ?? ISO, folder: o.folder ?? "INBOX",
    snippet: `snippet of ${o.id}`, unread: o.unread ?? false,
    hasAttachments: false, attachmentCount: 0, sensitivity: {},
    triage: null, labels: o.labels ?? [], remoteContent: "none", updatedAt: o.date ?? ISO,
  },
});

const folderEntity = (id: string, name: string, seq: number) => ({
  type: "folder", op: "create", id, seq, updatedAt: ISO,
  entity: { id, name, mailboxId: "mb_1", mailbox: "live@example.invalid", updatedAt: ISO },
});

const tagEntity = (id: string, name: string, seq: number) => ({
  type: "tag", op: "create", id, seq, updatedAt: ISO,
  entity: { id, name, color: null, updatedAt: ISO },
});

/** Comfortably past the History window measured from the fixture clock. */
const OLD = "2024-03-02T09:00:00.000Z";

const world = (): Response =>
  new Response(
    JSON.stringify({
      changes: {
        creates: [
          folderEntity("fd1", "Projects/Acme", 1),
          tagEntity("tg1", "Invoices", 2),
          // In the folder, and tagged — one message reachable from Folder and from Tag.
          message({
            id: "sv-1", from: "acme@example.invalid", folder: "Projects/Acme", labels: ["tg1"],
          }, 3),
          // Old, read, and from a sender who has NOT written since — History is "mail from
          // people you never screened, who haven't written in a while", so the quiet sender has
          // to be a different one from the folder's or their recent arrival disqualifies it.
          message({ id: "sv-old", from: "quiet@example.invalid", date: OLD }, 4),
          // An ordinary arrival so the shell has a pile to stand on.
          message({ id: "inbox-1", from: "acme@example.invalid" }, 5),
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
  /* The Folders RAIL's gate — the Folder view below is reachable only with it on. It is no
     longer `d`'s gate; the folders-off describe at the bottom of this file is that control. */
  answerConsentWith({ foldersEnabledAt: ISO });
  answerSyncWith(world);
});
afterEach(async () => { await teardownShellEnv(); });

const goHash = async (hash: string): Promise<void> => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
    await Promise.resolve();
  });
  await tick(0);
};

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
  await tick(0);
};

/** The keycap the bar prints for one verb, inside one view — the claim under test. */
const capIn = (el: HTMLElement, scope: string, startsWith: string): string | undefined => {
  const btn = [...el.querySelectorAll<HTMLButtonElement>(`${scope} .abar-b`)]
    .find((b) => (b.textContent ?? "").startsWith(startsWith));
  return btn?.querySelector("kbd")?.textContent ?? undefined;
};

const VIEWS: Array<{ name: string; scope: string; hash: string }> = [
  { name: "Folder", scope: ".view-folder", hash: "#/folder/fd1" },
  { name: "Tag", scope: ".view-tag", hash: "#/tag/tg1" },
  { name: "History", scope: ".view-history", hash: "#/history" },
];

describe("a printed keycap acts, in every split view", () => {
  for (const v of VIEWS) {
    describe(v.name, () => {
      it("prints the Move cap AND `m` opens the destination strip on the shown message", async () => {
        const el = await mountShell([mailbox()]);
        await tick(30_000);
        await goHash(v.hash);
        expect(el.querySelector(v.scope), `${v.name} view did not mount`).not.toBeNull();

        // THE CLAIM: the bar advertises `m` here.
        expect(capIn(el, v.scope, "Move"), `${v.name}'s bar does not advertise m`).toBe("m");
        // Nothing is open yet — otherwise the assertion below would pass on the resting state.
        expect(el.querySelector(`${v.scope} .abar-panel`)).toBeNull();

        // THE OUTCOME: the key the cap promises opens the strip the button opens.
        await key("m");
        expect(
          el.querySelector(`${v.scope} .abar-panel`),
          `m printed a keycap in ${v.name} and opened nothing`,
        ).not.toBeNull();
      }, 30000);

      it("prints the Delete cap AND `d` opens the ask — never deleting on one press", async () => {
        const el = await mountShell([mailbox()]);
        await tick(30_000);
        await goHash(v.hash);
        expect(el.querySelector(v.scope), `${v.name} view did not mount`).not.toBeNull();

        await key("d");
        const ask = el.querySelector(`${v.scope} .abar-delete`);
        expect(ask, `d printed a keycap in ${v.name} and opened nothing`).not.toBeNull();
        // The ceremony ASKS first — the cap on the danger button is the second `d`.
        expect(ask!.getAttribute("role")).toBe("alertdialog");
      }, 30000);

      /**
       * AUTO-REPEAT IS ONE PRESS. A finger resting on `d` would otherwise walk the ask and the
       * confirm on its own — the shell's own binding carries this guard as a review finding, and
       * a second declaration of the ceremony needs it just as much.
       */
      it("a HELD `d` cannot walk the ceremony — repeat is not a second press", async () => {
        const el = await mountShell([mailbox()]);
        await tick(30_000);
        await goHash(v.hash);

        await key("d");
        expect(el.querySelector(`${v.scope} .abar-delete`)).not.toBeNull();
        // The key repeating while held must not press the danger button.
        await key("d", { repeat: true });
        expect(
          el.querySelector(`${v.scope} .abar-delete`),
          "auto-repeat confirmed a delete the user never pressed twice",
        ).not.toBeNull();
      }, 30000);
    });
  }
});


/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE SAME `d`, WITH "USE FOLDERS" OFF — the borrowed gate carries no folders term
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * These views declare their message verbs over their OWN cursor (`useMessageVerbs`), and the
 * delete gate is the one fact they cannot derive: it is resolved once in the shell as
 * `canDeleteMessage` and passed down. That predicate used to read the folders foundation flag,
 * so a folders-off account got a keycap for `d` in every split view and nothing when it pressed
 * it — a printed cap over a dead key, which is the exact defect the describe above exists for,
 * arriving through a different door.
 *
 * TAG AND HISTORY, NOT FOLDER. With the flag off there are no folder entities for the shell to
 * list, so `#/folder/fd1` has nothing to mount — that view legitimately needs the foundation and
 * still does. Tag and History do not, and they borrow the same predicate, so they are where this
 * is watched.
 */
describe("the borrowed delete gate with the folders switch OFF", () => {
  beforeEach(() => {
    // Re-answered AFTER the outer `beforeEach` turned it on, so this is the whole difference.
    answerConsentWith({ foldersEnabledAt: null });
  });

  for (const v of VIEWS.filter((x) => x.name !== "Folder")) {
    it(`${v.name}: \`d\` still opens the ask — never deleting on one press`, async () => {
      const el = await mountShell([mailbox()]);
      await tick(30_000);
      await goHash(v.hash);
      expect(el.querySelector(v.scope), `${v.name} view did not mount`).not.toBeNull();

      /* NO CAP ASSERTION HERE, and that is not an omission. Delete deliberately has no button on
         the bar's row — "a destructive verb does not get a slot a stray click can land on"
         (`action-bar.test.ts`) — it lives in the ⋯ menu, so `capIn(…, "Delete")` is `undefined`
         for a perfectly correct bar. The first version of this case asserted a cap and went red
         for that reason: a false claim about the product, caught by the whole-directory run.
         Where the verb IS advertised on a folders-off account is the `?` sheet, and that is
         asserted in `delete-key-shell.test.tsx` (both rows, neither greyed). What this case owns
         is the OUTCOME half: the key acts in a split view with the switch off. */
      await key("d");
      const ask = el.querySelector(`${v.scope} .abar-delete`);
      expect(ask, `d printed a keycap in ${v.name} with folders off and opened nothing`)
        .not.toBeNull();
      expect(ask!.getAttribute("role")).toBe("alertdialog");
    }, 30000);
  }

  it("Folder is unreachable with the flag off — the foundation it DOES need", async () => {
    /* The control for the filter above: this is not a view that was quietly dropped from the
       loop, it is one the folders foundation really gates, and the flag term was removed from
       the DELETE predicate only. */
    const el = await mountShell([mailbox()]);
    await tick(30_000);
    await goHash("#/folder/fd1");
    expect(el.querySelector(".view-folder"), "the Folder view mounted with folders off")
      .toBeNull();
  }, 30000);
});
