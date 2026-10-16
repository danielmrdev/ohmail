import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApp, authRoutes, type ApiDeps, csrfTokenFor } from "@trafficflow/api";
import { sessions } from "@trafficflow/db";
import { makeDeps, seedSessionFor, req } from "./helpers.js";

/**
 * SEC3-AUTH-6 — `GET /oauth/authorize` mints a NATIVE authorization code, and the session that
 * code produces takes the 400-day native window in a family of its own. Two things were missing
 * and this file guards both.
 *
 * ── THE GATE ────────────────────────────────────────────────────────────────────────────────
 *
 * The route carried no `stepUp`, so a bare access token — a hostile extension, local malware,
 * any disclosure — could mint the code inside its 15-minute life and exchange it for an
 * independently-revocable credential lasting 400 days. Revoking the compromised device left the
 * new family untouched. `POST /auth/desktop-link` next door has carried `stepUp: true` all
 * along for exactly the mirror-image reason (it ADDS a device); this door did not.
 *
 * ── THE PROVENANCE ──────────────────────────────────────────────────────────────────────────
 *
 * `establish` stamped `lastTwofaAt: now` on a ceremony that asserted no factor at all, which
 * laundered an authorization into a fresh factor timestamp. The honest value is the authorizing
 * session's REAL `lastTwofaAt`, carried through the code row — see the note on `establish`.
 *
 * ── THE CEREMONY IS NOW TWO GESTURES ────────────────────────────────────────────────────────
 *
 * `GET /oauth/authorize` no longer mints: it opens a request and bounces
 * to the confirmation page, and `POST /oauth/authorize` behind the session's CSRF token is what
 * produces the code. Every walk below goes through {@link ceremonyCode}, so the two properties
 * this file guards — the gate and the provenance — are measured on the ceremony the product
 * actually runs rather than on a shape that no longer exists.
 *
 * THESE RUN THROUGH THE HTTP APP, not the service. The register's fix direction says so
 * explicitly ("the guard needs a compiled HTTP test"), and it is the only level at which the
 * route's `stepUp` flag and the pipeline that reads it are both in the picture: a service-level
 * assertion would have passed with the flag present and the middleware absent from the chain,
 * which is precisely the state this slice found.
 */

const app = createApp(authRoutes);
const PW = "pw-correct-horse";
const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");
const VERIFIER = "a".repeat(48);

const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

async function register(deps: ApiDeps, email: string): Promise<{ userId: string; accountId: string }> {
  const res = await H(
    req("POST", "/auth/register", { body: JSON.stringify({ email, password: PW, displayName: "Gil", inviteCode: "INVITE-OK" }) }),
    deps,
  );
  expect(res.status).toBe(201);
  const { user } = await res.json();
  return { userId: user.userId, accountId: user.accountId };
}

function authorizeQuery(): string {
  return new URLSearchParams({
    response_type: "code", client_id: "tf-macos", redirect_uri: "trafficflow://auth",
    code_challenge: s256(VERIFIER), code_challenge_method: "S" + "256", state: "xyz", scope: "full",
  }).toString();
}

/**
 * Walk the ceremony end to end and hand back the code. The confirmation carries the session's
 * CSRF token because that is the whole point of the POST: a link somebody else composed cannot
 * produce it.
 */
async function ceremonyCode(deps: ApiDeps, token: string): Promise<{ code: string; state: string | null }> {
  const opened = await H(req("GET", `/oauth/authorize?${authorizeQuery()}`, { cookie: `tf_session=${token}` }), deps);
  expect(opened.status).toBe(302);
  const request = new URL(opened.headers.get("location")!).searchParams.get("request")!;
  expect(request).toBeTruthy();
  const confirmed = await H(
    req("POST", "/oauth/authorize", {
      cookie: `tf_session=${token}; tf_csrf=${csrfTokenFor(token)}`,
      headers: { "x-csrf-token": csrfTokenFor(token) },
      body: JSON.stringify({ request }),
    }),
    deps,
  );
  expect(confirmed.status).toBe(200);
  const redirect = new URL((await confirmed.json()).redirect);
  return { code: redirect.searchParams.get("code")!, state: redirect.searchParams.get("state") };
}

describe("SEC3-AUTH-6 — /oauth/authorize is step-up gated", () => {
  it("REFUSES with the step-up taxonomy when the session has no recent 2FA", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    // A full, live, perfectly valid session whose second factor is OLD — the stolen-token case.
    // `stepUpWindowMs` is 5 minutes; this one is an hour past it.
    const { token } = await seedSessionFor(db, {
      ...id, now: clock.now(), lastTwofaAt: new Date(clock.now().getTime() - 60 * 60_000),
    });

    const res = await H(req("GET", `/oauth/authorize?${authorizeQuery()}`, { cookie: `tf_session=${token}` }), deps);

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("step_up_required");
    // And nothing was minted: no Location to follow.
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses a session that never asserted a factor at all (NULL lastTwofaAt)", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const { token } = await seedSessionFor(db, { ...id, now: clock.now(), lastTwofaAt: null });

    const res = await H(req("GET", `/oauth/authorize?${authorizeQuery()}`, { cookie: `tf_session=${token}` }), deps);

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("step_up_required");
  });

  /**
   * THE TAXONOMY SPLIT, and it is load-bearing rather than cosmetic. `/oauth/authorize` is the
   * first route in the table that is BOTH `public` and `stepUp`, which makes `withStepUp`'s
   * null-session branch reachable for the first time — on every other step-up route
   * `withSession` has already answered 401. An anonymous caller must be told to AUTHENTICATE,
   * not to step up: `enrollment-flow.test.ts` asserts the 401 for a dropped enrollment session
   * on this exact route, and `middleware.ts` argues it ("dropping the identity turns that into
   * the 401 it must be instead of a password-only escalation to full bearer tokens").
   */
  it("answers 401 — not 403 — when there is no session at all", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("GET", `/oauth/authorize?${authorizeQuery()}`), deps);

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  });
});

describe("SEC3-AUTH-6 — the legitimate desktop ceremony still completes", () => {
  it("fresh 2FA → authorize → token → a working native session, end to end", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const { token } = await seedSessionFor(db, { ...id, now: clock.now(), lastTwofaAt: clock.now() });

    const { code, state } = await ceremonyCode(deps, token);
    expect(code).toBeTruthy();
    expect(state).toBe("xyz");

    const exchanged = await H(
      req("POST", "/oauth/token", {
        body: JSON.stringify({
          grant_type: "authorization_code", code, redirect_uri: "trafficflow://auth",
          client_id: "tf-macos", code_verifier: VERIFIER,
        }),
      }),
      deps,
    );
    expect(exchanged.status).toBe(200);
    const tokens = await exchanged.json();
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    // Native: tokens in the body, never a cookie.
    expect(exchanged.headers.getSetCookie()).toHaveLength(0);

    // The credential WORKS — the ceremony is not merely un-refused, it produces a usable session.
    const whoami = await H(
      req("GET", "/auth/session", { headers: { authorization: `Bearer ${tokens.accessToken}` } }), deps,
    );
    expect(whoami.status).toBe(200);
    expect((await whoami.json()).user.userId).toBe(id.userId);
    void (db as unknown);
  });
});

describe("SEC3-AUTH-6 — lastTwofaAt provenance is inherited, never re-stamped", () => {
  it("the native session carries the AUTHORIZING session's real factor time, not `now`", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    // A real factor, asserted three minutes ago — inside the 5-minute window, so the ceremony
    // is admitted, but NOT `now`. That gap is the whole measurement.
    const asserted = new Date(clock.now().getTime() - 3 * 60_000);
    const { token, sessionId } = await seedSessionFor(db, { ...id, now: clock.now(), lastTwofaAt: asserted });

    const { code } = await ceremonyCode(deps, token);

    const exchanged = await H(
      req("POST", "/oauth/token", {
        body: JSON.stringify({
          grant_type: "authorization_code", code, redirect_uri: "trafficflow://auth",
          client_id: "tf-macos", code_verifier: VERIFIER,
        }),
      }),
      deps,
    );
    expect(exchanged.status).toBe(200);

    // `register` leaves its enrollment session behind, REVOKED (`revokeEnrollmentSessions` runs
    // inside `establish`), so the live set is the authorizing session plus the one just minted.
    const rows = await db.select().from(sessions).where(eq(sessions.userId, id.userId));
    const minted = rows.filter((r) => r.id !== sessionId && r.revokedAt === null);
    expect(minted).toHaveLength(1);
    const native = minted[0]!;

    // A NEW family and a NEW device — the independence the flow is for is unchanged.
    expect(native.familyId).not.toBe(rows.find((r) => r.id === sessionId)!.familyId);
    expect(native.scope).toBe("full");

    // THE ASSERTION. Inherited to the millisecond, and demonstrably not the wall clock.
    expect(native.lastTwofaAt).not.toBeNull();
    expect(native.lastTwofaAt!.getTime()).toBe(asserted.getTime());
    expect(native.lastTwofaAt!.getTime()).not.toBe(clock.now().getTime());
  });

  /**
   * The consequence of inheriting rather than re-stamping, stated as behaviour rather than as a
   * column value: the minted native session inherits the REMAINDER of the authorizing session's
   * step-up window and ages out of it on the original schedule. Re-stamping handed it a full
   * fresh five minutes, which is what let one authorization become a ladder — the new session
   * could mint the next credential, and so on, without a factor ever being asserted again.
   */
  it("the minted session ages out of step-up on the ORIGINAL schedule", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const asserted = new Date(clock.now().getTime() - 4 * 60_000);
    const { token } = await seedSessionFor(db, { ...id, now: clock.now(), lastTwofaAt: asserted });

    const { code } = await ceremonyCode(deps, token);
    const exchanged = await H(
      req("POST", "/oauth/token", {
        body: JSON.stringify({
          grant_type: "authorization_code", code, redirect_uri: "trafficflow://auth",
          client_id: "tf-macos", code_verifier: VERIFIER,
        }),
      }),
      deps,
    );
    const { accessToken } = await exchanged.json();

    // Ninety seconds on: the inherited factor is 5m30s old, past the window. The freshly minted
    // 400-day credential can no longer mint another one.
    clock.advance(90_000);
    const again = await H(
      req("GET", `/oauth/authorize?${authorizeQuery()}`, { headers: { authorization: `Bearer ${accessToken}` } }),
      deps,
    );
    expect(again.status).toBe(403);
    expect((await again.json()).error.code).toBe("step_up_required");
    void (db as unknown);
  });
});
