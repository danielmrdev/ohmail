import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { sessions, refreshTokens } from "@trafficflow/db";
import { createLogger } from "@trafficflow/core";
import { createApp, authRoutes, type ApiDeps, csrfTokenFor } from "@trafficflow/api";
import type { Db } from "@trafficflow/services";
import { makeDeps, seedSessionFor, req } from "./helpers.js";

/**
 * The ambient GET and the code replay — the two halves of one ceremony.
 *
 * The GET a provider-style redirect lands on used to ACT: it minted a native authorization code
 * from whatever session cookie the browser happened to carry, so a link a person was made to click
 * authorized as them. It now CONFIRMS: the GET writes a request nobody can spend and bounces to a
 * page, and the POST behind the session's CSRF token is the only thing that mints. The second half
 * is what a burned code does — RFC 6749 §4.1.2 asks for refusal AND revocation, and only the
 * refusal was here.
 */

const app = createApp(authRoutes);
const PW = "pw-correct-horse";
const CSRF = csrfTokenFor;
const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

const VERIFIER = "a".repeat(48);
/** The attacker's own commitment: whoever holds its verifier can spend anything this mints. */
const HOSTILE_VERIFIER = "b".repeat(48);

function authorizeQuery(challenge: string = s256(VERIFIER)): string {
  return new URLSearchParams({
    response_type: "code", client_id: "tf-macos", redirect_uri: "trafficflow://auth",
    code_challenge: challenge, code_challenge_method: "S" + "256", state: "xyz", scope: "full",
  }).toString();
}

async function register(deps: ApiDeps, email: string): Promise<{ userId: string; accountId: string }> {
  const res = await H(
    req("POST", "/auth/register", { body: JSON.stringify({ email, password: PW, displayName: "Gil", inviteCode: "INVITE-OK" }) }),
    deps,
  );
  expect(res.status).toBe(201);
  const { user } = await res.json();
  return { userId: user.userId, accountId: user.accountId };
}

/** A signed-in browser, step-up fresh — what the ambient GET rides on. */
async function signedIn(db: Db, id: { userId: string; accountId: string }, now: Date) {
  const { token, sessionId } = await seedSessionFor(db, { ...id, now, lastTwofaAt: now });
  return {
    token, sessionId,
    cookie: `tf_session=${token}; tf_csrf=${CSRF(token)}`,
    headers: { "x-csrf-token": CSRF(token) },
  };
}

/** Walk the ceremony to the point a code exists, the way the product walks it. */
async function ceremony(deps: ApiDeps, who: { cookie: string; headers: Record<string, string> }, challenge?: string) {
  const get = await H(req("GET", `/oauth/authorize?${authorizeQuery(challenge)}`, { cookie: who.cookie }), deps);
  expect(get.status).toBe(302);
  const bounce = new URL(get.headers.get("location")!);
  const request = bounce.searchParams.get("request")!;
  const post = await H(
    req("POST", "/oauth/authorize", { cookie: who.cookie, headers: who.headers, body: JSON.stringify({ request }) }),
    deps,
  );
  return { get, bounce, request, post };
}

describe("the redirect lands on a confirmation, not on an action", () => {
  it("a GET with valid ambient cookies mints NOTHING: no code in the bounce, and nothing in it is exchangeable", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const who = await signedIn(db, id, clock.now());
    const before = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, id.userId));

    // Composed by somebody else, clicked by the victim: the challenge is the ATTACKER's, so a code
    // reaching them is a full native session on their machine.
    const res = await H(
      req("GET", `/oauth/authorize?${authorizeQuery(s256(HOSTILE_VERIFIER))}`, { cookie: `tf_session=${who.token}` }),
      deps,
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);

    // It goes to OUR app, never to the client's redirect_uri.
    expect(location.protocol).toBe("http:");
    expect(location.searchParams.get("code")).toBeNull();

    // The decisive half: every value the response carries, tried at the token door. A ceremony
    // handle is not a code, and asserting only "no `code` parameter" would pass for a response
    // that simply renamed one.
    const carried = [...location.searchParams.values()];
    expect(carried.length).toBeGreaterThan(0);
    for (const value of carried) {
      const spend = await H(
        req("POST", "/oauth/token", {
          body: JSON.stringify({
            grant_type: "authorization_code", code: value, redirect_uri: "trafficflow://auth",
            client_id: "tf-macos", code_verifier: HOSTILE_VERIFIER,
          }),
        }),
        deps,
      );
      expect(spend.status).toBe(400);
    }

    // And the GET established nothing: the session set is exactly what it was before the click.
    const after = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, id.userId));
    expect(after.map((s) => s.id).sort()).toEqual(before.map((s) => s.id).sort());
  });

  it("the ordinary ceremony still completes — GET, read, confirm, exchange (the positive control)", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const who = await signedIn(db, id, clock.now());

    const get = await H(req("GET", `/oauth/authorize?${authorizeQuery()}`, { cookie: who.cookie }), deps);
    expect(get.status).toBe(302);
    const bounce = new URL(get.headers.get("location")!);
    const request = bounce.searchParams.get("request")!;
    expect(request).toBeTruthy();

    // The page reads what it is about to confirm. The read spends nothing.
    const read = await H(req("GET", `/oauth/authorize/request?request=${request}`, { cookie: who.cookie }), deps);
    expect(read.status).toBe(200);
    const shown = await read.json();
    expect(shown.clientId).toBe("tf-macos");
    expect(shown.redirectUri).toBe("trafficflow://auth");
    // Masked as the product masks: the domain stays, the local part does not.
    expect(shown.address).not.toBe("gil@x.example");
    expect(shown.address.endsWith("@x.example")).toBe(true);

    const post = await H(
      req("POST", "/oauth/authorize", { cookie: who.cookie, headers: who.headers, body: JSON.stringify({ request }) }),
      deps,
    );
    expect(post.status).toBe(200);
    const redirect = new URL((await post.json()).redirect);
    const code = redirect.searchParams.get("code")!;
    expect(code).toBeTruthy();
    expect(redirect.searchParams.get("state")).toBe("xyz");

    const exchange = await H(
      req("POST", "/oauth/token", {
        body: JSON.stringify({
          grant_type: "authorization_code", code, redirect_uri: "trafficflow://auth",
          client_id: "tf-macos", code_verifier: VERIFIER,
        }),
      }),
      deps,
    );
    expect(exchange.status).toBe(200);
    expect((await exchange.json()).accessToken).toBeTruthy();
  });

  it("the confirming POST without the CSRF token is refused", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const who = await signedIn(db, id, clock.now());

    const get = await H(req("GET", `/oauth/authorize?${authorizeQuery()}`, { cookie: who.cookie }), deps);
    const request = new URL(get.headers.get("location")!).searchParams.get("request")!;

    const bare = await H(
      req("POST", "/oauth/authorize", { cookie: `tf_session=${who.token}`, body: JSON.stringify({ request }) }),
      deps,
    );
    expect(bare.status).toBe(403);
    expect((await bare.json()).error.code).toBe("csrf_failed");
  });

  it("the request nonce is SINGLE-USE: one confirmation, one code", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const who = await signedIn(db, id, clock.now());

    const first = await ceremony(deps, who);
    expect(first.post.status).toBe(200);

    const again = await H(
      req("POST", "/oauth/authorize", {
        cookie: who.cookie, headers: who.headers, body: JSON.stringify({ request: first.request }),
      }),
      deps,
    );
    expect(again.status).toBe(400);
    expect((await again.json()).error.code).toBe("invalid_grant");
  });

  it("a nonce minted under one session cannot be confirmed by another session of the SAME user", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const starter = await signedIn(db, id, clock.now());
    const other = await signedIn(db, id, clock.now());

    const get = await H(req("GET", `/oauth/authorize?${authorizeQuery()}`, { cookie: starter.cookie }), deps);
    const request = new URL(get.headers.get("location")!).searchParams.get("request")!;

    const stolen = await H(
      req("POST", "/oauth/authorize", {
        cookie: other.cookie, headers: other.headers, body: JSON.stringify({ request }),
      }),
      deps,
    );
    expect(stolen.status).toBe(400);
    expect((await stolen.json()).error.code).toBe("invalid_grant");
  });

  it("an unknown nonce is refused, and a missing one too", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const who = await signedIn(db, id, clock.now());

    for (const body of [JSON.stringify({ request: "not-a-real-handle" }), JSON.stringify({})]) {
      const res = await H(
        req("POST", "/oauth/authorize", { cookie: who.cookie, headers: who.headers, body }),
        deps,
      );
      expect(res.status).toBe(400);
    }
  });
});

describe("a burned code revokes what it minted", () => {
  it("the second presentation is refused AND the session the first minted is dead", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const who = await signedIn(db, id, clock.now());

    const walked = await ceremony(deps, who);
    expect(walked.post.status).toBe(200);
    const code = new URL((await walked.post.json()).redirect).searchParams.get("code")!;

    const first = await H(
      req("POST", "/oauth/token", {
        body: JSON.stringify({
          grant_type: "authorization_code", code, redirect_uri: "trafficflow://auth",
          client_id: "tf-macos", code_verifier: VERIFIER,
        }),
      }),
      deps,
    );
    expect(first.status).toBe(200);
    const minted = await first.json();

    // The credential works before the replay — otherwise the assertion below proves nothing.
    const before = await H(
      req("GET", "/auth/session", { headers: { authorization: `Bearer ${minted.accessToken}` } }),
      deps,
    );
    expect(before.status).toBe(200);

    const replay = await H(
      req("POST", "/oauth/token", {
        body: JSON.stringify({
          grant_type: "authorization_code", code, redirect_uri: "trafficflow://auth",
          client_id: "tf-macos", code_verifier: VERIFIER,
        }),
      }),
      deps,
    );
    expect(replay.status).toBe(400);
    expect((await replay.json()).error.code).toBe("invalid_grant");

    // THE HALF THAT WAS MISSING. A second party held the code, so what it bought is withdrawn.
    const after = await H(
      req("GET", "/auth/session", { headers: { authorization: `Bearer ${minted.accessToken}` } }),
      deps,
    );
    expect(after.status).toBe(401);

    const rotate = await H(
      req("POST", "/oauth/token", {
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: minted.refreshToken }),
      }),
      deps,
    );
    expect(rotate.status).toBeGreaterThanOrEqual(400);

    // Read at the rows, so "revoked" is not a claim about one token's luck.
    const live = await db.select().from(sessions).where(eq(sessions.userId, id.userId));
    const native = live.filter((s) => s.deviceId !== null);
    expect(native.length).toBeGreaterThan(0);
    for (const s of native) expect(s.revokedAt).not.toBeNull();
    const families = [...new Set(native.map((s) => s.familyId))];
    for (const family of families) {
      const rows = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, family));
      for (const r of rows) expect(r.revokedAt).not.toBeNull();
    }
  });

  it("the replay writes ONE line carrying the class and the count, and never the code", async () => {
    const { db, deps, clock } = await makeDeps();
    const id = await register(deps, "gil@x.example");
    const who = await signedIn(db, id, clock.now());

    const walked = await ceremony(deps, who);
    const code = new URL((await walked.post.json()).redirect).searchParams.get("code")!;
    const spend = JSON.stringify({
      grant_type: "authorization_code", code, redirect_uri: "trafficflow://auth",
      client_id: "tf-macos", code_verifier: VERIFIER,
    });

    const first = await H(req("POST", "/oauth/token", { body: spend }), deps);
    expect(first.status).toBe(200);

    // The sink is handed the SERIALIZED line, which is the form that actually ships — so the
    // "never the code" assertion below is made against the bytes a log file would hold.
    const lines: string[] = [];
    const logged = { ...deps, logger: createLogger({ service: "api", sink: (l) => lines.push(String(l)) }) };
    const replay = await H(req("POST", "/oauth/token", { body: spend }), logged as ApiDeps);
    expect(replay.status).toBe(400);

    const said = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.event === "oauth_code_replayed");
    expect(said).toHaveLength(1);
    expect(said[0]!.kind).toBe("authorization_code");
    expect(said[0]!.count).toBeTypeOf("number");
    expect(said[0]!.count).toBeGreaterThan(0);

    // The code never reaches a log. Every line, as written, so a nested field cannot hide it.
    expect(lines.some((l) => l.includes(code))).toBe(false);
    void (db as Db);
  });
});
