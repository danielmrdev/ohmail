import { describe, it, expect } from "vitest";
import { createApp, csrfTokenFor, jsonResponse, type Route } from "@trafficflow/api";
import { ServiceError } from "@trafficflow/services";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

// A handler that echoes the resolved session so we can assert what withSession attached.
const echoSession: Route["handler"] = async (_req, deps) =>
  jsonResponse({ via: deps.session?.via ?? null, accountId: deps.session?.accountId ?? null });

describe("withErrorEnvelope", () => {
  const routes: Route[] = [
    { method: "GET", pattern: "/boom-service", options: { public: true }, handler: async () => { throw new ServiceError("conflict", 409, "x"); } },
    { method: "GET", pattern: "/boom-plain", options: { public: true }, handler: async () => { throw new Error("kaboom"); } },
  ];

  it("maps a ServiceError to its envelope + httpStatus", async () => {
    const { deps } = await makeDeps();
    const res = await createApp(routes).handle(req("GET", "/boom-service"), deps);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "conflict", message: "x" } });
  });

  it("maps an unknown error to 500 internal", async () => {
    const { deps } = await makeDeps();
    const res = await createApp(routes).handle(req("GET", "/boom-plain"), deps);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "internal", message: "internal error" } });
  });
});

describe("withSession", () => {
  const routes: Route[] = [
    { method: "GET", pattern: "/me", handler: echoSession },
    { method: "GET", pattern: "/public", options: { public: true }, handler: echoSession },
  ];

  it("resolves a cookie token (via: cookie)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await createApp(routes).handle(req("GET", "/me", { cookie: `tf_session=${s.token}` }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: "cookie", accountId: s.accountId });
  });

  it("resolves a Bearer token (via: bearer)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await createApp(routes).handle(req("GET", "/me", { bearer: s.token }), deps);
    expect(await res.json()).toEqual({ via: "bearer", accountId: s.accountId });
  });

  it("401s a protected route with no token", async () => {
    const { deps } = await makeDeps();
    const res = await createApp(routes).handle(req("GET", "/me"), deps);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  });

  it("401s an expired session", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, accessExpiresAt: new Date(FIXED_NOW.getTime() - 1000) });
    const res = await createApp(routes).handle(req("GET", "/me", { cookie: `tf_session=${s.token}` }), deps);
    expect(res.status).toBe(401);
  });

  it("401s a revoked session", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, revokedAt: new Date(FIXED_NOW.getTime() - 1000) });
    const res = await createApp(routes).handle(req("GET", "/me", { cookie: `tf_session=${s.token}` }), deps);
    expect(res.status).toBe(401);
  });

  it("runs a public route with no session", async () => {
    const { deps } = await makeDeps();
    const res = await createApp(routes).handle(req("GET", "/public"), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: null, accountId: null });
  });
});

// the scope gate. It lives in `withSession` so it applies to every route in
// the table at once; these cases pin the three outcomes on synthetic routes, next to
// the middleware they belong to (the end-to-end proof is enrollment-flow.test.ts).
describe("withSession — enrollment scope", () => {
  const echoScope: Route["handler"] = async (_req, deps) =>
    jsonResponse({ via: deps.session?.via ?? null, scope: deps.session?.scope ?? null });
  const routes: Route[] = [
    { method: "GET", pattern: "/product", handler: echoScope },
    { method: "GET", pattern: "/enroll", options: { enrollmentOk: true }, handler: echoScope },
    { method: "GET", pattern: "/open", options: { public: true }, handler: echoScope },
    {
      method: "GET", pattern: "/open-enroll", cost: "ceremony", relay: false,
      options: { public: true, enrollmentOk: true }, handler: echoScope,
    },
  ];

  it("403s enrollment_incomplete on a protected route that is not enrollmentOk", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, scope: "enrollment" });
    const res = await createApp(routes).handle(req("GET", "/product", { bearer: s.token }), deps);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("enrollment_incomplete");
  });

  it("admits it on an enrollmentOk route, scope and all", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, scope: "enrollment" });
    const res = await createApp(routes).handle(req("GET", "/enroll", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: "bearer", scope: "enrollment" });
  });

  it("DROPS it on a public route (a stale enrollment credential must not 403 a login)", async () => {
    const { db, deps } = await makeDeps();
    const enrollment = await seedSession(db, { now: FIXED_NOW, scope: "enrollment" });
    const dropped = await createApp(routes).handle(req("GET", "/open", { bearer: enrollment.token }), deps);
    expect(dropped.status).toBe(200);
    expect(await dropped.json()).toEqual({ via: null, scope: null });

    // A FULL session on the same public route is still attached — only the
    // enrollment scope is stripped.
    const full = await seedSession(db, { now: FIXED_NOW });
    const kept = await createApp(routes).handle(req("GET", "/open", { bearer: full.token }), deps);
    expect(await kept.json()).toEqual({ via: "bearer", scope: "full" });
  });

  it("KEEPS it on a public route that carries the flag (the web's sign-out door ends it there)", async () => {
    const { db, deps } = await makeDeps();
    const enrollment = await seedSession(db, { now: FIXED_NOW, scope: "enrollment" });
    const kept = await createApp(routes).handle(req("GET", "/open-enroll", { bearer: enrollment.token }), deps);
    expect(kept.status).toBe(200);
    expect(await kept.json()).toEqual({ via: "bearer", scope: "enrollment" });
  });

  it("the flag widens, never narrows: a full session still passes an enrollmentOk route", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await createApp(routes).handle(req("GET", "/enroll", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: "bearer", scope: "full" });
  });
});

describe("withCsrf", () => {
  const routes: Route[] = [{ method: "POST", pattern: "/mutate", handler: async () => jsonResponse({ ok: true }) }];

  it("403s a cookie POST without X-CSRF-Token", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await createApp(routes).handle(
      req("POST", "/mutate", { cookie: `tf_session=${s.token}; tf_csrf=${csrfTokenFor(s.token)}` }), deps);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("csrf_failed");
  });

  it("passes a cookie POST whose token is the one DERIVED from the session", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const csrf = csrfTokenFor(s.token);
    const res = await createApp(routes).handle(
      req("POST", "/mutate", { cookie: `tf_session=${s.token}; tf_csrf=${csrf}`, headers: { "x-csrf-token": csrf } }),
      deps,
    );
    expect(res.status).toBe(200);
  });

  /**
   * THE COOKIE-TOSSING CASE, which an equal PAIR used to satisfy.
   *
   * The guard asked only whether the cookie and the header matched EACH OTHER, so script on an
   * allow-listed same-site sibling origin could set `tf_csrf=A; Domain=ohmail.app` — the browser
   * then sends both copies and `parseCookies` keeps the tossed one — and post with
   * `X-CSRF-Token: A`. The victim's host-only `tf_session` rides along as ambient authority and
   * the mutation runs under a token never minted for that session. Restore the old
   * `cookie !== header` comparison in `withCsrf` and this goes green at 200.
   */
  it("403s an equal cookie+header pair that is not the session's own token", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const tossed = "attacker-chosen-value";
    const res = await createApp(routes).handle(
      req("POST", "/mutate", {
        // Two `tf_csrf` cookies, exactly as a browser sends them when a parent-domain one is
        // planted next to the host-only one — the LAST wins, which is the attacker's.
        cookie: `tf_session=${s.token}; tf_csrf=${csrfTokenFor(s.token)}; tf_csrf=${tossed}`,
        headers: { "x-csrf-token": tossed },
      }),
      deps,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("csrf_failed");
  });

  it("exempts Bearer POST (no CSRF token needed)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await createApp(routes).handle(req("POST", "/mutate", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
  });
});

/**
 * `withRequestGuard` — the guard the PUBLIC cookie-minting auth routes get, since
 * `withCsrf` cannot fire without a cookie session. It runs before `withSession`, so it
 * must be provable on an unauthenticated public route.
 */
describe("withRequestGuard", () => {
  const routes: Route[] = [
    { method: "POST", pattern: "/open", options: { public: true }, handler: async () => jsonResponse({ ok: true }) },
    { method: "GET", pattern: "/read", options: { public: true }, handler: async () => jsonResponse({ ok: true }) },
  ];
  const body = JSON.stringify({ a: 1 });

  it("415s a body whose Content-Type is form-encodable (the cross-site POST shape)", async () => {
    const { deps } = await makeDeps();
    for (const ct of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const res = await createApp(routes).handle(
        req("POST", "/open", { headers: { "content-type": ct }, body }), deps,
      );
      expect(res.status, ct).toBe(415);
      expect((await res.json()).error.code).toBe("unsupported_media_type");
    }
  });

  it("415s a body with NO declared Content-Type, and accepts a parameterised JSON one", async () => {
    const { deps } = await makeDeps();
    const bare = new Request("http://localhost/open", { method: "POST", body });
    expect(bare.headers.get("content-type")).toBe("text/plain;charset=UTF-8"); // what fetch defaults to
    expect((await createApp(routes).handle(bare, deps)).status).toBe(415);

    const ok = await createApp(routes).handle(
      req("POST", "/open", { headers: { "content-type": "application/json; charset=utf-8" }, body }), deps,
    );
    expect(ok.status).toBe(200);
  });

  it("403s a hostile Origin / cross-site Sec-Fetch-Site; passes the configured origin and native (neither header)", async () => {
    const { deps } = await makeDeps();
    for (const headers of [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "none" }]) {
      const res = await createApp(routes).handle(req("POST", "/open", { headers, body }), deps);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect((await res.json()).error.code).toBe("cross_site_denied");
    }
    for (const headers of [
      { origin: deps.authConfig.origin },
      { "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "same-site" },
      {},
    ]) {
      const res = await createApp(routes).handle(req("POST", "/open", { headers, body }), deps);
      expect(res.status, JSON.stringify(headers)).toBe(200);
    }
  });

  it("leaves SAFE methods alone (no Content-Type / Origin requirement on a GET)", async () => {
    const { deps } = await makeDeps();
    const res = await createApp(routes).handle(
      req("GET", "/read", { headers: { origin: "https://evil.example" } }), deps,
    );
    expect(res.status).toBe(200);
  });

  it("allows a bodyless unsafe request (DELETE with no Content-Type)", async () => {
    const { deps } = await makeDeps();
    const del: Route[] = [{ method: "DELETE", pattern: "/thing", options: { public: true }, handler: async () => jsonResponse({ ok: true }) }];
    expect((await createApp(del).handle(req("DELETE", "/thing"), deps)).status).toBe(200);
  });
});

describe("withStepUp", () => {
  const routes: Route[] = [{ method: "POST", pattern: "/step", options: { stepUp: true }, handler: async () => jsonResponse({ ok: true }), }];

  it("403s when lastTwofaAt is absent", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: null });
    const res = await createApp(routes).handle(req("POST", "/step", { bearer: s.token }), deps);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("step_up_required");
  });

  it("403s when lastTwofaAt is stale (older than the window)", async () => {
    const { db, deps } = await makeDeps();
    const stale = new Date(FIXED_NOW.getTime() - 6 * 60 * 1000); // window is 5 min
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: stale });
    const res = await createApp(routes).handle(req("POST", "/step", { bearer: s.token }), deps);
    expect(res.status).toBe(403);
  });

  it("passes with a fresh lastTwofaAt", async () => {
    const { db, deps } = await makeDeps();
    const fresh = new Date(FIXED_NOW.getTime() - 60 * 1000);
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: fresh });
    const res = await createApp(routes).handle(req("POST", "/step", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
  });
});
