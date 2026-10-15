import { describe, expect, it } from "vitest";
import {
  MutationRejectedError, REASK_MAX, StoreTimelineWalker, createSessionReask, wireFailed,
  type OhmailEngine, type StoreReadSource,
} from "../src/index.js";
import { FakeStore, settle } from "./helpers/fake-store.js";

/**
 * After a connection drop History said the server did not answer until Try again,
 * while every request answered 200 again. A read the WIRE failed is asked again on each drain that
 * completes — the server answering again — at most REASK_MAX times per episode; a 401 stays the
 * session door's, any other status is an answer, and a drain that failed licenses nothing.
 */
type Adapter = Record<string, (...x: unknown[]) => Promise<unknown>>;

/** The store's two History doors, failing with `fail` while `down.on`. */
function breakable(fake: FakeStore, fail: () => unknown) {
  const a = fake.adapter as unknown as Adapter;
  const down = { on: true, asked: 0 };
  for (const k of ["listMessages", "timeline"]) {
    const real = a[k]!.bind(fake.adapter);
    a[k] = async (...x) => { down.asked += 1; if (down.on) throw fail(); return real(...x); };
  }
  return down;
}

function readOf(w: StoreTimelineWalker): StoreReadSource {
  return {
    subscribe: w.subscribe, cause: () => w.failureCause(), answered: () => w.state() === "ready",
    reask: () => w.start(), drains: w.drains,
  };
}

async function visit(fake: FakeStore) {
  const engine = await fake.engine();
  const w = new StoreTimelineWalker(engine);
  const rule = createSessionReask(null, readOf(w));
  rule.attach();
  w.start();
  for (let i = 0; i < 40 && w.state() !== "ready" && w.state() !== "unanswered"; i++) await settle();
  return { engine, w };
}

const drain = async (engine: OhmailEngine) => { await engine.syncOnce(); for (let i = 0; i < 20; i++) await settle(); };
const offline = () => new MutationRejectedError("network failure: TypeError: Failed to fetch", { code: "network", retryable: true });

describe("a History the wire failed is asked again when the server answers again", () => {
  it("the first drain that completes after the drop asks again, and the visit answers", async () => {
    const fake = new FakeStore(300, { mirror: 20 });
    const down = breakable(fake, offline);
    const { engine, w } = await visit(fake);
    expect(w.state(), "control: the drop reads as did-not-answer").toBe("unanswered");
    down.on = false;
    await drain(engine);
    expect(w.state()).toBe("ready");
    expect(w.total()).toBe(300);
  });

  it(`asks at most ${REASK_MAX} times in one episode, then waits for Try again`, async () => {
    const fake = new FakeStore(300, { mirror: 20 });
    const down = breakable(fake, offline);
    const { engine, w } = await visit(fake);
    const before = down.asked;
    for (let i = 0; i < REASK_MAX + 2; i++) await drain(engine);
    // Each re-ask is one visit start: the months and page one, two requests.
    expect((down.asked - before) / 2).toBe(REASK_MAX);
    expect(w.state()).toBe("unanswered");
    down.on = false;
    w.start();
    for (let i = 0; i < 20; i++) await settle();
    expect(w.state(), "the person's press still reaches the store").toBe("ready");
  });

  it("a drain that failed licenses nothing", async () => {
    const fake = new FakeStore(300, { mirror: 20 });
    const down = breakable(fake, offline);
    const { engine, w } = await visit(fake);
    const a = fake.adapter as unknown as Adapter;
    a.sync = async () => { throw offline(); };
    const before = down.asked;
    await engine.syncOnce().catch(() => undefined);
    for (let i = 0; i < 20; i++) await settle();
    expect(down.asked).toBe(before);
    expect(w.state()).toBe("unanswered");
  });

  it("a server that answered — a 503 with no offline code — is not asked again on a drain", async () => {
    const fake = new FakeStore(300, { mirror: 20 });
    const down = breakable(fake, () => new MutationRejectedError("unavailable", { status: 503, code: "internal", retryable: true }));
    const { engine, w } = await visit(fake);
    const before = down.asked;
    await drain(engine);
    expect(down.asked).toBe(before);
    expect(w.state()).toBe("unanswered");
  });
});

describe("wireFailed: the wire's failures, never an answer", () => {
  it.each([
    ["MutationRejectedError network", true],
    ["MutationRejectedError timeout", true],
    ["timeout", true],
    ["TypeError", true],
    ["AbortError", true],
    ["MutationRejectedError 503 offline_read_only", true],
    ["MutationRejectedError 401 unauthorized", false],
    ["MutationRejectedError 503 internal", false],
    ["MutationRejectedError 404 not_found", false],
    [null, false],
  ] as const)("%s → %s", (cause, want) => {
    expect(wireFailed(cause)).toBe(want);
  });
});
