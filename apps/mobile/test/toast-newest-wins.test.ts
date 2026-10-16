/**
 * THE NEWEST SENTENCE WINS (owner ruling 2026-09-21, closing
 * `MOBILE-TOAST-QUEUE-SILENTLY-DROPS-A-VERBS-SENTENCE`). A four-deep queue stood in the world
 * provider: each sentence took its turn and a fifth was handed back unrendered with no record
 * that anything had been said. Three verbs in a row therefore put the third's sentence — and its
 * Undo — up to sixteen seconds away, and the fourth press was answered by nothing.
 *
 * What is asked here: the last press is the one on screen, nothing sits waiting, a stale
 * dismiss cannot take the newer sentence down, and — the half that makes the ruling safe — a
 * DISPLACED act is not lost. That last one runs on a real wire, because it is a claim about the
 * engine and not about the pill: a held delete commits on its own timer and an undo offer dies
 * on its own clock, neither of which consults the toast.
 */
import { describe, expect, it } from "vitest";
import { NO_TOASTS, afterDismiss, nextToast, type ToastEntry, type ToastSlots } from "../src/state/toast-one";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, UNDO_MS, type LiveWorldActions, type ToastOpts } from "../src/state/live";
import { Copy } from "../src/copy";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";
import { arrived, CASE_MS } from "./helpers/arrived";

const entry = (id: number, say: string, undo?: () => void): ToastEntry =>
  ({ id, say: { say } as ToastEntry["say"], ...(undo ? { undo, holdMs: UNDO_MS } : {}) });

/** The provider's own fold: `showToast` over a run of presses, with nothing else in the way. */
const fold = (entries: ToastEntry[]): ToastSlots =>
  entries.reduce<ToastSlots>((standing, e) => nextToast(standing, e), NO_TOASTS);
const noticeOnly = (notice: ToastEntry): ToastSlots => ({ action: null, notice });

describe("the pill shows the press you just made", () => {
  it("four rapid verbs leave the FOURTH sentence standing, and none waiting", () => {
    const four = [entry(1, "toastQueued"), entry(2, "toastAside"), entry(3, "toastMoved"), entry(4, "toastRead")];
    const shown = fold(four).notice;
    expect(shown?.id).toBe(4);
    expect(shown?.say).toEqual({ say: "toastRead" });
    // The old shape's refusal, as arithmetic: with a bound of four the FIFTH was returned
    // unrendered and the first was still on screen. Here the fifth is simply the one shown.
    expect(fold([...four, entry(5, "toastDeleted")]).notice?.id).toBe(5);
  });

  it("there is no queue to sit in: the standing entry is never kept", () => {
    const standing = entry(1, "toastQueued");
    expect(nextToast(noticeOnly(standing), entry(2, "toastAside")).notice).not.toBe(standing);
    expect(nextToast(NO_TOASTS, standing).notice).toBe(standing);
  });

  it("a dismiss clears the sentence it was looking at, and only that one", () => {
    const standing = noticeOnly(entry(7, "toastMoved"));
    expect(afterDismiss(standing, 7)).toEqual(NO_TOASTS);
    // The two reachable stale callers: a displaced entry's hold timer, and an Undo press whose
    // handler belongs to the last painted render.
    expect(afterDismiss(standing, 6)).toBe(standing);
    expect(afterDismiss(standing)).toEqual(NO_TOASTS);
    expect(afterDismiss(NO_TOASTS, 7)).toEqual(NO_TOASTS);
  });
});

/* ── the displaced act, on a real wire ─────────────────────────────────────────────────── */

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };
interface SaidToast extends ToastOpts { say: string }

async function scene() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const raised: SaidToast[] = [];
  const clock = { skew: 0 };
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine,
    // The provider's door, with the ruling's fold standing in for its state.
    toast: (m, opts) => raised.push({ say: sayArg(m), ...(opts ?? {}) }),
    uuid,
    zone: "UTC",
    now: () => new Date(Date.now() + clock.skew),
  });
  return { fake, ...boot, actions, raised, clock };
}

/** The window an ABSENCE is read over: nothing more may reach the wire in it. Arrivals are waited for. */
const settle = () => new Promise((r) => setTimeout(r, 25));
const triagePosts = (fake: ReturnType<typeof mailServer>, id: string) =>
  fake.seen
    .filter((r) => r.method === "POST" && r.url === `/messages/${id}/triage`)
    .map((r) => (JSON.parse(r.body) as { state: string }).state);

describe("a displaced sentence's act is not lost", () => {
  it("the second verb takes the screen; the FIRST verb's undo still reverses it on the wire", async () => {
    const live = await scene();
    live.fake.addMessage(dto("m1"));
    live.fake.addMessage(dto("m2"));
    await live.engine.syncOnce();

    expect(await live.actions.pileToggle("m1", "replyLater")).toBe(true);
    const first = live.raised.find((t) => t.say === Copy.toastQueued);
    expect(first?.undo, "the first verb offered a way back").toBeDefined();

    expect(await live.actions.pileToggle("m2", "setAside")).toBe(true);
    const second = live.raised.find((t) => t.say === Copy.toastAside);
    expect(second?.undo).toBeDefined();
    // The pill now shows the SECOND. The first is off the screen — and its act stands, dispatched.
    const undoOf = (t: SaidToast | undefined) => t?.undo ?? (() => undefined);
    expect(fold([entry(1, "toastQueued", undoOf(first)), entry(2, "toastAside", undoOf(second))]).action?.say)
      .toEqual({ say: "toastAside" });
    expect(triagePosts(live.fake, "m1")).toEqual(["reply_later"]);

    // Its undo is bound by its OWN clock, read at the press, not by how long its sentence stood.
    first!.undo!();
    await arrived("the displaced verb's inverse POST", () => triagePosts(live.fake, "m1").length >= 2,
      () => `[${triagePosts(live.fake, "m1").join(", ")}]`);
    expect(triagePosts(live.fake, "m1"), "the displaced verb's way back still works").toEqual(["reply_later", "none"]);

    live.store.close();
    live.fake.server.close();
  }, CASE_MS);

  it("and it dies on that clock, displaced or not", async () => {
    const live = await scene();
    live.fake.addMessage(dto("m1"));
    await live.engine.syncOnce();
    await live.actions.pileToggle("m1", "replyLater");
    const offer = live.raised.find((t) => t.undo)!;
    live.clock.skew = UNDO_MS + 1;
    offer.undo!();
    await settle();
    expect(triagePosts(live.fake, "m1")).toEqual(["reply_later"]);
    live.store.close();
    live.fake.server.close();
  });
});
