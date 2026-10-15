/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TrashWindowItemWire, TrashWindowPageWire } from "../app/api-client";
import {
  trashLiveState, trashReadVerbs, trashLiveKeyOf,
  type TrashWindowControl, type TrashWire,
} from "../app/shell/trash-window";

/**
 * THE LIVE TRASH WINDOW'S CLIENT STATE — the state table, the pagination, and the two properties
 * that make this window read-only.
 *
 * The window reads the provider's own \Trash on demand and writes nothing: the rows never enter
 * the mirror, the door is two GETs, and a live row has no verb because a message the mirror never
 * held records no folder a restore could aim at. `trashLiveState` is the only place the window's
 * silence is interpreted, so its order is the honesty: a mailbox the server could not finish
 * reading is never reported as an empty folder.
 *
 * MUTATIONS WATCHED — each recorded in the lane's report with the case it reddens.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const list = vi.fn<(opts?: { cursor?: string }) => Promise<TrashWindowPageWire>>();
const body = vi.fn<(m: string, u: number, v: string) => Promise<{ subject: string; text: string }>>();
/** The mock's mutable "is there a server" answer — the unsupported case flips it. */
const configured = { value: true };

vi.mock("../app/api-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("../app/api-client")>();
  return {
    ...real,
    apiConfigured: () => configured.value,
    trashWindow: {
      list: (opts?: { cursor?: string }) => list(opts),
      body: (m: string, u: number, v: string) => body(m, u, v),
    },
  };
});

function item(uid: number, over: Partial<TrashWindowItemWire> = {}): TrashWindowItemWire {
  return {
    mailboxId: "mb1", uid, uidValidity: "77",
    subject: `trashed ${uid}`, from: { name: null, address: `s${uid}@example.invalid` },
    date: `2026-09-0${uid}${"T"}10:00:00.000Z`, messageIdHeader: `<mid-${uid}@x>`,
    seen: false, origin: "provider", ...over,
  };
}
const ok = (over: { reset?: boolean } = {}) => ({
  id: "mb1", address: "a@example.invalid", window: "ok" as const,
  ...(over.reset ? { reset: true } : {}),
});
const pageWire = (
  items: TrashWindowItemWire[], nextCursor: string | null, over: { reset?: boolean } = {},
): TrashWindowPageWire => ({ mailboxes: [ok(over)], items, nextCursor });

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let control: TrashWindowControl | null = null;
let setActive: ((v: boolean) => void) | null = null;

async function mountHook(initiallyActive = true, hostWire?: TrashWire): Promise<void> {
  const { useTrashWindow } = await import("../app/shell/trash-window");
  function Probe(): null {
    const [active, set] = React.useState(initiallyActive);
    setActive = set;
    control = useTrashWindow(active, hostWire);
    return null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(Probe));
  });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};

beforeEach(() => {
  list.mockReset();
  body.mockReset();
  body.mockResolvedValue({ subject: "s", text: "the body" });
  configured.value = true;
  control = null;
  setActive = null;
});

afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

// ── the state table ─────────────────────────────────────────────────────────────────────────

describe("what the section says, decided once", () => {
  const at = (over: Parameters<typeof trashLiveState>[0]) => trashLiveState(over).state;

  it("a read in flight is loading, and a read that FAILED is failed — never empty", () => {
    expect(at({ phase: "loading", items: [], mailboxes: [], nextCursor: null })).toBe("loading");
    /* A dead dial has no business claiming the folder is clean. Mutation watched: return
       `{ state: "empty" }` for the failed phase — this case reads "empty". */
    expect(at({ phase: "failed", items: [], mailboxes: [ok()], nextCursor: null })).toBe("failed");
  });

  it("rows are rows, whatever the per-mailbox degrades say beside them", () => {
    expect(at({
      phase: "ready", items: [item(1)],
      mailboxes: [ok(), { id: "mb2", address: "b@example.invalid", window: "unreachable" }],
      nextCursor: null,
    })).toBe("rows");
  });

  it("A MAILBOX THE SERVER COULD NOT FINISH READING outranks emptiness", () => {
    /* THE DECIDING ORDER. Zero rows beside an `unreachable` mailbox is a read limit; calling it
       "nothing in your mail server's Trash" would be this window inventing the folder's state.
       Mutation watched: move the `empty` return above the `unreachable` check — this case and
       the one below both read "empty". */
    expect(at({
      phase: "ready", items: [],
      mailboxes: [{ id: "mb1", address: "a@example.invalid", window: "unreachable" }],
      nextCursor: null,
    })).toBe("read_limited");
    expect(at({
      phase: "ready", items: [],
      mailboxes: [ok(), { id: "mb2", address: "b@example.invalid", window: "unreachable" }],
      nextCursor: null,
    })).toBe("read_limited");
  });

  it("no folder to read is UNAVAILABLE, and so is an account this window serves none of", () => {
    expect(at({
      phase: "ready", items: [],
      mailboxes: [{ id: "mb1", address: "a@example.invalid", window: "no_trash_folder" }],
      nextCursor: null,
    })).toBe("unavailable");
    expect(at({ phase: "ready", items: [], mailboxes: [], nextCursor: null })).toBe("unavailable");
  });

  it("a page that kept nothing but has OLDER to read claims nothing", () => {
    /* ohmail's own deletes are dropped from this population, so a page can arrive holding
       nothing for this section while older pages still hold rows. Mutation watched: drop the
       `nextCursor !== null` arm — this case reads "empty", i.e. the section would say the
       folder is clean with a cursor still in hand. */
    expect(at({ phase: "ready", items: [], mailboxes: [ok()], nextCursor: "c1" }))
      .toBe("more_to_read");
  });

  it("a drained walk over folders that WERE read is empty, and says so", () => {
    expect(at({ phase: "ready", items: [], mailboxes: [ok()], nextCursor: null })).toBe("empty");
  });
});

describe("which verbs the reading column offers", () => {
  it("a mirrored row keeps restore and the read switch; a live row has NO action set", () => {
    /* Not a missing prop: `MessagePane` with no `trash` renders the full eleven-group bar, so
       the emptiness has to be stated. Mutation watched: return `restore_and_read` for a live
       row — the UI twin's "zero actions" case reddens. */
    expect(trashReadVerbs({ live: false })).toEqual({ verbs: "restore_and_read" });
    expect(trashReadVerbs({ live: true }))
      .toEqual({ verbs: "none", why: "live_row_has_no_destination" });
  });
});

describe("the row key is epoch-scoped", () => {
  it("two epochs of one UID are two different rows", () => {
    /* Trash is the folder providers purge, so a recreated folder reuses the numbers. Mutation
       watched: drop `uidValidity` from the key — these two read equal, which would alias a new
       message's row onto the old one's cached body. */
    expect(trashLiveKeyOf({ mailboxId: "mb1", uidValidity: "77", uid: 9 }))
      .not.toBe(trashLiveKeyOf({ mailboxId: "mb1", uidValidity: "78", uid: 9 }));
  });
});

// ── the hook ────────────────────────────────────────────────────────────────────────────────

describe("the window's first page", () => {
  it("reads once on arrival and drops ohmail's OWN deletes from the live population", async () => {
    list.mockResolvedValue(pageWire(
      [item(1), item(2, { origin: "ohmail" }), item(3)], null,
    ));
    await mountHook();
    expect(list).toHaveBeenCalledTimes(1);
    expect(control!.phase).toBe("ready");
    /* The mirrored section above already lists an `"ohmail"` row with its deletion time and its
       restore. Mutation watched: drop the `origin !== "ohmail"` filter in `liveOnly` — this
       reads three uids, i.e. one message rendered twice in one view. */
    expect(control!.items.map((i) => i.uid)).toEqual([1, 3]);
  });

  it("says FAILED, not empty, when the read fails — and re-asks only on the press", async () => {
    list.mockRejectedValue(new Error("no answer"));
    await mountHook();
    expect(control!.phase).toBe("failed");
    expect(control!.items).toEqual([]);
    expect(list).toHaveBeenCalledTimes(1);
    // A settled failure sits still. Nothing here loops: the retry is the reader's.
    await settle();
    expect(list).toHaveBeenCalledTimes(1);
    list.mockResolvedValue(pageWire([item(1)], null));
    await act(async () => { control!.reload(); });
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
    expect(control!.phase).toBe("ready");
  });

  it("with no server behind the build it asks NOTHING and rests on failed", async () => {
    configured.value = false;
    await mountHook();
    expect(control!.supported).toBe(false);
    expect(list).not.toHaveBeenCalled();
    expect(control!.phase).toBe("failed");
  });

  it("reads nothing while the view is elsewhere, and reads on arrival", async () => {
    list.mockResolvedValue(pageWire([item(1)], null));
    await mountHook(false);
    expect(list).not.toHaveBeenCalled();
    await act(async () => { setActive!(true); });
    await settle();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("leaving DROPS the window, so a return reads the folder again", async () => {
    list.mockResolvedValue(pageWire([item(1)], "c1"));
    await mountHook();
    expect(control!.items).toHaveLength(1);
    await act(async () => { setActive!(false); });
    await settle();
    // These rows are the folder a moment ago; keeping them would render yesterday's Trash.
    expect(control!.items).toEqual([]);
    expect(control!.nextCursor).toBeNull();
    await act(async () => { setActive!(true); });
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1]?.[0]).toBeUndefined();
  });
});

describe("show older", () => {
  it("pages with the server's cursor, appends, and never repeats a row", async () => {
    list.mockResolvedValueOnce(pageWire([item(3), item(2)], "c1"));
    await mountHook();
    list.mockResolvedValueOnce(pageWire([item(2), item(1)], null));
    await act(async () => { control!.loadOlder(); });
    await settle();
    expect(list.mock.calls[1]?.[0]).toEqual({ cursor: "c1" });
    expect(control!.items.map((i) => i.uid)).toEqual([3, 2, 1]);
    expect(control!.nextCursor).toBeNull();
  });

  it("a STATED epoch reset restarts the window instead of appending under stale rows", async () => {
    list.mockResolvedValueOnce(pageWire([item(3)], "c1"));
    await mountHook();
    /* The server discards a cursor whose UIDVALIDITY no longer matches and says so; those rows
       are that mailbox's new TOP page. Appending them would file the folder's newest mail at the
       bottom of the section. Mutation watched: ignore `reset` — the third call never happens and
       the items read [3, 9]. */
    list.mockResolvedValueOnce(pageWire([item(9, { uidValidity: "78" })], null, { reset: true }));
    list.mockResolvedValueOnce(pageWire([item(9, { uidValidity: "78" })], null));
    await act(async () => { control!.loadOlder(); });
    await settle();
    expect(list).toHaveBeenCalledTimes(3);
    expect(list.mock.calls[2]?.[0]).toBeUndefined();
    expect(control!.items.map((i) => i.uid)).toEqual([9]);
  });

  it("a failed older page keeps what is on screen and does not re-ask on its own", async () => {
    list.mockResolvedValueOnce(pageWire([item(3)], "c1"));
    await mountHook();
    list.mockRejectedValueOnce(new Error("no answer"));
    await act(async () => { control!.loadOlder(); });
    await settle();
    expect(control!.items.map((i) => i.uid)).toEqual([3]);
    expect(control!.olderLoading).toBe(false);
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe("the body on open", () => {
  it("reads once per row per session and holds the answer", async () => {
    list.mockResolvedValue(pageWire([item(1)], null));
    await mountHook();
    const row = control!.items[0]!;
    expect(control!.bodyFor(row)).toEqual({ phase: "idle" });
    await act(async () => { control!.openBody(row); });
    await settle();
    expect(body).toHaveBeenCalledWith("mb1", 1, "77");
    expect(control!.bodyFor(row)).toEqual({ phase: "ready", text: "the body" });
    // A second open costs nothing: the session holds what it read.
    await act(async () => { control!.openBody(row); });
    await settle();
    expect(body).toHaveBeenCalledTimes(1);
  });

  it("a failed body is failed, and the human retry dispatches a second read", async () => {
    list.mockResolvedValue(pageWire([item(1)], null));
    await mountHook();
    const row = control!.items[0]!;
    body.mockRejectedValueOnce(new Error("gone"));
    await act(async () => { control!.openBody(row); });
    await settle();
    expect(control!.bodyFor(row)).toEqual({ phase: "failed" });
    await act(async () => { control!.openBody(row, { retry: true }); });
    await settle();
    expect(body).toHaveBeenCalledTimes(2);
    expect(control!.bodyFor(row)).toEqual({ phase: "ready", text: "the body" });
  });
});

// ── the host wire: the desktop's door ───────────────────────────────────────────────────────

/**
 * WHAT THE DESKTOP DID, AND WHAT THE WIRE CHANGES.
 *
 * `configured.value = false` IS the desktop: that build aliases `app/api-client` to a refusing
 * stub whose `apiConfigured()` answers `false`. The first case below is the shipped defect,
 * measured — no wire, no section — and the rest are the fix. The last one is the rule that makes
 * the fix safe: a handed-in wire is the ONLY door, so the window cannot reach a second one.
 */
describe("the host wire — the desktop's door", () => {
  it("THE DEFECT, MEASURED: no wire and no Cloud client means not supported and NOTHING asked", async () => {
    configured.value = false;
    await mountHook(true);

    // This is what the desktop rendered: `supported` false, so `AppShell` withheld the control
    // from the view and the live section was absent altogether — no rows, no stated absence, no
    // failed sentence. The hook asks nothing at all, which is the one thing it got right.
    expect(control!.supported).toBe(false);
    expect(list).not.toHaveBeenCalled();
    expect(control!.phase).toBe("failed");
  });

  it("a HOST WIRE is a server: supported, asked, and the rows are the wire's", async () => {
    configured.value = false;
    const wireList = vi.fn<(opts?: { cursor?: string }) => Promise<TrashWindowPageWire>>()
      .mockResolvedValue(pageWire([item(2), item(1)], null));
    const wireBody = vi.fn<(m: string, u: number, v: string) => Promise<{ subject: string; text: string }>>()
      .mockResolvedValue({ subject: "s", text: "over the pipe" });

    await mountHook(true, { list: wireList, body: wireBody });

    // `apiConfigured()` still answers false — the wire alone arms the window, which is exactly
    // the Junk window's rule and what makes the section appear on a build with no Cloud client.
    expect(control!.supported).toBe(true);
    expect(wireList).toHaveBeenCalledTimes(1);
    expect(control!.phase).toBe("ready");
    expect(control!.items.map((i) => i.uid)).toEqual([2, 1]);
    expect(trashLiveState(control!).state).toBe("rows");
  });

  it("the six states are the SAME states over the wire — a stated absence is `unavailable` here too", async () => {
    configured.value = false;
    const wireList = vi.fn<(opts?: { cursor?: string }) => Promise<TrashWindowPageWire>>()
      .mockResolvedValue({
        mailboxes: [{ id: "mb1", address: "a@example.invalid", window: "no_trash_folder" }],
        items: [], nextCursor: null,
      });

    await mountHook(true, { list: wireList, body: vi.fn() });

    // The verdict is decided above the seam, so the desktop cannot render a different sentence
    // from the browser for the same answer. A mailbox with no native \Trash: stated, not empty.
    expect(trashLiveState(control!).state).toBe("unavailable");
  });

  it("a wire failure is `failed`, never an empty folder — the honesty survives the substitution", async () => {
    configured.value = false;
    const wireList = vi.fn<(opts?: { cursor?: string }) => Promise<TrashWindowPageWire>>()
      .mockRejectedValue(new Error("the mail engine answered 503"));

    await mountHook(true, { list: wireList, body: vi.fn() });

    expect(control!.phase).toBe("failed");
    expect(trashLiveState(control!).state).toBe("failed");
    expect(control!.items).toEqual([]);
  });

  it("the body on open goes down the WIRE, with the row's own epoch", async () => {
    configured.value = false;
    const wireBody = vi.fn<(m: string, u: number, v: string) => Promise<{ subject: string; text: string }>>()
      .mockResolvedValue({ subject: "s", text: "over the pipe" });
    const row = item(2);

    await mountHook(true, {
      list: vi.fn<(opts?: { cursor?: string }) => Promise<TrashWindowPageWire>>()
        .mockResolvedValue(pageWire([row], null)),
      body: wireBody,
    });
    await act(async () => { control!.openBody(row); });
    await settle();

    expect(wireBody).toHaveBeenCalledWith("mb1", 2, "77");
    expect(control!.bodyFor(row)).toEqual({ phase: "ready", text: "over the pipe" });
  });

  it("ONE DOOR: with a wire handed in, the Cloud client is never touched — not even when configured", async () => {
    // The hard rule. `configured.value = true` puts a working Cloud client behind the stub, so a
    // hook that fell back to it — on the first page, on "show older", or on a body — would open a
    // second path to the provider's Trash and nothing on screen would say which one answered.
    configured.value = true;
    const wireList = vi.fn<(opts?: { cursor?: string }) => Promise<TrashWindowPageWire>>()
      .mockResolvedValue(pageWire([item(1)], "cursor-2"));
    const wireBody = vi.fn<(m: string, u: number, v: string) => Promise<{ subject: string; text: string }>>()
      .mockResolvedValue({ subject: "s", text: "t" });

    await mountHook(true, { list: wireList, body: wireBody });
    await act(async () => { control!.loadOlder(); });
    await settle();
    await act(async () => { control!.openBody(item(1)); });
    await settle();

    expect(wireList).toHaveBeenCalledTimes(2);
    expect(wireBody).toHaveBeenCalledTimes(1);
    // The api-client's own two functions: untouched, on every one of the three reads above.
    expect(list).not.toHaveBeenCalled();
    expect(body).not.toHaveBeenCalled();
  });
});
