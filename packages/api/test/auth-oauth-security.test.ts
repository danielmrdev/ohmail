import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { createApp, authRoutes, type ApiDeps, csrfTokenFor } from "@trafficflow/api";
import { totpNow, type Db } from "@trafficflow/services";
import {
  makeDeps, seedSessionFor, req, setCookieMap, type TestClock,
} from "./helpers.js";

const app = createApp(authRoutes);
const PW = "pw-correct-horse";
// DERIVED from the session token, exactly as `sessionCookies` mints it — a literal
// constant is no longer a valid CSRF token for anybody. See `cookies.ts#csrfTokenFor`.
const CSRF = csrfTokenFor;
const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

// Fresh per-request container each call (see auth-flow.test.ts) so mutable
// `session`/`idempotency` never leak across the shared `deps`.
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

async function register(deps: ApiDeps, email: string): Promise<{ userId: string; accountId: string }> {
  const res = await H(
    req("POST", "/auth/register", { body: JSON.stringify({ email, password: PW, displayName: "Gil", inviteCode: "INVITE-OK" }) }),
    deps,
  );
  expect(res.status).toBe(201);
  const { user } = await res.json();
  return { userId: user.userId, accountId: user.accountId };
}

describe("auth — OAuth2 authorization-code + PKCE (native)", () => {
  it("the ceremony CONFIRMS, then 302s with a code; POST /oauth/token returns tokens in the BODY", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    // The browser flow is already authenticated → a session cookie is present.
    const { token } = await seedSessionFor(db, { ...id, now: clock.now(), lastTwofaAt: clock.now() });
    const verifier = "a".repeat(48);

    const q = new URLSearchParams({
      response_type: "code", client_id: "tf-macos", redirect_uri: "trafficflow://auth",
      code_challenge: s256(verifier), code_challenge_method: "S" + "256", state: "xyz", scope: "full",
    });
    // The GET opens the request and bounces to the confirmation page — it mints nothing
    // The code exists only once the POST behind the CSRF token says so.
    const authorize = await H(req("GET", `/oauth/authorize?${q}`, { cookie: `tf_session=${token}` }), deps);
    expect(authorize.status).toBe(302);
    const request = new URL(authorize.headers.get("location")!).searchParams.get("request")!;
    expect(request).toBeTruthy();

    const confirmed = await H(
      req("POST", "/oauth/authorize", {
        cookie: `tf_session=${token}; tf_csrf=${CSRF(token)}`,
        headers: { "x-csrf-token": CSRF(token) },
        body: JSON.stringify({ request }),
      }),
      deps,
    );
    expect(confirmed.status).toBe(200);
    const url = new URL((await confirmed.json()).redirect);
    const code = url.searchParams.get("code")!;
    expect(code).toBeTruthy();
    expect(url.searchParams.get("state")).toBe("xyz");

    const token1 = await H(
      req("POST", "/oauth/token", { body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: "trafficflow://auth", client_id: "tf-macos", code_verifier: verifier }) }),
      deps,
    );
    expect(token1.status).toBe(200);
    // Native: tokens in the body, NO Set-Cookie.
    expect(token1.headers.getSetCookie()).toHaveLength(0);
    const tokens = await token1.json();
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    expect(tokens.tokenType).toBe("Bearer");

    // Single-use: the same code cannot be redeemed twice.
    const replay = await H(
      req("POST", "/oauth/token", { body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: "trafficflow://auth", client_id: "tf-macos", code_verifier: verifier }) }),
      deps,
    );
    expect(replay.status).toBe(400);
    expect((await replay.json()).error.code).toBe("invalid_grant");
  });
});

describe("auth — recovery codes (step-up gated)", () => {
  it("generates 10 codes then a verify consumes one (remainingCodes, no tokens in body)", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");

    // Enroll TOTP so the account has a factor; seed a fresh step-up'd session.
    const { token } = await seedSessionFor(db, { ...id, now: clock.now(), lastTwofaAt: clock.now() });
    const cookie = `tf_session=${token}; tf_csrf=${CSRF(token)}`;
    const headers = { "x-csrf-token": CSRF(token) };
    const enroll = await H(req("POST", "/auth/2fa/totp/enroll", { cookie, headers }), deps);
    const { secret } = await enroll.json();
    await H(req("POST", "/auth/2fa/totp/activate", { cookie, headers, body: JSON.stringify({ code: totpNow(secret, clock.now()) }) }), deps);

    const gen = await H(req("POST", "/auth/2fa/recovery-codes", { cookie, headers }), deps);
    expect(gen.status).toBe(200);
    const { codes } = await gen.json();
    expect(codes).toHaveLength(10);

    // Use one code as the second factor at login.
    clock.advance(30_000);
    const login = await H(req("POST", "/auth/login", { body: JSON.stringify({ email: "gil@x.example", password: PW }) }), deps);
    const { loginToken } = await login.json();
    const verify = await H(
      req("POST", "/auth/2fa/recovery-codes/verify", { body: JSON.stringify({ loginToken, code: codes[0] }) }),
      deps,
    );
    expect(verify.status).toBe(200);
    const body = await verify.json();
    expect(body.status).toBe("authenticated");
    expect(body.remainingCodes).toBe(9);
    expect(body.tokens).toBeUndefined();
    expect(setCookieMap(verify).tf_session).toBeTruthy();
  });
});

describe("auth — WebAuthn option endpoints", () => {
  it("register/options needs a session; assert/options is public with a loginToken", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const { token } = await seedSessionFor(db, { ...id, now: clock.now(), lastTwofaAt: clock.now() });
    const cookie = `tf_session=${token}; tf_csrf=${CSRF(token)}`;
    const headers = { "x-csrf-token": CSRF(token) };

    const regOpts = await H(
      req("POST", "/auth/2fa/webauthn/register/options", { cookie, headers }),
      deps,
    );
    expect(regOpts.status).toBe(200);
    expect((await regOpts.json()).options).toBeTruthy();

    // A login token (public path) — no enrolled webauthn cred yet, but options still issue.
    // a login token only exists for a user who HAS a second factor — a login with
    // ZERO enrolled methods now returns an enrollment session instead of the
    // `{twofa_required, methods: []}` dead end this assertion used to rely on. TOTP is
    // enrolled so the user has a factor while still having NO webauthn credential, which
    // is the case this test is actually about (options issue with an empty allow-list).
    const enroll = await H(req("POST", "/auth/2fa/totp/enroll", { cookie, headers }), deps);
    expect(enroll.status).toBe(200);
    const { secret } = await enroll.json();
    const activate = await H(
      req("POST", "/auth/2fa/totp/activate", { cookie, headers, body: JSON.stringify({ code: totpNow(secret, clock.now()) }) }),
      deps,
    );
    expect(activate.status).toBe(200);

    const login = await H(req("POST", "/auth/login", { body: JSON.stringify({ email: "gil@x.example", password: PW }) }), deps);
    const { loginToken } = await login.json();
    expect(loginToken).toBeTruthy();
    const assertOpts = await H(
      req("POST", "/auth/2fa/webauthn/assert/options", { body: JSON.stringify({ loginToken }) }),
      deps,
    );
    expect(assertOpts.status).toBe(200);
    expect((await assertOpts.json()).options).toBeTruthy();
    void (db as Db);
  });
});

describe("auth — the enumeration and lockout rules at the HTTP layer", () => {
  it("unknown-email and known-email/wrong-password return an IDENTICAL 401 envelope", async () => {
    const { deps } = await makeDeps();
    await register(deps, "known@x.example");

    const wrongPw = await H(req("POST", "/auth/login", { body: JSON.stringify({ email: "known@x.example", password: "WRONG" }) }), deps);
    const unknown = await H(req("POST", "/auth/login", { body: JSON.stringify({ email: "ghost@x.example", password: "WRONG" }) }), deps);

    expect(wrongPw.status).toBe(401);
    expect(unknown.status).toBe(401);
    const a = (await wrongPw.json()).error;
    const b = (await unknown.json()).error;
    expect(b.code).toBe(a.code);
    expect(b.message).toBe(a.message);
    expect(a.code).toBe("credential_refused");
  });

  it("locks the account (423) after maxFailures first-factor failures", async () => {
    const { deps } = await makeDeps(undefined, { maxFailures: 3 });
    await register(deps, "lock@x.example");
    // ONE IDENTIFIED client: the lock is per (address, client), and a request naming no client
    // takes no lock at all (`auth-unknown-client.test.ts` in the services suite).
    const headers = { "x-forwarded-for": "198.51.100.7" };

    for (let i = 0; i < 3; i++) {
      const bad = await H(req("POST", "/auth/login", { headers, body: JSON.stringify({ email: "lock@x.example", password: "WRONG" }) }), deps);
      expect(bad.status).toBe(401);
    }
    // Even the correct password is now refused with a lockout.
    const locked = await H(req("POST", "/auth/login", { headers, body: JSON.stringify({ email: "lock@x.example", password: PW }) }), deps);
    expect(locked.status).toBe(423);
    expect((await locked.json()).error.code).toBe("account_locked");
  });
});
