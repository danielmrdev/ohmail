/** @vitest-environment jsdom */
/**
 * A SIGN-IN THAT MINTED PAST A REFRESH DROPS THAT REFRESH'S LATE ANSWER. Only a browser with no
 * Web Locks reaches it: the ceremony waits `SETTLE_DEADLINE_MS` for the refresh, then proceeds, and
 * its mint aborts the refresh's request (outcome `superseded`); the server has already revoked the
 * previous session inside the mint. `navigator.locks` is deleted BY NAME, and the case asserts it
 * is gone, so the lock-less arm is what runs rather than whatever jsdom happens to ship.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.NEXT_PUBLIC_API_BASE = "/api";

const setJar = (csrf: string): void => { document.cookie = `tf_csrf=${csrf}; path=/`; };

/** A refresh request that answers only when told to, and rejects the way fetch does on abort. */
function heldRefresh(): { signal: () => AbortSignal | undefined; answer: (r: Response) => void } {
  let seen: AbortSignal | undefined;
  let answer: (r: Response) => void = () => {};
  vi.stubGlobal("fetch", vi.fn((_u: unknown, init?: { signal?: AbortSignal }) => new Promise<Response>((resolve, reject) => {
    seen = init?.signal;
    answer = resolve;
    seen?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  })));
  return { signal: () => seen, answer: (r) => answer(r) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, "locks");
  setJar("before");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the ceremony's mint supersedes a refresh still in flight", () => {
  it("no Web Locks: past the deadline the sign-in proceeds, and its mint aborts the refresh", async () => {
    expect("locks" in navigator, "the lock-less arm is not the one under test").toBe(false);
    const wire = heldRefresh();
    const { resumeSession, refreshSettled, withSessionCookieLock, lastRefreshOutcome, SETTLE_DEADLINE_MS } =
      await import("../app/session-refresh.js");
    const refresh = resumeSession();
    await vi.advanceTimersByTimeAsync(0);
    expect(wire.signal(), "the refresh never issued its request").toBeDefined();

    const settled = refreshSettled();
    await vi.advanceTimersByTimeAsync(SETTLE_DEADLINE_MS);
    await settled;
    const signedIn = await withSessionCookieLock(async () => { setJar("minted-by-the-sign-in"); return "signed in"; });

    expect(signedIn).toBe("signed in");
    expect(wire.signal()?.aborted, "the late refresh can still land after the sign-in").toBe(true);
    await expect(refresh).resolves.toBe("refused");
    expect(lastRefreshOutcome()).toBe("superseded");
  });

  it("control: a ceremony that minted nothing leaves the refresh to answer", async () => {
    expect("locks" in navigator).toBe(false);
    const wire = heldRefresh();
    const { resumeSession, withSessionCookieLock, lastRefreshOutcome } = await import("../app/session-refresh.js");
    const refresh = resumeSession();
    await vi.advanceTimersByTimeAsync(0);
    await withSessionCookieLock(async () => "no cookie written");
    expect(wire.signal()?.aborted).toBe(false);
    wire.answer(new Response(null, { status: 204 }));
    await expect(refresh).resolves.toBe("resumed");
    expect(lastRefreshOutcome()).toBe("minted");
  });
});
