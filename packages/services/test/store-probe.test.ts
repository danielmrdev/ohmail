import { describe, it, expect } from "vitest";
import { storeProbe, STORE_PROBE_RETRY_MS } from "../src/store-probe.js";

/**
 * A fact about the store, per handle: a yes holds, a no or a failed probe is asked again once the
 * retry window has passed, and callers asking during a probe share it. A pooled handle lives as
 * long as its server instance, so a no that never expired would hide a later install for good.
 */
describe("storeProbe", () => {
  function counted(answers: Array<boolean | Error>) {
    let asked = 0;
    const ask = async (): Promise<boolean> => {
      const a = answers[Math.min(asked, answers.length - 1)]!;
      asked++;
      if (a instanceof Error) throw a;
      return a;
    };
    return { ask, asked: () => asked };
  }

  it("a yes is asked once per handle and held", async () => {
    let t = 0;
    const probe = storeProbe({ now: () => t });
    const h = {};
    const q = counted([true]);
    expect(await probe(h, q.ask)).toBe(true);
    t += STORE_PROBE_RETRY_MS * 10;
    expect(await probe(h, q.ask)).toBe(true);
    expect(q.asked()).toBe(1);
  });

  it("a no is believed inside the window and asked again after it", async () => {
    let t = 0;
    const probe = storeProbe({ now: () => t, retryMs: 1_000 });
    const h = {};
    const q = counted([false, true]);
    expect(await probe(h, q.ask)).toBe(false);
    t += 999;
    expect(await probe(h, q.ask)).toBe(false);
    expect(q.asked()).toBe(1);
    t += 2;
    expect(await probe(h, q.ask)).toBe(true);
    expect(q.asked()).toBe(2);
  });

  it("a failed probe is a no, asked again after the window", async () => {
    let t = 0;
    const probe = storeProbe({ now: () => t, retryMs: 1_000 });
    const h = {};
    const q = counted([new Error("connection reset"), true]);
    expect(await probe(h, q.ask)).toBe(false);
    t += 1_001;
    expect(await probe(h, q.ask)).toBe(true);
  });

  it("a probe that throws before it is asked is a no too", async () => {
    const probe = storeProbe();
    expect(await probe({}, () => { throw new Error("no such handle"); })).toBe(false);
  });

  it("callers during a probe share it, and each handle has its own answer", async () => {
    const probe = storeProbe();
    const [a, b] = [{}, {}];
    const qa = counted([true]);
    const qb = counted([false]);
    const answers = await Promise.all([probe(a, qa.ask), probe(a, qa.ask), probe(b, qb.ask), probe(b, qb.ask)]);
    expect(answers).toEqual([true, true, false, false]);
    expect(qa.asked()).toBe(1);
    expect(qb.asked()).toBe(1);
  });
});
