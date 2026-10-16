import { describe, expect, it } from "vitest";
import {
  createSessionBodyDoor, narrowOlderBody, olderBodyVia,
  type SessionBodyHeld,
} from "../src/session-body.js";

/**
 * THE CONTENT DOOR'S ON-DEMAND ARM — the mechanics both binds (the reach-past door, the junk
 * window) used to carry as inline copies, pinned once at the module that now owns them. Each
 * rule below was a review-caught or measured finding in one of the two copies; the consumers'
 * own suites prove their renderings, this file proves the shared machine.
 */

/** A hand-driven ask: resolve/reject each dispatch from the test, in any order. */
function askRig<O>() {
  const pending: Array<{ resolve: (o: O) => void; reject: (e: unknown) => void }> = [];
  const ask = (): Promise<O> =>
    new Promise<O>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  return { ask, pending };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function rig(opts: { reopenFailed?: boolean } = {}) {
  const changes: Array<ReadonlyMap<string, SessionBodyHeld<string>>> = [];
  const door = createSessionBodyDoor<string>({
    onChange: (m) => changes.push(m),
    ...(opts.reopenFailed !== undefined ? { reopenFailed: opts.reopenFailed } : {}),
  });
  return { door, changes };
}

describe("createSessionBodyDoor — single-flight and the session cache", () => {
  it("one open dispatches once; a second open of the same key dispatches nothing", async () => {
    const { door } = rig();
    const { ask, pending } = askRig<string>();
    expect(door.open("k", ask)).toBe(true);
    expect(door.open("k", ask)).toBe(false);
    expect(pending.length).toBe(1);
    expect(door.held("k")).toEqual({ phase: "loading", attempt: 1 });
    pending[0]!.resolve("the body");
    await tick();
    expect(door.held("k")).toEqual({ phase: "settled", outcome: "the body" });
    // A settled answer is final for the session — even a human retry re-asks nothing.
    expect(door.open("k", ask)).toBe(false);
    expect(door.open("k", ask, { retry: true })).toBe(false);
    expect(pending.length).toBe(1);
  });

  it("a human retry REPLACES a hung ask, and the superseded ask's late rejection is dropped", async () => {
    const { door } = rig();
    const { ask, pending } = askRig<string>();
    door.open("k", ask);
    // The hung first ask still reads `loading` — the press must dispatch anyway…
    expect(door.open("k", ask, { retry: true })).toBe(true);
    expect(pending.length).toBe(2);
    // …under a NEW attempt, so a preview can remount its stall anatomy per try.
    expect(door.held("k")).toEqual({ phase: "loading", attempt: 2 });
    pending[1]!.resolve("the retry's answer");
    await tick();
    expect(door.held("k")).toEqual({ phase: "settled", outcome: "the retry's answer" });
    // The hung first ask dies late; its failure must not overwrite the delivered body.
    pending[0]!.reject(new Error("first ask died"));
    await tick();
    expect(door.held("k")).toEqual({ phase: "settled", outcome: "the retry's answer" });
  });

  it("a superseded ask's late SUCCESS is dropped too — the newer ask owns the key", async () => {
    const { door } = rig();
    const { ask, pending } = askRig<string>();
    door.open("k", ask);
    door.open("k", ask, { retry: true });
    pending[0]!.resolve("the stale answer");
    await tick();
    // Still the retry's loading — the stale answer landed after its generation was taken over.
    expect(door.held("k")).toEqual({ phase: "loading", attempt: 2 });
    pending[1]!.resolve("the live answer");
    await tick();
    expect(door.held("k")).toEqual({ phase: "settled", outcome: "the live answer" });
  });

  it("reopenFailed: false — a failed key re-asks only on the human press", async () => {
    const { door } = rig({ reopenFailed: false });
    const { ask, pending } = askRig<string>();
    door.open("k", ask);
    pending[0]!.reject(new Error("no"));
    await tick();
    expect(door.held("k")).toEqual({ phase: "failed" });
    // The automatic open fires on every render of a reach-past row: admitting it here would
    // be a billed retry loop with nobody behind it.
    expect(door.open("k", ask)).toBe(false);
    expect(door.open("k", ask, { retry: true })).toBe(true);
    expect(pending.length).toBe(2);
  });

  it("reopenFailed: true — the junk policy: returning to a failed row re-asks it", async () => {
    const { door } = rig({ reopenFailed: true });
    const { ask, pending } = askRig<string>();
    door.open("k", ask);
    pending[0]!.reject(new Error("no"));
    await tick();
    expect(door.open("k", ask)).toBe(true);
    expect(pending.length).toBe(2);
  });

  it("keys are independent, and each key numbers its own attempts", () => {
    const { door } = rig();
    const { ask } = askRig<string>();
    door.open("a", ask);
    door.open("b", ask);
    door.open("b", ask, { retry: true });
    expect(door.held("a")).toEqual({ phase: "loading", attempt: 1 });
    expect(door.held("b")).toEqual({ phase: "loading", attempt: 2 });
  });

  it("a synchronous throw from the ask escapes with the session unchanged", () => {
    const { door, changes } = rig();
    expect(() =>
      door.open("k", () => {
        throw new Error("sync refusal");
      }),
    ).toThrow("sync refusal");
    expect(door.held("k")).toBeUndefined();
    expect(changes.length).toBe(0);
  });

  it("every transition publishes a NEW immutable snapshot — safe to hand to React state", async () => {
    const { door, changes } = rig();
    const { ask, pending } = askRig<string>();
    door.open("k", ask);
    pending[0]!.resolve("x");
    await tick();
    expect(changes.length).toBe(2); // loading, then settled
    expect(changes[0]).not.toBe(changes[1]);
    expect(changes[1]).toBe(door.snapshot());
    expect(changes[0]!.get("k")).toEqual({ phase: "loading", attempt: 1 });
    expect(changes[1]!.get("k")).toEqual({ phase: "settled", outcome: "x" });
  });
});

describe("narrowOlderBody — the stored-body wire's forward-compatible reading", () => {
  it("reads the full shape verbatim", () => {
    expect(
      narrowOlderBody({
        text: "t", html: "<p>h</p>", loadedRemoteContent: true,
        unsubscribe: "one_click", unsubscribeUrl: "https://u.invalid/x", withheld: "storage_cap",
      }),
    ).toEqual({
      kind: "ok", text: "t", html: "<p>h</p>", loadedRemoteContent: true,
      unsubscribe: "one_click", unsubscribeUrl: "https://u.invalid/x", withheld: "storage_cap",
    });
  });

  it("a field the server stops sending, or sends outside the closed set, degrades — never undefined", () => {
    expect(narrowOlderBody({})).toEqual({
      kind: "ok", text: "", html: null, loadedRemoteContent: false,
      unsubscribe: "no_header", unsubscribeUrl: null, withheld: null,
    });
    expect(narrowOlderBody({ unsubscribe: "brand_new_kind", withheld: "brand_new_reason" })).toMatchObject({
      unsubscribe: "no_header", withheld: null,
    });
  });
});

describe("olderBodyVia — the fetch-shaped transport's status contract", () => {
  const response = (status: number, body?: unknown): Response =>
    new Response(body === undefined ? null : JSON.stringify(body), { status });

  it("404 and 410 are the terminal `gone`, never a rejection", async () => {
    for (const status of [404, 410]) {
      const wire = olderBodyVia(async () => response(status));
      expect(await wire.body("m1")).toEqual({ kind: "gone" });
    }
  });

  it("a refusal rejects with the engine's own sentence when one was carried", async () => {
    const wire = olderBodyVia(async () => response(503, { error: { message: "the engine is busy" } }));
    await expect(wire.body("m1")).rejects.toThrow("the engine is busy");
  });

  it("a refusal with no JSON rejects with the status", async () => {
    const wire = olderBodyVia(async () => new Response("not json", { status: 500 }));
    await expect(wire.body("m1")).rejects.toThrow("the mail engine answered 500");
  });

  it("an OK answer is narrowed, and the path addresses the one stored-body route", async () => {
    let asked: string | undefined;
    const wire = olderBodyVia(async (path) => {
      asked = path;
      return response(200, { text: "t" });
    });
    expect(await wire.body("id with spaces")).toMatchObject({ kind: "ok", text: "t" });
    expect(asked).toBe("/messages/id%20with%20spaces/body");
  });
});
