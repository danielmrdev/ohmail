import { describe, it, expect } from "vitest";
import { sessions } from "@trafficflow/db";
import { webauthnChallenges, webauthnCredentials } from "@trafficflow/db/cloud";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { SoftwareAuthenticator } from "../../services/test/webauthn-authenticator.js";
import { makeDeps, req, setCookieMap } from "./helpers.js";

/**
 * MULTI-ORIGIN WEBAUTHN, OVER THE WIRE.
 *
 * `packages/services/test/auth-origins.test.ts` proves the ceremony contract against
 * `AuthService` directly. This file proves the part only the HTTP layer can: that the
 * request's `Origin` header actually REACHES the ceremony (`serviceContext` threading)
 * and that `withRequestGuard` — which used to compare `Origin` to one configured
 * string — now admits every first-party surface of the deployment without admitting
 * anything else.
 *
 * Topology: rpID `ohmail.app` — the registrable domain, so one credential store spans
 * both hosts — with origins `https://ohmail.app` (the single product origin since that change)
 * and `https://admin.ohmail.app` (staff). The request URL is irrelevant to WebAuthn — the
 * ceremony is bound to the `Origin` header, which is what a browser sends and what
 * the Vercel rewrite preserves.
 */
const app = createApp(apiRoutes);
const RPID = "ohmail.app";
const APP = "https://ohmail.app";
const ADMIN = "https://admin.ohmail.app";
const PW = "pw-correct-horse";

const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

const multiOrigin = () => makeDeps(undefined, { rpID: RPID, origin: [APP, ADMIN] });

interface Enrolled { cookie: string; csrf: string }

/** `POST /auth/register` from `origin` → the enrollment session's cookie pair. */
async function register(deps: ApiDeps, email: string, origin: string): Promise<Enrolled> {
  const res = await H(req("POST", "/auth/register", {
    headers: { origin },
    body: JSON.stringify({ email, password: PW, displayName: "Gil", inviteCode: "INVITE-OK" }),
  }), deps);
  expect(res.status).toBe(201);
  const c = setCookieMap(res);
  return { cookie: `tf_session=${c.tf_session}; tf_csrf=${c.tf_csrf}`, csrf: c.tf_csrf! };
}

/** The whole passkey enrollment, opened and completed on `origin`. */
async function enrollPasskey(
  deps: ApiDeps, e: Enrolled, origin: string,
): Promise<SoftwareAuthenticator> {
  const headers = { origin, "x-csrf-token": e.csrf };
  const opts = await H(req("POST", "/auth/2fa/webauthn/register/options", { cookie: e.cookie, headers }), deps);
  expect(opts.status).toBe(200);
  const { options } = await opts.json();
  const authenticator = new SoftwareAuthenticator();
  const credential = authenticator.register({ rpID: RPID, challenge: options.challenge, origin });
  const res = await H(req("POST", "/auth/2fa/webauthn/register/verify", {
    cookie: e.cookie, headers, body: JSON.stringify({ credential, label: "MacBook" }),
  }), deps);
  expect(res.status).toBe(200);
  return authenticator;
}

/** Password leg → login token, from `origin`. */
async function loginToken(deps: ApiDeps, email: string, origin: string): Promise<string> {
  const res = await H(req("POST", "/auth/login", {
    headers: { origin }, body: JSON.stringify({ email, password: PW }),
  }), deps);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("twofa_required");
  return body.loginToken;
}

describe("multi-origin WebAuthn over HTTP", () => {
  it("THE ONE-RPID GATE: enrol on ohmail.app, log in on admin.ohmail.app — one rpID, one passkey", async () => {
    const { db, deps } = await multiOrigin();
    const e = await register(deps, "gil@x.example", APP);
    const authenticator = await enrollPasskey(deps, e, APP);

    // Every leg of the login now runs on the ADMIN origin.
    const lt = await loginToken(deps, "gil@x.example", ADMIN);
    const opts = await H(req("POST", "/auth/2fa/webauthn/assert/options", {
      headers: { origin: ADMIN }, body: JSON.stringify({ loginToken: lt }),
    }), deps);
    expect(opts.status).toBe(200);
    const { options } = await opts.json();
    const assertion = authenticator.assert({ rpID: RPID, challenge: options.challenge, origin: ADMIN });
    const res = await H(req("POST", "/auth/2fa/webauthn/assert/verify", {
      headers: { origin: ADMIN }, body: JSON.stringify({ loginToken: lt, credential: assertion }),
    }), deps);

    expect(res.status).toBe(200);
    expect((await res.clone().json()).status).toBe("authenticated");
    expect(setCookieMap(res).tf_session).toBeTruthy();       // a real web session on admin

    // The threading is real: each ceremony stored the origin its request carried.
    const rows = await db.select().from(webauthnChallenges);
    expect(rows.map((r) => [r.rpId, r.origin])).toEqual([[RPID, APP], [RPID, ADMIN]]);
  });

  it("a ceremony opened on ohmail.app cannot be completed from admin.ohmail.app (401)", async () => {
    const { deps } = await multiOrigin();
    const e = await register(deps, "gil@x.example", APP);
    const authenticator = await enrollPasskey(deps, e, APP);
    const lt = await loginToken(deps, "gil@x.example", APP);

    const opts = await H(req("POST", "/auth/2fa/webauthn/assert/options", {
      headers: { origin: APP }, body: JSON.stringify({ loginToken: lt }),
    }), deps);
    const { options } = await opts.json();
    const assertion = authenticator.assert({ rpID: RPID, challenge: options.challenge, origin: APP });

    // Same challenge, same credential — only the verify request's origin differs, and
    // it is an ALLOWED one. `withRequestGuard` therefore passes it; the ceremony pin
    // is what refuses it.
    const res = await H(req("POST", "/auth/2fa/webauthn/assert/verify", {
      headers: { origin: ADMIN }, body: JSON.stringify({ loginToken: lt, credential: assertion }),
    }), deps);
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toMatch(/origin mismatch/);
  });

  it("an origin outside the allow-list is refused at OPTIONS time and mints no challenge", async () => {
    const { db, deps } = await multiOrigin();
    const e = await register(deps, "gil@x.example", APP);

    // `app.ohmail.app` only 308s to the product origin — deliberately NOT an auth
    // origin (re-derived by that change).
    for (const hostile of ["https://app.ohmail.app", "https://evil.example"]) {
      const res = await H(req("POST", "/auth/2fa/webauthn/register/options", {
        cookie: e.cookie, headers: { origin: hostile, "x-csrf-token": e.csrf },
      }), deps);
      expect(res.status).toBe(403);
      // Layering, deliberate: the outer cross-site guard answers first because an
      // unlisted origin is, by definition, cross-site for this deployment. The
      // service's own `origin_not_allowed` (asserted in auth-origins.test.ts) is the
      // authoritative refusal for any caller that does not go through the guard.
      expect((await res.json()).error.code).toBe("cross_site_denied");
    }
    expect(await db.select().from(webauthnChallenges)).toHaveLength(0);
  });

  it("withRequestGuard admits BOTH first-party origins (it used to admit exactly one)", async () => {
    const { deps } = await multiOrigin();
    // Pre-S3 the guard compared `Origin` to a single string, so staff on
    // admin.ohmail.app could not have posted anything at all — not even a login.
    for (const origin of [APP, ADMIN]) {
      const res = await H(req("POST", "/auth/login", {
        headers: { origin }, body: JSON.stringify({ email: "nobody@x.example", password: PW }),
      }), deps);
      expect([401, 423]).toContain(res.status);            // reached the service, not the guard
      expect((await res.json()).error.code).not.toBe("cross_site_denied");
    }
  });

  /**
   * ORIGIN CONFUSION ON THE ENROLLMENT SURFACE, end to end — the one path that
   * `auth-origins.test.ts` could not cover, because its negative case fabricates a full
   * step-up'd session with a direct `sessions` insert and the HTTP mismatch test only
   * exercises ASSERTION (i.e. after a factor already exists).
   *
   * Here the caller is a REAL enrollment-scoped session straight out of
   * `POST /auth/register`: the least-privileged, most-reachable caller in the system, and
   * the one whose failed verify has the most to lose (`webauthnRegisterVerify` would
   * EXCHANGE the enrollment session for a full one on success). The assertions are
   * therefore about consequences, not just the status code: no credential row, no
   * privilege escalation, and no collateral damage to the honest ceremony that follows.
   */
  for (const via of ["cookie", "bearer"] as const) {
    it(`ENROLLMENT origin confusion (${via}): options on ohmail.app, credential signed for admin ⇒ 401, no factor, no session`, async () => {
      const { db, deps } = await multiOrigin();

      // A real enrollment session — no seeded rows, no fabricated step-up.
      const res = await H(req("POST", "/auth/register", {
        headers: { origin: APP },
        body: JSON.stringify({ email: "gil@x.example", password: PW, displayName: "Gil", inviteCode: "INVITE-OK" }),
      }), deps);
      expect(res.status).toBe(201);
      const body = await res.clone().json();
      expect(body.next).toBe("enroll_2fa");
      const c = setCookieMap(res);
      // The two transports the enrollment session ships on. Bearer is CSRF-exempt by
      // design (`withCsrf` only guards cookie sessions), so both must be covered.
      const auth = via === "cookie"
        ? { cookie: `tf_session=${c.tf_session}; tf_csrf=${c.tf_csrf}`, headers: { "x-csrf-token": c.tf_csrf! } }
        : { bearer: body.enrollmentToken as string, headers: {} };
      const enrollmentSessions = await db.select().from(sessions);
      expect(enrollmentSessions.map((s) => s.scope)).toEqual(["enrollment"]);

      // Options on APP ⇒ the challenge row is bound to APP.
      const opts = await H(req("POST", "/auth/2fa/webauthn/register/options", {
        ...auth, headers: { ...auth.headers, origin: APP },
      }), deps);
      expect(opts.status).toBe(200);
      const { options } = await opts.json();
      expect((await db.select().from(webauthnChallenges)).map((r) => r.origin)).toEqual([APP]);

      // The authenticator signs clientDataJSON for ADMIN — an ALLOWED origin, so neither
      // `withRequestGuard` nor the admission check can refuse it. Only `expectedOrigin =
      // the STORED origin` does. The verify request carries no `Origin` header at all, so
      // the request-header pin cannot fire either.
      const authenticator = new SoftwareAuthenticator();
      const credential = authenticator.register({ rpID: RPID, challenge: options.challenge, origin: ADMIN });
      const verify = await H(req("POST", "/auth/2fa/webauthn/register/verify", {
        ...auth, headers: auth.headers, body: JSON.stringify({ credential, label: "MacBook" }),
      }), deps);

      expect(verify.status).toBe(401);
      // The consequences, which are the point:
      expect(await db.select().from(webauthnCredentials)).toHaveLength(0);   // NO factor landed
      expect(setCookieMap(verify).tf_session).toBeUndefined();              // NO session minted
      const after = await db.select().from(sessions);
      expect(after.map((s) => s.scope)).toEqual(["enrollment"]);            // NO escalation
      expect(after[0]!.id).toBe(enrollmentSessions[0]!.id);
      expect(after[0]!.revokedAt).toBeNull();                              // still usable

      // …and the honest ceremony still works afterwards: a FRESH APP-bound challenge
      // enrols normally. (The burnt challenge is single-use by design; the failure must
      // cost the user a retry, not their onboarding.)
      const retryOpts = await H(req("POST", "/auth/2fa/webauthn/register/options", {
        ...auth, headers: { ...auth.headers, origin: APP },
      }), deps);
      expect(retryOpts.status).toBe(200);
      const retry = await retryOpts.json();
      const good = authenticator.register({ rpID: RPID, challenge: retry.options.challenge, origin: APP });
      const ok = await H(req("POST", "/auth/2fa/webauthn/register/verify", {
        ...auth, headers: { ...auth.headers, origin: APP },
        body: JSON.stringify({ credential: good, label: "MacBook" }),
      }), deps);
      expect(ok.status).toBe(200);
      expect(await db.select().from(webauthnCredentials)).toHaveLength(1);
      // Enrolling the first factor EXCHANGES the enrollment session for a full one, so
      // the 401 above really did withhold a privilege upgrade.
      expect((await db.select().from(sessions)).map((s) => s.scope).sort()).toEqual(["enrollment", "full"]);
    });
  }

  it("a native client (no Origin header) still enrols and logs in — the default origin", async () => {
    const { db, deps } = await multiOrigin();
    const res = await H(req("POST", "/auth/register", {
      body: JSON.stringify({ email: "mac@x.example", password: PW, displayName: "Gil", inviteCode: "INVITE-OK" }),
    }), deps);
    expect(res.status).toBe(201);
    const bearer = (await res.json()).enrollmentToken;

    const opts = await H(req("POST", "/auth/2fa/webauthn/register/options", { bearer }), deps);
    expect(opts.status).toBe(200);
    const { options } = await opts.json();
    const authenticator = new SoftwareAuthenticator();
    const credential = authenticator.register({ rpID: RPID, challenge: options.challenge, origin: APP });
    const verify = await H(req("POST", "/auth/2fa/webauthn/register/verify", {
      bearer, body: JSON.stringify({ credential, label: "MacBook" }),
    }), deps);
    expect(verify.status).toBe(200);
    expect((await db.select().from(webauthnChallenges))[0]!.origin).toBe(APP);
  });
});
