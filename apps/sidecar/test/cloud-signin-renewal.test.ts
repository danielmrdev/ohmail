import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaticKeyProvider } from "@trafficflow/core/mail";
import { loadSealedTokens } from "../src/cloud-auth.js";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { cloudSignIn, redeemPairingToken, tokensFromSetCookie } from "../src/cloud-signin.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * A SIGN-IN'S PAIR RENEWS ON SCHEDULE, NOT ON THE FIRST 401. The engine's own sign-in routes, on
 * a fake clock: the hosted door names a 900 s window, and the renewal must go out at its fixed share of it
 * (give or take its jitter) with no request in flight and no 401 answered first. Before the fix the pair armed no
 * timer — an idle window met a 401 at +900 s and only then renewed.
 */

const WINDOW_S = 900;
const MAILBOX = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ring = { 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) };

const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const send = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/**
 * The hosted API: an access token dies WINDOW_S after it is minted; every answer is recorded. A
 * COOKIE host (ohmail Cloud's own) answers the password door's pair as `Set-Cookie`, the window as
 * the access cookie's Max-Age, and no pair in the body — the shape the live reading met.
 */
function hosted(signIn: "password" | "approval" | "password-cookie") {
  const minted = new Map<string, number>();
  const answered: Array<{ path: string; status: number; at: number }> = [];
  const refreshes: number[] = [];
  let n = 0;
  const pair = (): Response => {
    n += 1;
    minted.set(`access-${n}`, Date.now());
    return send({ tokens: { accessToken: `access-${n}`, refreshToken: `refresh-${n}`, tokenType: "Bearer", expiresIn: WINDOW_S } });
  };
  const cookiePair = (): Response => {
    n += 1;
    minted.set(`access-${n}`, Date.now());
    const h = new Headers({ "content-type": "application/json" });
    h.append("set-cookie", `tf_session=access-${n}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=${WINDOW_S}`);
    h.append("set-cookie", `tf_refresh=refresh-${n}; HttpOnly; SameSite=Strict; Secure; Path=/auth/refresh; Max-Age=2592000`);
    h.append("set-cookie", `tf_csrf=c-${n}; SameSite=Strict; Secure; Path=/; Max-Age=${WINDOW_S}`);
    return new Response(JSON.stringify({ status: "authenticated", user: { email: "me@ohmail.test" } }), { status: 200, headers: h });
  };
  const route = (path: string, init?: RequestInit): Response => {
    if (path === "/auth/login") return send({ status: "twofa_required", loginToken: "lt-1" });
    if (path === "/auth/2fa/totp/verify" && signIn === "password") return pair();
    if (path === "/auth/2fa/totp/verify" && signIn === "password-cookie") return cookiePair();
    if (path === "/auth/desktop-approval") return send({ approvalId: "4f9a3c1e-2b7d-4e8f-9a01-23456789abcd", expiresIn: 300 });
    if (path === "/auth/desktop-approval/claim" && signIn === "approval") return pair();
    if (path === "/auth/refresh") {
      refreshes.push(Date.now());
      return pair();
    }
    const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    const at = minted.get(bearer);
    if (at === undefined || Date.now() - at >= WINDOW_S * 1000) return send({ error: { code: "unauthorized" } }, 401);
    if (path === "/auth/session") return send({ user: { email: "me@ohmail.test" }, scope: "full" });
    if (path === "/mailboxes") return send(mailboxList([hostedMailbox(MAILBOX, "me@ohmail.test")]));
    if (path === "/sync") return send({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: Buffer.from("1").toString("base64url"), hasMore: false, serverTime: new Date().toISOString(),
    });
    if (path === "/messages/bodies") return send({ items: [], nextCursor: null });
    return new Response("not found", { status: 404 });
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const res = route(url.pathname, init);
    answered.push({ path: url.pathname, status: res.status, at: Date.now() });
    return res;
  }) as unknown as typeof fetch;
  return { fetchImpl, answered, refreshes };
}

async function boot(fetchImpl: typeof fetch): Promise<{ sidecar: CloudSidecar; dataDir: string }> {
  const dataDir = await freshDataDir("ohmail-signin-renewal-");
  dirs.push(dataDir);
  const sidecar = await createCloudSidecar({
    dataDir, cloudUrl: "https://cloud.test", handoffBase: "https://cloud.test", address: "me@ohmail.test",
    keks: ring, fetchImpl, pollIntervalMs: 3_600_000,
  });
  sidecars.push(sidecar);
  return { sidecar, dataDir };
}

const post = (s: CloudSidecar, path: string, body: unknown): Promise<Response> =>
  s.handle(new Request(`http://sidecar${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

async function signInBy(s: CloudSidecar, how: "password" | "approval" | "password-cookie"): Promise<void> {
  if (how === "approval") {
    expect((await post(s, "/cloud/signin/approval", {})).status).toBe(200);
    const done = await post(s, "/cloud/signin", { approval: true });
    expect(done.status, await done.clone().text()).toBe(200);
  } else {
    const done = await post(s, "/cloud/signin", { email: "me@ohmail.test", password: "pw", totp: "123456" });
    expect(done.status, await done.clone().text()).toBe(200);
  }
  expect(s.signedIn()).toBe(true);
}

describe("a sign-in arms the scheduled renewal", () => {
  for (const how of ["password", "approval", "password-cookie"] as const) {
    it(`${how}: renews at 80 % of the window with no request in flight, and the seal rotates`, { timeout: 60_000 }, async () => {
      const h = hosted(how);
      const { sidecar, dataDir } = await boot(h.fetchImpl);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });
      await signInBy(sidecar, how);
      const signedInAt = Date.now();
      await vi.advanceTimersByTimeAsync(WINDOW_S * 1000 * 0.74);
      expect(h.refreshes, "nothing renews before the schedule").toHaveLength(0);

      await vi.advanceTimersByTimeAsync(WINDOW_S * 1000 * 0.13);
      expect(h.refreshes, "the sign-in's pair was never renewed ahead of expiry").toHaveLength(1);
      const share = (h.refreshes[0]! - signedInAt) / (WINDOW_S * 1000);
      expect(share).toBeGreaterThanOrEqual(0.74);
      expect(share).toBeLessThanOrEqual(0.86);
      expect(h.answered.filter((a) => a.status === 401), "a request met a 401 before the renewal").toEqual([]);

      const sealed = await loadSealedTokens(join(dataDir, "cloud-tokens.seal"), new StaticKeyProvider(ring));
      expect(sealed, "the seal holds the renewed pair and the end of its window").toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
      const ends = Date.parse(sealed!.expiresAt ?? "") - h.refreshes[0]!;
      expect(ends, "the sealed window is the renewal's own").toBeGreaterThanOrEqual(WINDOW_S * 1000);
      expect(ends).toBeLessThan(WINDOW_S * 1000 + 1_000);
      const health = (await (await sidecar.handle(new Request("http://sidecar/health"))).json()) as { session: { state: string } | null };
      expect(health.session?.state).toBe("live");
    });
  }

  it("the launch: a pair resumed from the seal renews at 80 % of what is left of its window, with no 401 first", { timeout: 60_000 }, async () => {
    const h = hosted("password");
    const first = await boot(h.fetchImpl);
    await signInBy(first.sidecar, "password");
    await first.sidecar.stop();
    sidecars.splice(sidecars.indexOf(first.sidecar), 1);
    const sealed = await loadSealedTokens(join(first.dataDir, "cloud-tokens.seal"), new StaticKeyProvider(ring));
    expect(sealed?.expiresAt, "the sign-in sealed no window").toBeDefined();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });
    const launchedAt = Date.now();
    const again = await createCloudSidecar({
      dataDir: first.dataDir, cloudUrl: "https://cloud.test", handoffBase: "https://cloud.test", address: "me@ohmail.test",
      keks: ring, fetchImpl: h.fetchImpl, pollIntervalMs: 3_600_000,
    });
    sidecars.push(again);
    const answeredBefore = h.answered.length;
    await again.start();
    const leftMs = Date.parse(sealed!.expiresAt!) - launchedAt;
    await vi.advanceTimersByTimeAsync(leftMs * 0.95);
    expect(h.refreshes, "the launch renewed nothing ahead of the sealed window's end").toHaveLength(1);
    const share = (h.refreshes[0]! - launchedAt) / leftMs;
    expect(share).toBeGreaterThanOrEqual(0.74);
    expect(share).toBeLessThanOrEqual(0.86);
    expect(h.answered.slice(answeredBefore).filter((a) => a.status === 401), "a request met a 401 before the renewal").toEqual([]);
  });
});

describe("the three readers keep the window beside the pair", () => {
  const answering = (expiresIn: unknown) => (async (input: string | URL | Request): Promise<Response> => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    if (path === "/auth/login") return send({ status: "twofa_required", loginToken: "lt-1" });
    return send({ tokens: { accessToken: "a", refreshToken: "r", tokenType: "Bearer", expiresIn } });
  }) as unknown as typeof fetch;

  it("the password door, the browser code and the pairing redeem each carry expiresIn from a body", async () => {
    const fetchImpl = answering(900);
    const opts = { baseUrl: "https://cloud.test", fetchImpl };
    expect(await cloudSignIn(opts, { email: "me@ohmail.test", password: "pw", totp: "123456" }))
      .toEqual({ accessToken: "a", refreshToken: "r", expiresIn: 900 });
    expect(await cloudSignIn(opts, { handoffCode: "code-1" })).toEqual({ accessToken: "a", refreshToken: "r", expiresIn: 900 });
    expect((await redeemPairingToken({ ...opts, deviceKind: "desktop-linux" }, "pair-1")).tokens)
      .toEqual({ accessToken: "a", refreshToken: "r", expiresIn: 900 });
  });

  it("a cookie host's pair carries the access cookie's Max-Age as its window", () => {
    const cookies = [
      "tf_session=a; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=900",
      "tf_refresh=r; HttpOnly; SameSite=Strict; Secure; Path=/auth/refresh; Max-Age=2592000",
      "tf_csrf=c; SameSite=Strict; Secure; Path=/; Max-Age=60",
    ];
    expect(tokensFromSetCookie(cookies)).toEqual({ accessToken: "a", refreshToken: "r", expiresIn: 900 });
    expect(tokensFromSetCookie(["tf_session=a; Path=/", "tf_refresh=r; Max-Age=2592000"]), "no Max-Age on the access cookie: no window")
      .toEqual({ accessToken: "a", refreshToken: "r" });
    expect(tokensFromSetCookie(["tf_session=a; Max-Age=0", "tf_refresh=r"]), "a zero Max-Age is no window").toEqual({ accessToken: "a", refreshToken: "r" });
  });

  it("a window that is not a positive number of seconds is not kept", async () => {
    for (const bad of [0, -5, "900", null, Number.NaN]) {
      const got = await cloudSignIn({ baseUrl: "https://cloud.test", fetchImpl: answering(bad) }, { handoffCode: "code-1" });
      expect(got, String(bad)).toEqual({ accessToken: "a", refreshToken: "r" });
    }
  });
});
