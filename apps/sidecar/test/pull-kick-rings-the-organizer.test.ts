import { describe, expect, it } from "vitest";
import type { Route } from "@trafficflow/api/local";
import { withPullKick } from "../src/engine.js";

/**
 * A PRESS THAT ASKS FOR THE WIRE RINGS THE ORGANIZER IN THIS PROCESS. `POST /sync/pull` stamps a
 * request only the hosted worker reads; on the phone and the desktop the organizer is here, so a
 * standalone Move waited for the next poll. A 202 — and only a 202 — rings every runtime once.
 */
describe("withPullKick", () => {
  const answered = (status: number): Route => ({
    method: "POST",
    pattern: "/sync/pull",
    cost: "work",
    relay: true,
    handler: async () => new Response("{}", { status, headers: { "content-type": "application/json" } }),
  });
  const press = async (route: Route): Promise<number> =>
    (await route.handler(new Request("http://local/sync/pull", { method: "POST" }), {} as never, {})).status;

  it("a 202 rings every runtime once; a refusal rings none", async () => {
    const rung: string[] = [];
    const runtimes = [{ ring: () => { rung.push("a"); } }, { ring: () => { rung.push("b"); } }];
    for (const status of [202, 202]) {
      const [wrapped] = withPullKick([answered(status)], () => runtimes);
      expect(await press(wrapped!)).toBe(status);
    }
    expect(rung, "two presses, two runtimes").toEqual(["a", "b", "a", "b"]);
    for (const status of [401, 409, 502]) {
      const [wrapped] = withPullKick([answered(status)], () => runtimes);
      expect(await press(wrapped!)).toBe(status);
    }
    expect(rung, "a refused press rang the organizer").toHaveLength(4);
  });

  /* A PRESS NAMES ITS MAILBOX and only that runtime rings (REVIEW-026-PHONE-SAYS-EVERY-PRESS-2 L1);
     a pull naming none — pull-to-refresh — rings them all, and a malformed body is "none". */
  it("a pull naming a mailbox rings only that runtime", async () => {
    const rung: string[] = [];
    const rt = (id: string) => ({ ring: () => { rung.push(id); } });
    const all = [rt("a"), rt("b")];
    const [wrapped] = withPullKick([answered(202)], () => all, (id) => (id === "a" || id === "b" ? rt(id) : undefined));
    const named = (body: string) => wrapped!.handler(
      new Request("http://local/sync/pull", { method: "POST", body, headers: { "content-type": "application/json" } }), {} as never, {});
    await named(JSON.stringify({ mailboxIds: ["b"] }));
    expect(rung).toEqual(["b"]);
    await named(JSON.stringify({ mailboxIds: ["elsewhere"] }));
    expect(rung, "a pull about another mailbox rang this install").toEqual(["b"]);
    await named("not json");
    expect(rung).toEqual(["b", "a", "b"]);
  });

  it("with no runtime it answers as the route did and rings nothing", async () => {
    const [wrapped] = withPullKick([answered(202)], () => []);
    expect(await press(wrapped!)).toBe(202);
  });

  it("wraps the pull route alone; every other route passes through untouched", () => {
    const other: Route = { ...answered(202), pattern: "/sync/snapshot" };
    const get: Route = { ...answered(202), method: "GET" };
    const [same, sameGet] = withPullKick([other, get], () => [{ ring: () => { throw new Error("rung"); } }]);
    expect(same).toBe(other);
    expect(sameGet).toBe(get);
  });
});
