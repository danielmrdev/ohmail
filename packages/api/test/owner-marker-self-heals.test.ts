import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { refreshTokens } from "@trafficflow/db";
import { generateToken, hashToken, type Db } from "@trafficflow/services";
import { makeDeps, seedSession, req, setCookieMap, FIXED_NOW } from "./helpers.js";

/**
 * ═══ AN ABSENT ACCOUNT MARKER COMES BACK ═════════════════════════════════════════════════
 *
 * The web client's gate refuses every call while it cannot read `tf_owner`. Its only writers
 * were the sign-in ceremonies, and `POST /auth/refresh` resolves no user — it re-stamps what the
 * jar holds and nothing else — so a browser that lost the cookie kept renewing its session for
 * ninety days with every gated request refused, and only a fresh sign-in left that state.
 */

/**
 * `GET /auth/session` does resolve a user. Measured live against the deployed API before this
 * landed: 200 carrying `accountId`, and no `Set-Cookie` at all, with and without the marker in
 * the jar. Pinned here: the mint and its four edges — the cookie surface, a full session, a jar
 * that says nothing, and `refresh` still not minting one.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

/** A live, rotatable refresh token attached to a seeded session. */
async function seedRefresh(db: Db, s: { accountId: string; userId: string; sessionId: string }): Promise<string> {
  const refresh = generateToken();
  await db.insert(refreshTokens).values({
    accountId: s.accountId, userId: s.userId, sessionId: s.sessionId, familyId: randomUUID(),
    tokenHash: hashToken(refresh),
    expiresAt: new Date(FIXED_NOW.getTime() + 2 * 60 * 60 * 1000),
  });
  return refresh;
}

const ownerLine = (res: Response): string | undefined =>
  res.headers.getSetCookie().find((c) => c.startsWith("tf_owner="));

describe("GET /auth/session mints the marker a browser has lost", () => {
  it("a live jar with NO tf_owner gets an account-shaped marker back", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    const res = await H(req("GET", "/auth/session", { cookie: `tf_session=${s.token}` }), deps);
    expect(res.status).toBe(200);
    // THE ID THE SERVER JUST RESOLVED, not one the caller sent — the body names the same account.
    expect((await res.json()).user.accountId).toBe(s.accountId);
    expect(setCookieMap(res).tf_owner, "no marker was minted for a session that resolves a user")
      .toBe(s.accountId);
  });

  it("the minted line carries the session set's own narrowness — host-only, Secure, Strict, readable", () => {
    // Attributes are asserted on the one function that mints them, in `owner-cookie.test.ts`;
    // what this case holds is that the route uses THAT function and not a second spelling.
    return (async () => {
      const { db, deps } = await makeDeps();
      const s = await seedSession(db, { now: FIXED_NOW });
      const line = ownerLine(await H(req("GET", "/auth/session", { cookie: `tf_session=${s.token}` }), deps))!;
      expect(line).toBeDefined();
      expect(line).toContain("SameSite=Strict");
      expect(line).toContain("Secure");
      expect(line).toContain("Path=/");
      expect(line).not.toContain("Domain=");
      expect(line).not.toContain("HttpOnly");
    })();
  });

  it("a jar that ALREADY names an account is left alone — nothing is re-written", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(
      req("GET", "/auth/session", { cookie: `tf_session=${s.token}; tf_owner=${s.accountId}` }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(ownerLine(res), "a marker already in the jar was re-minted").toBeUndefined();
  });

  it("a marker naming SOMEBODY ELSE is a disagreement to report, not one to overwrite", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const other = await seedSession(db, { now: FIXED_NOW });
    expect(other.accountId).not.toBe(s.accountId);
    const res = await H(
      req("GET", "/auth/session", { cookie: `tf_session=${s.token}; tf_owner=${other.accountId}` }),
      deps,
    );
    // Silently re-pointing the mirror is the one thing worse than refusing: the client's own
    // gate latches on the change and asks, which is the behaviour this must not take away.
    expect(ownerLine(res), "the route overwrote a marker naming another account").toBeUndefined();
  });

  it("the client's own `signed_out_pending` word is a refusal the server may not undo", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(
      req("GET", "/auth/session", { cookie: `tf_session=${s.token}; tf_owner=signed_out_pending` }),
      deps,
    );
    expect(ownerLine(res), "a pending sign-out was overwritten with an account id").toBeUndefined();
  });

  it("an ENROLLMENT session gets no marker — it owns no mailbox to open", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, scope: "enrollment" });
    const res = await H(req("GET", "/auth/session", { cookie: `tf_session=${s.token}` }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).scope).toBe("enrollment");
    expect(ownerLine(res), "an enrollment session was given a mailbox marker").toBeUndefined();
  });

  it("a BEARER-ONLY host mints nothing — no browser will ever hold it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(
      req("GET", "/auth/session", { bearer: s.token }),
      { ...deps, allowCookieAuth: false },
    );
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie(), "a bearer-only host set a cookie").toEqual([]);
  });
});

describe("refresh still does not mint one — the negative arm", () => {
  it("POST /auth/refresh with a live token and NO tf_owner sets no marker", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const refresh = await seedRefresh(db, s);

    const res = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${refresh}`, body: "{}" }), deps);
    expect(res.status).toBe(204);
    const set = setCookieMap(res);
    // It rotated — the other cookies are there, so this is not a green over a refused refresh.
    expect(set.tf_session).toBeTruthy();
    expect(set.tf_refresh).toBeTruthy();
    // `refresh` resolves a token family, never a user. Minting here would be inventing an id.
    expect(set.tf_owner, "refresh minted an owner marker it has no user to derive").toBeUndefined();
  });

  it("POST /auth/refresh re-stamps a marker the jar DOES hold — the behaviour that is unchanged", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const refresh = await seedRefresh(db, s);

    const res = await H(
      req("POST", "/auth/refresh", { cookie: `tf_refresh=${refresh}; tf_owner=${s.accountId}`, body: "{}" }),
      deps,
    );
    expect(res.status).toBe(204);
    expect(setCookieMap(res).tf_owner).toBe(s.accountId);
  });
});
