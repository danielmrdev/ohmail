/**
 * THE DURABLE OUTBOX'S MOBILE HALF (INSTANT-ARCH stages 0–1) — measured on this app's OWN
 * engine composition, against a real loopback wire.
 *
 * Two options on `bootEngine`'s `new OhmailEngine({…})` carry the whole mobile half, and both
 * are hand-written into an object literal that no other suite reads:
 *
 *  · `engine.restoreOutbox()` is called AT BOOT rather than left to `hydrate()` — the store is
 *    loaded above the engine in this app's construction order, so the automatic restore that
 *    rides hydration never fires here, and the first frame after a kill must already hold the
 *    verbs the killed session never sent;
 *  · `outboxAutoReplay: false` — the HOST owns the replay, because this app routes every flush
 *    result into a sentence (`flushQueued` + the world layer's toasts) and the engine's own
 *    drive replay would settle those entries silently.
 *
 * Neither shows up anywhere else: delete the call or flip the flag and every other mobile,
 * engine and webapp suite stays green while the phone quietly loses a killed session's verbs
 * or stops speaking about them. That is the pull-doorbell defect's exact shape — one omission
 * in one object literal, live path only — so both are watched here.
 */
import { describe, expect, it } from "vitest";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };

const marks = (fake: ReturnType<typeof mailServer>) =>
  fake.seen.filter((r) => r.method === "PATCH" && r.url === "/messages");

describe("a killed session's verbs survive the kill — and the host replays them", () => {
  it("the boot re-arms the outbox BEFORE the first drive, and does not replay it itself", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addMessage(dto("m-1"));

    const first = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
    expect(first.kind).toBe("ready");
    if (first.kind !== "ready") return;
    await first.verifyIdentity();
    await first.engine.start();

    // A verb the wire refuses RETRYABLY: the intent is parked under its Idempotency-Key and
    // written to the store's outbox — a read marked on the train, with the signal gone.
    fake.failNextStatus("PATCH", "/messages", 503);
    const res = await first.engine.mutate({ kind: "mark_seen", messageIds: ["m-1"], unread: false });
    expect(res.status).toBe("queued");
    expect(first.engine.pendingMutations()).toHaveLength(1);
    const beforeKill = marks(fake).length;

    // The kill: the process goes away with the intent unsent. Nothing is flushed on the way out.
    first.store.close();

    const relaunched = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
    expect(relaunched.kind).toBe("ready");
    if (relaunched.kind !== "ready") return;

    /* THE FIRST FRAME. No `start()`, no drain, no network — `bootEngine` returned and the verb
       is already on the queue, because `restoreOutbox()` ran synchronously over the loaded
       store. Mutation-watched: deleting that call leaves this empty. */
    expect(
      relaunched.engine.pendingMutations(),
      "the relaunched boot lost the killed session's verb",
    ).toHaveLength(1);
    expect(relaunched.engine.pendingMutations()[0]!.mutation.kind).toBe("mark_seen");

    /* AND THE ENGINE DOES NOT SEND IT BY ITSELF. A whole drive runs; the restored entry stays
       exactly where it was, because this app turned the engine's own replay off and owns the
       sentence its outcome earns. Mutation-watched: `outboxAutoReplay: true` sends it here. */
    await relaunched.verifyIdentity();
    await relaunched.engine.start();
    expect(marks(fake).length, "the engine replayed the outbox behind the host's back").toBe(beforeKill);
    expect(relaunched.engine.pendingMutations()).toHaveLength(1);

    /* THE HOST'S REPLAY — what `state/live.ts#flushQueued` runs after every successful drain,
       and the one path whose results become sentences. */
    const settled = await relaunched.engine.flushPending();
    expect(settled).toHaveLength(1);
    expect(settled[0]!.status).toBe("confirmed");
    expect(marks(fake).length).toBe(beforeKill + 1);
    expect(relaunched.engine.pendingMutations()).toHaveLength(0);

    relaunched.store.close();
    fake.server.close();
  });
});
