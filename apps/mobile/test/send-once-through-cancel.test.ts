/**
 * ═══ CANCEL CANCELS, AND ONE INTENT CARRIES ONE KEY ══════════════════════════════════════════
 *
 * The defect this file measures, in the person's own words: send while offline, read "Not sent
 * yet", press Cancel, write the reply again, send — and when the phone reconnects the
 * correspondent receives the message TWICE. The queued send's lifetime was tied to a component
 * that can be unmounted, and its Idempotency-Key was minted per composer rather than per intent,
 * so the second press was a second reservation and both went.
 *
 * Measured at the base commit through this app's own `bootEngine` composition: two
 * `POST /drafts/:id/send` requests under TWO keys.
 *
 * ── WHAT IS DRIVEN, AND WHY IT IS NOT A RENDER ───────────────────────────────────────────────
 *
 * There is no React Native renderer in this workspace (`test/fourth-door.test.ts` records it), so
 * the composer's decision lives in `src/ui/send-cancel.ts` and is driven directly; the sheet is
 * READ to prove those are the decisions it takes. Everything below the decision is real: the
 * engine, the durable outbox, the loopback mail server and its send reservation (a second send
 * under a key it already holds is answered from the first and dials nothing, exactly as
 * `outbound_sends` UNIQUE `(accountId, idempotencyKey)` does).
 *
 * ── HOW TO WATCH EACH ONE FAIL ───────────────────────────────────────────────────────────────
 *
 *  1. `cancelAct` answering `"close"` for a queued send — the defect itself → controls 1 and 3.
 *  2. `withdrawQueued` without `this.withdrawnKeys.add(key)` → control 5.
 *  3. `withdrawQueued` without the queue removal → control 1.
 *  4. `dispatch` without the withdrawn read → control 5: a batch sends a row already withdrawn.
 *  5. `restoreOutbox` without the `withdrawn` skip → control 4: a relaunch re-queues a cancelled send.
 *  6. `dispatchSend` without the standing-key lookup → control 1b: a second press, a second key.
 * Each was run, watched red by the assertion named beside it, and restored from a pristine copy
 * proved by `cmp`.
 */
import { describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { OUTBOX_TYPE, type WithdrawOutcome } from "@ohmail/client-engine";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { flushQueued, liveActions, sendIntentOf, type LiveWorldActions } from "../src/state/live";
import { afterWithdraw, cancelAct, type WithdrawAnswer } from "../src/ui/send-cancel";
import { Copy } from "../src/copy";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSER = readFileSync(join(APP, "src/ui/MessageActions.tsx"), "utf8");

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();

/**
 * One phone, one loopback server, and a transport this test owns: `tunnel(true)` is the phone
 * with no signal (a rejected fetch — `code: "network"`, retryable, and it spends none of the
 * outbox's give-up ceiling, which is what being in a tunnel really is), and `holdTheSend()`
 * stops the send request AT THE DOOR so a Cancel can be pressed while it is on the wire.
 */
async function scene() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("m-1", { subject: "Invoice 12", from: { name: "Ada", address: "ada@fake.test" } }));
  let offline = false;
  let holding = false;
  let atTheDoor!: () => void;
  const reachedTheDoor = new Promise<void>((r) => { atTheDoor = r; });
  let openTheDoor!: () => void;
  const doorOpened = new Promise<void>((r) => { openTheDoor = r; });
  const deps: MobileEngineDeps = {
    openExecutor: world.open,
    deleteDatabase: world.drop,
    uuid,
    fetch: async (url, init) => {
      if (offline) throw new TypeError("Network request failed");
      if (holding && /^\/drafts\/[^/]+\/send$/.test(new URL(url).pathname)) {
        atTheDoor();
        await doorOpened;
      }
      return fetch(url, init);
    },
  };
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const toasts: string[] = [];
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid, zone: "UTC",
  });
  return {
    fake, origin, deps, ...boot, actions, toasts,
    tunnel: (on: boolean) => { offline = on; },
    holdTheSend: () => { holding = true; return { reachedTheDoor, openTheDoor }; },
  };
}

/** Every `POST /drafts/:id/send` the server was asked to make, with the key it carried. */
const sendRequests = (fake: ReturnType<typeof mailServer>) =>
  fake.seen.filter((r) => r.method === "POST" && /^\/drafts\/[^/]+\/send$/.test(r.url));

/** The composer's press, exactly as the sheet takes it: decide, ask, then say or close. */
async function pressCancel(
  live: Awaited<ReturnType<typeof scene>>,
  key: string | null,
  alreadySent = false,
): Promise<"close" | "already_sent" | "unknown"> {
  if (cancelAct({ phase: "queued", key, alreadySent }) === "close") return "close";
  return afterWithdraw(await live.actions.withdrawSend(key!));
}

describe("a message the person cancelled is never sent, and never sent twice", () => {
  it("CONTROL 1 — offline, Cancel, compose again, reconnect: ONE delivery under ONE key", async () => {
    const live = await scene();
    live.tunnel(true);

    const first = await live.actions.sendReply("m-1", "on its way", false, null);
    expect(first.outcome).toBe("queued");
    expect(first.key).toBeTruthy();

    // THE PRESS, with no network: the attempt may have left (this phone shares no disk to claim on),
    // so the server's answer is owed and the sheet says it could not reach it — never "withdrawn".
    expect(await pressCancel(live, first.key ?? null)).toBe("unknown");
    expect(live.engine.pendingMutations(), "the cancelled send is still on the queue").toHaveLength(0);

    // …and the person writes it again and sends.
    const second = await live.actions.sendReply("m-1", "on its way", false, null);
    expect(second.outcome).toBe("queued");

    live.tunnel(false);
    await flushQueued(live.engine, live.actions.releaseConfirmed);

    const out = sendRequests(live.fake);
    expect(
      { sends: out.length, keys: new Set(out.map((r) => r.key)).size, delivered: live.fake.deliveries().length },
      "the correspondent received it twice",
    ).toEqual({ sends: 1, keys: 1, delivered: 1 });
    // The one that went is the one the person actually composed second.
    expect(out[0]!.key).toBe(second.key ?? out[0]!.key);
    live.store.close();
    live.fake.server.close();
  });

  it("CONTROL 1b — the app was KILLED instead: the restored intent's key is resumed, not re-minted", async () => {
    const live = await scene();
    live.tunnel(true);
    const first = await live.actions.sendReply("m-1", "on its way", false, null);
    expect(first.outcome).toBe("queued");

    /* NO CANCEL AND NO WITHDRAWAL — the composer died with the process, so the queued row is
       still there when the person opens the reply again. The only thing between this press and
       a second copy is that the send resumes the INTENT's key instead of minting a new one. */
    const second = await live.actions.sendReply("m-1", "on its way", false, null);
    expect(second.outcome).toBe("queued");
    expect(
      new Set(live.engine.pendingMutations().map((p) => p.key)).size,
      "the second press minted a second reservation",
    ).toBe(1);

    live.tunnel(false);
    await flushQueued(live.engine, live.actions.releaseConfirmed);
    expect(live.fake.deliveries(), "one intent delivered twice").toHaveLength(1);
    live.store.close();
    live.fake.server.close();
  });

  it("CONTROL 2 — the positive: an ordinary send goes, and an uncancelled queued send goes once", async () => {
    const live = await scene();
    // Online, nothing queued, nothing cancelled: the ordinary press.
    expect((await live.actions.sendReply("m-1", "straight out", false, null)).outcome).toBe("sent");
    expect(live.fake.deliveries()).toHaveLength(1);

    // And a send the person did NOT cancel still leaves on the reconnect — the fix may not
    // swallow the queue it is there to make cancellable.
    live.tunnel(true);
    expect((await live.actions.sendReply("m-1", "the one after", false, null)).outcome).toBe("queued");
    live.tunnel(false);
    await flushQueued(live.engine, live.actions.releaseConfirmed);
    expect(live.fake.deliveries(), "an uncancelled queued send was swallowed").toHaveLength(2);
    live.store.close();
    live.fake.server.close();
  });

  it("CONTROL 3 — Cancel after the wire took it says so, withdraws nothing, and it lands once", async () => {
    const live = await scene();
    live.tunnel(true);
    const queued = await live.actions.sendReply("m-1", "too late for this", false, null);
    expect(queued.outcome).toBe("queued");

    // The reconnect flush picks it up and the send request is held AT THE DOOR: on the wire,
    // unanswered — the one moment at which a cancellation is a promise nobody can keep.
    const door = live.holdTheSend();
    live.tunnel(false);
    const flushing = flushQueued(live.engine, live.actions.releaseConfirmed);
    await door.reachedTheDoor;

    expect(await pressCancel(live, queued.key ?? null)).toBe("already_sent");

    door.openTheDoor();
    await flushing;
    expect(live.fake.deliveries(), "the message the composer said was sent did not go").toHaveLength(1);
    expect(sendRequests(live.fake)).toHaveLength(1);
    live.store.close();
    live.fake.server.close();
  });

  it("CONTROL 5 — a row waiting in the flush's batch is withdrawn and never sent", async () => {
    const live = await scene();
    live.tunnel(true);
    // TWO intents on the queue: a reply and a forward of the same message. The flush takes each
    // entry off the queue only at its own turn (`takeTurn`), so while the first is on the wire the
    // second is still queued and Cancel withdraws it there. The read on the line before the wire
    // is watched by `repress-one-delivery.test.ts` (a fresh press waiting its gate turn).
    const reply = await live.actions.sendReply("m-1", "the one that goes", false, null);
    const fwd = await live.actions.sendForward("m-1", [{ name: "Bo", address: "bo@fake.test" }], "and this one", null);
    expect([reply.outcome, fwd.outcome]).toEqual(["queued", "queued"]);
    expect(live.engine.pendingMutations()).toHaveLength(2);

    const door = live.holdTheSend();
    live.tunnel(false);
    const flushing = flushQueued(live.engine, live.actions.releaseConfirmed);
    await door.reachedTheDoor;

    // The batch tail is still a queued verb, and the press withdraws it.
    expect(live.engine.pendingMutations().map((p) => p.key)).toEqual([fwd.key]);
    expect(await live.actions.withdrawSend(fwd.key!)).toBe("withdrawn");

    door.openTheDoor();
    await flushing;
    expect(
      live.fake.deliveries(),
      "the withdrawn intent was sent anyway, from inside a batch",
    ).toEqual([reply.key]);
    live.store.close();
    live.fake.server.close();
  });

  it("CONTROL 4 — a withdrawn row survives a restart as withdrawn, and no boot sends it", async () => {
    const live = await scene();
    live.tunnel(true);
    const queued = await live.actions.sendReply("m-1", "cancelled before the signal came back", false, null);
    expect(queued.outcome).toBe("queued");
    // No network: the server cannot be asked about an attempt that may have left, so the Cancel is owed.
    expect(await live.actions.withdrawSend(queued.key!)).toBe("unknown");

    // THE MARK IS ON DISK, on the row itself — not a memory flag that dies with the process — with its debt.
    const rows = live.store.entries<{ key?: string; withdrawn?: boolean; withdrawOwed?: boolean }>(OUTBOX_TYPE)
      .filter((e) => e.entity.key === queued.key);
    expect(rows, "the withdrawal wrote nothing durable").toHaveLength(1);
    expect([rows[0]!.entity.withdrawn, rows[0]!.entity.withdrawOwed]).toEqual([true, true]);

    // THE RELAUNCH. Same store, same account: the row is read back as withdrawn and dropped
    // rather than queued, so the boot that follows a cancel has nothing to deliver.
    live.store.close();
    // The signal is back on the relaunch — a restart that stayed offline would prove nothing
    // about whether a boot with a wire would have sent it.
    live.tunnel(false);
    const again = await bootEngine(live.deps, { origin: live.origin, token: "tok-1", accountId: "acct-1" });
    if (again.kind !== "ready") throw new Error("boot refused");
    expect(
      again.engine.pendingMutations().filter((p) => p.key === queued.key),
      "the relaunch re-queued a send the person cancelled",
    ).toHaveLength(0);
    await again.verifyIdentity();
    await again.engine.start();
    await flushQueued(again.engine, liveActions({ engine: again.engine, toast: () => undefined, zone: "UTC" }).releaseConfirmed);
    expect(live.fake.deliveries(), "a cancelled send was delivered by a later boot").toHaveLength(0);
    expect(sendRequests(live.fake)).toHaveLength(0);
    // The relaunch asked the withdraw the last session owed, and the server tombstoned the key.
    expect(live.fake.withdrawnKeys()).toEqual([queued.key]);
    again.store.close();
    live.fake.server.close();
  });
});

describe("the intent, and the decisions the composer takes", () => {
  it("one intent per message and per verb — a reply and a forward of one message are not the same send", () => {
    expect(sendIntentOf({ kind: "mail_send", inReplyTo: "m-1", body: "x" } as never)).toBe("reply:m-1");
    expect(sendIntentOf({ kind: "mail_send", inReplyTo: null, forwardOf: "m-1", body: "x" } as never)).toBe("fwd:m-1");
    // A send this app cannot name that way mints a fresh key rather than guessing a shared one.
    expect(sendIntentOf({ kind: "mail_send", inReplyTo: null, body: "x" } as never)).toBeNull();
    // Not every verb is a send.
    expect(sendIntentOf({ kind: "mark_seen", messageIds: ["m-1"], unread: false } as never)).toBeNull();
  });

  it("closing over a queued send withdraws; every other close is just a close", () => {
    expect(cancelAct({ phase: "queued", key: "k-1", alreadySent: false })).toBe("withdraw");
    expect(cancelAct({ phase: "idle", key: null, alreadySent: false })).toBe("close");
    expect(cancelAct({ phase: "sending", key: "k-1", alreadySent: false })).toBe("close");
    // A composer locked on an unverified send has nothing to withdraw — the server could not
    // say whether the message left, and "cancelled" is not a claim this device can make.
    expect(cancelAct({ phase: "unverified", key: "k-1", alreadySent: false })).toBe("close");
    // No key, nothing to name: the close cannot withdraw a send it cannot identify.
    expect(cancelAct({ phase: "queued", key: null, alreadySent: false })).toBe("close");
    // The second press, after the answer was read.
    expect(cancelAct({ phase: "queued", key: "k-1", alreadySent: true })).toBe("close");
  });

  it("the sheet's restated answers ARE the engine's — assignable both ways, or this will not compile", () => {
    // `src/ui` may not import the engine package (`privacy.test.ts` confines it), so the union is
    // restated there. Both directions, because either one alone admits a drift: a member the
    // engine gained that the sheet cannot decide, or one the sheet decides that never arrives.
    const asEngine: (a: WithdrawAnswer) => WithdrawOutcome = (a) => a;
    const asSheet: (a: WithdrawOutcome) => WithdrawAnswer = (a) => a;
    expect(asEngine("on_the_wire")).toBe("on_the_wire");
    expect(asSheet("withdrawn")).toBe("withdrawn");
  });

  it("only the on-the-wire answer keeps the composer open with a sentence", () => {
    expect(afterWithdraw("withdrawn")).toBe("close");
    expect(afterWithdraw("gone")).toBe("close");
    expect(afterWithdraw("on_the_wire")).toBe("already_sent");
    // Nothing cancelled: on the phone, the server not answering for a send that may have left.
    expect(afterWithdraw("unknown")).toBe("unknown");
  });

  it("THE WIRING — the sheet takes these decisions on every road out, and renders the sentence", () => {
    expect(COMPOSER).toContain('from "./send-cancel"');
    // Every close goes through the one function that withdraws: the button, the scrim behind
    // the sheet, and the platform back gesture. A bare `onClose` on any of the three is the
    // defect coming back through the door it was not watched on.
    expect(COMPOSER).toContain("onRequestClose={closeComposer}");
    expect(COMPOSER.match(/onPress=\{closeComposer\}/g) ?? [], "a close that does not withdraw").toHaveLength(2);
    expect(COMPOSER).toContain("cancelAct({ phase, key: queuedKey, alreadySent })");
    // The verdict rides beside the answer since `send-cancel-says-it-went.test.ts`: a `gone`
    // key that the flush CONFIRMED says the message went rather than closing in silence.
    expect(COMPOSER).toContain("afterWithdraw(await w.actions.withdrawSend(key), w.sendOutcome(key))");
    // And the refused cancel is SAID, in place, rather than looking like a broken button.
    expect(COMPOSER).toContain("Copy.replyAlreadySent");
    expect(Copy.replyAlreadySent).toContain("Too late to cancel");
    // On its way covers a delivered send AND one still being handed over: never "has been sent".
    expect(Copy.replyAlreadySent).toContain("already on its way");
    // The Cancel the server could not answer is said too, never a silent press.
    expect(COMPOSER).toContain("else setCancelUnreachable(true)");
    expect(COMPOSER).toContain("Copy.replyCancelUnreachable");
    expect(Copy.replyCancelUnreachable).toContain("Couldn't reach the server to cancel");
  });
});
