import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudAuth, type CloudAuth } from "../src/cloud-auth.js";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { createWriteThroughProxy } from "../src/cloud-proxy.js";
import type { CloudMirror } from "../src/cloud-mirror.js";
import { freshDataDir } from "./_datadir.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";

/**
 * A CREDENTIAL ROUTE'S 401 IS AN ANSWER — the desktop's Cloud transport and the relay a window press
 * of a credential route would take. The account names a wrong code `credential_refused`, read before
 * anything renews; an account older than the code answers it `unauthorized`, which is also what a
 * lapsed access token gets, and there the route list stops the second send (the OLD-SERVER BELT
 * control below). Each 401 branch of `authedFetch` hands such a 401 back as it came; an ordinary
 * stale token still renews and replays once.
 */

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const WRONG_CODE = { error: { code: "credential_refused", message: "two-factor verification failed" } };
/** The same refusal from an account older than `credential_refused`. */
const OLD_WIRE = { error: { code: "unauthorized", message: "two-factor verification failed" } };
const auths: CloudAuth[] = [];
const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of auths.splice(0)) a.stop();
  for (const c of sidecars.splice(0)) await c.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The hosted API: a factor route refuses every code, `/messages` only the lapsed token. */
function hosted(
  refresh: () => Response = () => json(200, { tokens: { accessToken: "access-2", refreshToken: "refresh-2" } }),
  refusal: typeof WRONG_CODE = WRONG_CODE,
) {
  const sent: Array<{ path: string; auth: string | null }> = [];
  let renewals = 0;
  let hold: Promise<void> | null = null;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path === "/auth/refresh") {
      renewals += 1;
      return refresh();
    }
    const auth = new Headers(init?.headers).get("authorization");
    sent.push({ path, auth });
    if (path === "/messages" || path === "/api/messages") {
      return auth === "Bearer access-2" ? json(200, { messages: [] }) : json(401, { error: { code: "unauthorized" } });
    }
    if (hold) await hold;
    return json(401, refusal);
  }) as typeof fetch;
  const auth = createCloudAuth({ baseUrl: "http://cloud.test", tokens: { accessToken: "access-1", refreshToken: "refresh-1" }, fetchImpl, random: () => 0.5 });
  auths.push(auth);
  return {
    auth, sent, renewals: () => renewals,
    holdFactorAnswers: () => {
      let release!: () => void;
      hold = new Promise<void>((r) => { release = r; });
      return release;
    },
  };
}

const postCode = (auth: CloudAuth) =>
  auth.authedFetch("/auth/step-up/totp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "000000" }) });

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(cond(), "the condition never held").toBe(true);
}

describe("the desktop's Cloud transport hands a credential route's 401 back as it came", () => {
  it("a wrong step-up code is posted once, nothing renews, and the caller reads the account's 401", async () => {
    const h = hosted();
    const res = await postCode(h.auth);
    expect(h.sent.map((s) => s.path), "the code went out twice").toEqual(["/auth/step-up/totp"]);
    expect(h.renewals(), "a wrong code rotated the session").toBe(0);
    expect([res.status, await res.json()]).toEqual([401, WRONG_CODE]);
    expect(h.auth.session().state).toBe("live");
  });

  it("THE CODE IS READ FIRST: credential_refused on a route no list names is posted once and handed back", async () => {
    const h = hosted();
    const res = await h.auth.authedFetch("/auth/confirm-by-code", { method: "POST" });
    expect([res.status, await res.json(), h.sent.length, h.renewals()]).toEqual([401, WRONG_CODE, 1, 0]);
    // CONTROL: the same route answering a lapsed session's 401 renews and replays.
    const old = hosted(undefined, OLD_WIRE);
    await old.auth.authedFetch("/auth/confirm-by-code", { method: "POST" });
    expect([old.sent.length, old.renewals()]).toEqual([2, 1]);
  });

  it("a token renewed while the code was out does not send the code again under it", async () => {
    const h = hosted();
    const release = h.holdFactorAnswers();
    const pending = postCode(h.auth);
    await until(() => h.sent.length === 1);
    await h.auth.renewNow();
    release();
    const res = await pending;
    expect(h.sent.map((s) => s.auth), "the code went out again under the renewed token").toEqual(["Bearer access-1"]);
    expect([res.status, await res.json()]).toEqual([401, WRONG_CODE]);
  });

  it("a renewal already retrying on its own clock does not turn the answer into an offline refusal", async () => {
    const h = hosted(() => json(503, { error: { code: "busy" } }));
    expect((await h.auth.authedFetch("/messages")).status, "control: the fault is what armed the retry").toBe(503);
    const res = await postCode(h.auth);
    expect([res.status, await res.json()]).toEqual([401, WRONG_CODE]);
    expect(h.sent.filter((s) => s.path === "/auth/step-up/totp")).toHaveLength(1);
  });

  it("POSITIVE: a stale access token on /messages still renews once and replays once", async () => {
    const h = hosted();
    const res = await h.auth.authedFetch("/messages");
    expect(res.status).toBe(200);
    expect(h.renewals()).toBe(1);
    expect(h.sent).toEqual([
      { path: "/messages", auth: "Bearer access-1" },
      { path: "/messages", auth: "Bearer access-2" },
    ]);
  });
});

describe("the relay hands the window the account's answer to a wrong code", () => {
  const mirror = {
    online: () => true,
    markConnectivity: () => {},
    awaitCloudSeq: async () => true,
    awaitFreshPull: async () => true,
    localSeq: async () => null,
  } as unknown as CloudMirror;
  const press = (path: string, method = "POST", body: unknown = { code: "000000" }) =>
    new Request(`http://engine${path}`, { method, body: JSON.stringify(body), headers: { "content-type": "application/json", "idempotency-key": "k-1" } });

  it("a wrong step-up code relayed from the window reads as a wrong code, sent once", async () => {
    const h = hosted();
    const proxy = createWriteThroughProxy({ auth: h.auth, mirror });
    const res = await proxy.forward(press("/auth/step-up/totp"));
    expect([res.status, await res.json()], "the window was told it is not signed in").toEqual([401, WRONG_CODE]);
    expect([h.sent.length, h.renewals()]).toEqual([1, 0]);
  });

  /* The relay forwards a spelling its allowlist canonicalizes, raw: the `/api` mount, doubled slashes
   * and escapes name the same credential route, so the relay and the transport decide on that route.
   * OLD-SERVER BELT CONTROL: the account here names no verdict, so only the list stops the resend. */
  it("every spelling of a credential route is sent once and handed back as the account's 401", async () => {
    for (const path of ["/api/auth/step-up/totp", "//auth/step-up/totp", "/auth//step-up/totp", "/auth/step-up/%74otp",
      "/api/auth/step-up/webauthn/verify", "/api/auth/2fa/totp/activate", "/api/auth/2fa/webauthn/register/verify",
      "/api/auth/2fa/webauthn/assert/options"]) {
      const h = hosted(undefined, OLD_WIRE);
      const res = await createWriteThroughProxy({ auth: h.auth, mirror }).forward(press(path));
      expect([res.status, h.sent.length, h.renewals()], path).toEqual([401, 1, 0]);
      expect(await res.json(), path).toEqual(OLD_WIRE);
    }
    // CONTROL: an ordinary route under the mount still renews once and replays once.
    const h = hosted();
    await h.auth.authedFetch("/api/messages");
    expect([h.sent.length, h.renewals()]).toEqual([2, 1]);
  });

  it("CONTROL: an ordinary write whose session ended is still answered the signed-out wait", async () => {
    const h = hosted(() => json(401, { error: { code: "refresh_revoked", message: "revoked" } }));
    const proxy = createWriteThroughProxy({ auth: h.auth, mirror });
    const res = await proxy.forward(press("/messages/11111111-1111-4111-8111-111111111111/move", "POST", { folder: "Archive" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_signed_in");
  });
});

describe("the window's own press, through the desktop's door", () => {
  it("a wrong step-up code reaches the window as the account's 401, sent once, with no renewal", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-wrong-code-"); dirs.push(dataDir);
    const seen = { stepUps: 0, renewals: 0 };
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/auth/refresh") {
        seen.renewals += 1;
        return json(200, { tokens: { accessToken: "minted-access", refreshToken: "minted-refresh" } });
      }
      if (url.pathname === "/auth/step-up/totp") {
        seen.stepUps += 1;
        return json(401, WRONG_CODE);
      }
      if (url.pathname === "/mailboxes") return json(200, mailboxList([hostedMailbox("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "me@ohmail.test")]));
      if (url.pathname === "/sync") {
        return json(200, { changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c", hasMore: false, serverTime: new Date().toISOString() });
      }
      if (url.pathname === "/messages/bodies") return json(200, { items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const sidecar = await createCloudSidecar({
      dataDir, cloudUrl: "https://host.test", address: "me@ohmail.test", fetchImpl,
      pollIntervalMs: 3_600_000, keks: { 1: Buffer.alloc(32, 7) }, tokens: { accessToken: "held-access", refreshToken: "held-refresh" },
    });
    sidecars.push(sidecar);
    const res = await sidecar.handle(new Request("http://sidecar/auth/step-up/totp", {
      method: "POST",
      headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ code: "000000" }),
    }));
    expect([res.status, await res.json()], "the window did not read the account's answer").toEqual([401, WRONG_CODE]);
    expect(seen).toEqual({ stepUps: 1, renewals: 0 });
  });
});
