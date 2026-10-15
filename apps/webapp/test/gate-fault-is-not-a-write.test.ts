/**
 * THE GATE NEVER ROUTES A FAULT TO A WRITE (SESSIONS-023).
 *
 * The reported "Please sign in again" card was the resume splash's loop guard, reached because the
 * edge answered a busy API with the splash: a rotation spent, a reload, the same busy probe, the
 * card. A fault at the probe now serves the app (its own check retries and keeps the warm mirror),
 * and a browser over the burst cap is served the app WITHOUT a probe. `resume` stays for the two
 * things a refresh can fix: no access cookie, or a CODED 401 on one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSurface } from "../app/session-gate.js";

const ARMED = "https://api.ohmail.app";
const TOKEN = "a".repeat(43);

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
/** The API's busy answer as `withErrorEnvelope` sends it. */
const db503 = (): Response =>
  json({ error: { code: "db_busy", retryable: true, message: "busy" } }, 503, { "retry-after": "5" });
const coded401 = (): Response => json({ error: { code: "unauthorized", message: "authentication required" } }, 401);

/** A fetch that records every URL it was asked for and answers with `answer`. */
function wire(answer: () => Response) {
  const calls: string[] = [];
  const impl = (async (u: unknown) => { calls.push(String(u)); return answer(); }) as unknown as typeof fetch;
  return { impl, calls, refreshes: () => calls.filter((u) => u.includes("/auth/refresh")).length };
}

const noNetwork = (() => { throw new Error("the gate must not fetch on this branch"); }) as unknown as typeof fetch;

describe("(a) a busy API at the probe serves the mailbox, and spends no rotation", () => {
  it("two loads, two 503s at the probe — the app both times, zero refreshes", async () => {
    const w = wire(db503);
    for (const load of [1, 2]) {
      const surface = await resolveSurface({
        sessionToken: TOKEN, resumeMarker: true, search: "", apiOrigin: ARMED, fetchImpl: w.impl,
      });
      expect(surface, `load ${load}: a busy database routed a live session to the splash`).toBe("app");
    }
    expect(w.calls.length, "each load asks the session door once").toBe(2);
    expect(w.refreshes(), "the gate spent a rotation").toBe(0);
  });

  it("a timeout, a network failure and a 429 answer the same", async () => {
    const hang = (async (_u: unknown, init?: RequestInit) => {
      await new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      return new Response();
    }) as unknown as typeof fetch;
    const dead = (() => { throw new TypeError("network"); }) as unknown as typeof fetch;
    const busy = wire(() => json({ error: { code: "rate_limited" } }, 429, { "retry-after": "5" }));
    for (const [label, impl] of [["timeout", hang], ["network", dead], ["429", busy.impl]] as const) {
      expect(await resolveSurface({
        sessionToken: TOKEN, resumeMarker: true, search: "", apiOrigin: ARMED, fetchImpl: impl, timeoutMs: 20,
      }), label).toBe("app");
    }
  });

  it("THE CONTROL — without the marker a fault is still the landing, never the app", async () => {
    // No standing to assume a session: a sprayer of cookie-shaped values gets the landing.
    expect(await resolveSurface({
      sessionToken: TOKEN, resumeMarker: false, search: "", apiOrigin: ARMED, fetchImpl: wire(db503).impl,
    })).toBe("marketing");
  });
});

describe("resume is kept for what a refresh can fix", () => {
  it("no access cookie with the marker — resume, and no probe", async () => {
    expect(await resolveSurface({
      sessionToken: null, resumeMarker: true, search: "", apiOrigin: ARMED, fetchImpl: noNetwork,
    })).toBe("resume");
  });

  it("a CODED 401 on a present token — resume; an uncoded one is a platform — the app", async () => {
    expect(await resolveSurface({
      sessionToken: TOKEN, resumeMarker: true, search: "", apiOrigin: ARMED, fetchImpl: wire(coded401).impl,
    })).toBe("resume");
    const platform = wire(() => new Response("<html>401</html>", { status: 401, headers: { "content-type": "text/html" } }));
    expect(await resolveSurface({
      sessionToken: TOKEN, resumeMarker: true, search: "", apiOrigin: ARMED, fetchImpl: platform.impl,
    })).toBe("app");
  });
});

describe("(e) a browser over the burst cap keeps its session", () => {
  // COUNTED, not thrown: a throwing fetch lands in the fault arm, which is also "app", so a
  // deleted throttle would pass a throw-on-call stub. The number of asks is the claim.
  it("throttled with a token and the marker — the app, with no probe", async () => {
    const w = wire(db503);
    expect(await resolveSurface({
      sessionToken: TOKEN, throttled: true, resumeMarker: true, search: "", apiOrigin: ARMED, fetchImpl: w.impl,
    })).toBe("app");
    expect(w.calls, "a throttled browser was probed").toEqual([]);
  });

  it("throttled without the marker — the landing, with no probe", async () => {
    const w = wire(db503);
    expect(await resolveSurface({
      sessionToken: TOKEN, throttled: true, resumeMarker: false, search: "", apiOrigin: ARMED, fetchImpl: w.impl,
    })).toBe("marketing");
    expect(w.calls).toEqual([]);
  });

  describe("through the real middleware", () => {
    const priorFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = priorFetch;
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("31 loads in ten seconds from one address — every one is the app, the 31st without a probe", async () => {
      vi.stubEnv("TF_API_ORIGIN", ARMED);
      vi.resetModules();
      const calls: string[] = [];
      globalThis.fetch = vi.fn(async (u: unknown) => {
        calls.push(String(u));
        return json({ scope: "full", user: { userId: "usr_1", accountId: "acct_1" } }, 200);
      }) as unknown as typeof globalThis.fetch;
      const { middleware } = await import("../middleware.js");
      const { NextRequest } = await import("next/server");
      const load = () => middleware(new NextRequest("https://ohmail.app/", {
        headers: {
          host: "ohmail.app", "x-forwarded-for": "203.0.113.31",
          cookie: `tf_session=${TOKEN}; tf_resume=1; tf_owner=acct_1`,
        },
      }));
      const rewrites: string[] = [];
      for (let i = 0; i < 31; i += 1) {
        const res = await load();
        rewrites.push(res.headers.get("x-middleware-rewrite") ?? "none");
      }
      const probes = calls.filter((u) => u.includes("/auth/session")).length;
      expect(probes, "the cap must stop the 31st probe, and only that one").toBe(30);
      expect(calls.filter((u) => u.includes("/auth/refresh")).length).toBe(0);
      expect(rewrites.every((r) => r.endsWith("/mailbox")),
        `a fast browser was not served its mailbox: ${[...new Set(rewrites)].join(", ")}`).toBe(true);
    });
  });
});
