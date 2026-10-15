/** @vitest-environment jsdom */
/**
 * ═══ EVERY WRITER OF THE SESSION COOKIES TAKES ONE LOCK ═══════════════════════════════════
 *
 * A refresh rewrites the whole cookie jar, and so does a sign-in. Until now only the refresh
 * asked for the origin-wide lock, and the sign-in ordered itself with `refreshSettled` — which
 * reads `inFlight`, a MODULE variable, and therefore cannot see a refresh running in another tab
 * of the same profile. Review's sequence: tab A begins a refresh; tab B waits for nothing because
 * its own `inFlight` is null, signs in; A's response lands afterwards and restores the previous
 * account or clears the session just created.
 *
 * jsdom has no `navigator.locks` — every other test in this repository therefore runs the
 * lock-less fallback and can say nothing about this — so the manager is supplied here. What is
 * pinned: the ceremony genuinely queues behind a holder, the queue has a floor so a wedged holder
 * cannot make signing in impossible, and a ceremony that FAILS is not silently run twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.NEXT_PUBLIC_API_BASE = "/api";

/** A minimal Web Locks manager: exclusive, FIFO, and honours an abort of the WAIT. */
function installLocks(): { held: () => number } {
  const queues = new Map<string, Array<() => void>>();
  const busy = new Set<string>();
  const request = async (
    name: string,
    opts: { mode?: string; signal?: AbortSignal },
    fn: () => Promise<unknown>,
  ): Promise<unknown> => {
    if (busy.has(name)) {
      await new Promise<void>((resolve, reject) => {
        const waiter = (): void => resolve();
        const queue = queues.get(name) ?? [];
        queue.push(waiter);
        queues.set(name, queue);
        opts.signal?.addEventListener("abort", () => {
          const q = queues.get(name) ?? [];
          const at = q.indexOf(waiter);
          if (at >= 0) q.splice(at, 1);
          reject(new DOMException("The request was aborted.", "AbortError"));
        });
      });
    }
    busy.add(name);
    try {
      return await fn();
    } finally {
      busy.delete(name);
      const next = (queues.get(name) ?? []).shift();
      next?.();
    }
  };
  Object.defineProperty(globalThis.navigator, "locks", {
    value: { request },
    configurable: true,
  });
  return { held: () => busy.size };
}

beforeEach(() => {
  vi.useFakeTimers();
  installLocks();
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, "locks");
  vi.restoreAllMocks();
});

describe("withSessionCookieLock", () => {
  it("queues a sign-in behind a refresh that is holding the lock", async () => {
    const { withSessionCookieLock } = await import("../app/session-refresh.js");
    const order: string[] = [];
    let releaseRefresh = (): void => {};

    // Another tab's refresh, holding the lock and not yet answered.
    const refresh = withSessionCookieLock(async () => {
      order.push("refresh:start");
      await new Promise<void>((r) => { releaseRefresh = r; });
      order.push("refresh:end");
      return "refreshed";
    });
    await Promise.resolve();
    expect(order, "the holder never started").toEqual(["refresh:start"]);

    const login = withSessionCookieLock(async () => {
      order.push("login");
      return "signed in";
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(order, "the sign-in ran while a refresh was still rewriting the jar")
      .toEqual(["refresh:start"]);

    releaseRefresh();
    await expect(refresh).resolves.toBe("refreshed");
    await expect(login).resolves.toBe("signed in");
    expect(order, "the sign-in did not write last").toEqual(["refresh:start", "refresh:end", "login"]);
  });

  it("refuses rather than writing behind a holder that is still going to write", async () => {
    const { withSessionCookieLock, SETTLE_DEADLINE_MS } = await import("../app/session-refresh.js");
    // A holder that never settles: a suspended tab, a connection the network stack has not given
    // up on. Without a floor the queue behind it is a sign-in that can never happen — the exact
    // deadlock this slice already had to fix once in `refreshSettled`.
    void withSessionCookieLock(() => new Promise<void>(() => {}));
    await Promise.resolve();

    let signedIn = false;
    const login = withSessionCookieLock(async () => { signedIn = true; return "signed in"; })
      .then(() => "wrote", (e: unknown) => e);

    await vi.advanceTimersByTimeAsync(SETTLE_DEADLINE_MS - 1_000);
    expect(signedIn, "the wait is decorative — the ceremony never queued at all").toBe(false);

    /* WAITING OUT AND WRITING ANYWAY is the original race with a delay in front of it: the holder
       is still going to write, this ceremony would write first, and the holder's answer would land
       last and undo it. The refusal is retryable and clears by itself when that tab settles. */
    await vi.advanceTimersByTimeAsync(2_000);
    const outcome = await login;
    expect(signedIn, "it wrote the session behind a holder that had not finished").toBe(false);
    expect((outcome as { code?: string }).code, "the refusal is not the retryable one a surface can render")
      .toBe("session_busy");
    expect((outcome as { retryable?: boolean }).retryable).toBe(true);
  });

  it("does not run a ceremony twice when the ceremony itself fails", async () => {
    const { withSessionCookieLock } = await import("../app/session-refresh.js");
    /* The failure mode this guards: the fallback path is entered whenever the LOCK could not be
       granted, and a naive implementation cannot tell that from `fn` having run and thrown. A
       password step re-run because the server said no is a second login attempt nobody asked
       for — and against a single-use login token it is a guaranteed second failure. */
    let ran = 0;
    const attempt = withSessionCookieLock(async () => {
      ran += 1;
      throw new Error("that password was wrong");
    });
    await expect(attempt).rejects.toThrow(/that password was wrong/);
    expect(ran, "a failed ceremony was silently retried").toBe(1);
  });

  /**
   * ═══ A CEREMONY THAT FAILS RECOVERABLY MUST NOT QUEUE BEHIND ITS OWN GRANT ═══════════════
   *
   * Web Locks are not reentrant. `auth.logout` takes this lock; `/auth/logout` was not in
   * `NEVER_REFRESH`, so a recoverable 401 or a stale-CSRF 403 sent `api()` into
   * `resumeSession()`, which asks for the SAME exclusive name from inside the callback still
   * holding it. The tab queues behind itself and never wakes, and the outer deadline cannot save
   * it: that timer bounds the wait FOR a grant, and this caller was granted long ago.
   *
   * What that costs is the whole point: the hang is INSIDE `signOut`, before the local wipe, the
   * `signed_out_pending` marker and the API block. Every remedy this slice added for a refused
   * sign-out sits behind that await, so the deadlock disabled all of them at once.
   *
   * Driven through the real client with the real lock manager installed — jsdom has none, so no
   * other test in this repository could have seen it.
   */
  it("a logout that comes back recoverable settles instead of hanging", async () => {
    const { auth, bindApiOwner } = await import("../app/api-client.js");
    bindApiOwner(null);
    const asked: string[] = [];
    const priorFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      asked.push(String(input));
      // The shape that used to deadlock: recoverable, so the old code went for a refresh.
      return new Response(JSON.stringify({ error: { code: "unauthorized", message: "no" } }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    try {
      /* SETTLES — as a rejection, which is the honest answer: the door's own coded 401, which
         `sign-out.ts` reads as its verdict on the family. What matters is that it RETURNS, so
         the caller's local cleanup can run. */
      const settled = await Promise.race([
        auth.logout().then(() => "resolved", () => "rejected"),
        (async () => { await vi.advanceTimersByTimeAsync(120_000); return "HUNG"; })(),
      ]);
      expect(settled, "the logout never returned — the local wipe and the block never run")
        .not.toBe("HUNG");
      // The press went to the BARE door the topology rewrites (`routes.mjs`), where the browser
      // sends `tf_refresh`, and only there.
      const { SIGN_OUT_PATH } = await import("../routes.mjs");
      expect(asked, "the sign-out asked somewhere the refresh cookie is not sent").toEqual([SIGN_OUT_PATH]);
      expect(asked.filter((u) => u.endsWith("/auth/refresh")),
        "a ceremony holding the lock asked for it a second time").toEqual([]);
    } finally {
      globalThis.fetch = priorFetch;
      bindApiOwner(null);
    }
  });

  it("still runs where there is no lock manager at all", async () => {
    const { withSessionCookieLock } = await import("../app/session-refresh.js");
    Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, "locks");
    // A hardened embedder, an opaque origin. The server's own grace window covers this, and a
    // ceremony that refused to run without a lock would be a worse product on those browsers.
    await expect(withSessionCookieLock(async () => "signed in")).resolves.toBe("signed in");
  });
});
