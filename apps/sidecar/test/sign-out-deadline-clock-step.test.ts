import { afterEach, describe, expect, it, vi } from "vitest";
import { deadlineIn, revokeHeldSession } from "../src/pair-undo.js";

/*
 * THE SIGN-OUT'S ONE DEADLINE UNDER A WALL CLOCK STEPPED BACK AN HOUR. The bearer door answers 401
 * after a moment, the clock steps back meanwhile, and the refresh door never answers: the second ask
 * reads what is left of the deadline, which is a monotonic instant, so the revoke ends on time.
 */
const HOUR = 60 * 60_000;
const realNow = Date.now.bind(Date);

afterEach(() => { vi.restoreAllMocks(); });

async function revokeAcrossAStep(stepMs: number): Promise<{ settled: boolean; ms: number }> {
  const skew = { ms: 0 };
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew.ms);
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path === "/auth/logout") {
      await new Promise((r) => setTimeout(r, 300));
      skew.ms -= stepMs;
      return new Response(null, { status: 401 });
    }
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
  }) as unknown as typeof fetch;
  const t = performance.now();
  const revoking = revokeHeldSession(fetchImpl, "https://host.test", { accessToken: "a", refreshToken: "r" }, deadlineIn(1_500));
  const late = new Promise<"late">((r) => { setTimeout(() => r("late"), 4_000).unref?.(); });
  const answer = await Promise.race([revoking, late]);
  return { settled: answer === false, ms: performance.now() - t };
}

describe("the sign-out deadline under a wall clock stepped back an hour", () => {
  it("the refresh door's ask ends at the deadline, not an hour later", async () => {
    const r = await revokeAcrossAStep(HOUR);
    expect(r.settled, "the revoke waited out the clock's step").toBe(true);
    expect(r.ms).toBeLessThan(2_500);
  });

  it("CONTROL: with no step the same revoke ends at the deadline", async () => {
    const r = await revokeAcrossAStep(0);
    expect(r.settled).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(1_400);
  });
});
