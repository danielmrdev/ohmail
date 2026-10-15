import { afterEach, describe, expect, it } from "vitest";
import { createCloudAuth, type CloudAuth } from "../src/cloud-auth.js";
import { createWriteThroughProxy } from "../src/cloud-proxy.js";
import type { CloudMirror } from "../src/cloud-mirror.js";

/**
 * A FACTOR PRESS THAT LEFT JUST BEFORE A RENEWAL (REVIEW-02513 LOW 1). A rotation replaces the
 * session's access hash at once, so a step-up code sent under the token being replaced is refused
 * by the session's door before the handler reads the code. That 401 is the stale token's: the code
 * goes once more under the renewed token and is read there, once. A wrong code is still the
 * account's `credential_refused`, and a factor route whose token did not move still never renews.
 */

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const STALE = { error: { code: "unauthorized", message: "authentication required" } };
const WRONG_CODE = { error: { code: "credential_refused", message: "two-factor verification failed" } };
const auths: CloudAuth[] = [];
afterEach(() => {
  for (const a of auths.splice(0)) a.stop();
});

/** The hosted API: the session's door compares the carried token with the live one once the press arrives. */
function hosted(code: "accepted" | "wrong") {
  const sent: Array<{ path: string; auth: string | null }> = [];
  let renewals = 0;
  let live = "access-1";
  let hold: Promise<void> | null = null;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path === "/auth/refresh") {
      renewals += 1;
      live = `access-${renewals + 1}`;
      return json(200, { tokens: { accessToken: live, refreshToken: `refresh-${renewals + 1}` } });
    }
    const auth = new Headers(init?.headers).get("authorization");
    sent.push({ path, auth });
    if (hold) await hold;
    if (auth !== `Bearer ${live}`) return json(401, STALE);
    return code === "accepted" ? json(200, { verified: true }) : json(401, WRONG_CODE);
  }) as typeof fetch;
  const auth = createCloudAuth({ baseUrl: "http://cloud.test", tokens: { accessToken: "access-1", refreshToken: "refresh-1" }, fetchImpl, random: () => 0.5 });
  auths.push(auth);
  return {
    auth, sent, renewals: () => renewals,
    holdPresses: () => {
      let release!: () => void;
      hold = new Promise<void>((r) => { release = r; });
      return () => { hold = null; release(); };
    },
  };
}

const postCode = (auth: CloudAuth, path = "/auth/step-up/totp") =>
  auth.authedFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "123456" }) });

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(cond(), "the condition never held").toBe(true);
}

/** The press leaves, the renew-ahead rotation lands while it is out, then the press arrives. */
async function raced(h: ReturnType<typeof hosted>, path?: string): Promise<Response> {
  const release = h.holdPresses();
  const pending = postCode(h.auth, path);
  await until(() => h.sent.length === 1);
  await h.auth.renewNow();
  release();
  return pending;
}

describe("a factor press that left before a renewal is read under the renewed token", () => {
  it("a correct step-up code is sent once more under the new token and accepted, with no second renewal", async () => {
    const h = hosted("accepted");
    const res = await raced(h);
    expect(h.sent.map((s) => s.auth), "the stale token's 401 was handed back as the answer to the code")
      .toEqual(["Bearer access-1", "Bearer access-2"]);
    expect([res.status, await res.json()]).toEqual([200, { verified: true }]);
    expect(h.renewals(), "the press renewed the session itself").toBe(1);
  });

  it("every factor route the relay forwards: a correct press racing a rotation is accepted", async () => {
    for (const path of ["/auth/step-up/webauthn/verify", "/auth/2fa/totp/activate", "/auth/2fa/webauthn/register/verify"]) {
      const h = hosted("accepted");
      const res = await raced(h, path);
      expect([res.status, h.sent.length, h.renewals()], path).toEqual([200, 2, 1]);
    }
  });

  it("a wrong code in the same race reads as the account's wrong code, read once under the new token", async () => {
    const h = hosted("wrong");
    const res = await raced(h);
    expect(h.sent.map((s) => s.auth)).toEqual(["Bearer access-1", "Bearer access-2"]);
    expect([res.status, await res.json()]).toEqual([401, WRONG_CODE]);
    expect(h.renewals()).toBe(1);
  });

  it("CONTROL: a factor route whose token did not move hands the 401 back as it came, with no renewal", async () => {
    const h = hosted("accepted");
    // The server moved on without this transport renewing: nothing here explains the 401.
    const lapsed = createCloudAuth({
      baseUrl: "http://cloud.test", tokens: { accessToken: "access-0", refreshToken: "refresh-0" },
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path === "/auth/refresh") return json(200, { tokens: { accessToken: "access-9", refreshToken: "refresh-9" } });
        h.sent.push({ path, auth: new Headers(init?.headers).get("authorization") });
        return json(401, STALE);
      }) as typeof fetch,
      random: () => 0.5,
    });
    auths.push(lapsed);
    const res = await postCode(lapsed);
    expect([res.status, await res.json(), h.sent.length], "a factor route renewed and sent the code again")
      .toEqual([401, STALE, 1]);
    expect(lapsed.currentTokens().accessToken).toBe("access-0");
  });
});

describe("the desktop's Cloud relay", () => {
  const mirror = {
    online: () => true,
    markConnectivity: () => {},
    awaitCloudSeq: async () => true,
    awaitFreshPull: async () => true,
    localSeq: async () => null,
  } as unknown as CloudMirror;

  it("a window's step-up press racing a rotation reaches the window as accepted", async () => {
    const h = hosted("accepted");
    const proxy = createWriteThroughProxy({ auth: h.auth, mirror });
    const release = h.holdPresses();
    const pending = proxy.forward(new Request("http://engine/auth/step-up/totp", {
      method: "POST", body: JSON.stringify({ code: "123456" }),
      headers: { "content-type": "application/json", "idempotency-key": "k-step" },
    }));
    await until(() => h.sent.length === 1);
    await h.auth.renewNow();
    release();
    const res = await pending;
    expect([res.status, await res.json()], "the window read a correct code as wrong").toEqual([200, { verified: true }]);
    expect([h.sent.length, h.renewals()]).toEqual([2, 1]);
  });
});
