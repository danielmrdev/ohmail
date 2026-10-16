import { describe, it, expect } from "vitest";
import {
  requestDeviceCode, pollDeviceCodeOnce, pollDeviceCodeUntilDone,
  microsoftDeviceCodeEndpoint, loopbackRedirectUri, isLoopbackRedirectUri,
  DEVICE_CODE_GRANT_TYPE, MS_DEVICE_ENV, msDeviceEnv, deviceFlowAvailable,
  type DeviceCodeGrant,
} from "../../src/oauth/microsoft-device.js";
import {
  OAuthConfigError, OAuthProviderUnavailableError, clientAuthFields,
  refreshAccessToken, exchangeAuthorizationCode, MicrosoftTokenProvider,
  MS_CLIENT_ID_ENV, wantedClientKind,
  type FetchLike, type MicrosoftOAuthRuntime,
} from "../../src/oauth/microsoft.js";
import { buildImapAuth } from "../../src/adapters/imap-auth.js";
import { StaticKeyProvider } from "../../src/crypto.js";

/**
 * A FAKE IDENTITY PROVIDER. Every test drives Microsoft's behaviour through this — no network, no
 * credentials, no clock. It records the URL as well as the body, because half of what is under test
 * here is WHICH ENDPOINT was called and WHICH FIELDS were on the form (a `client_secret` that must
 * not be there is invisible to a fake that only checks the response).
 */
function fakeIdp(handler: (req: { url: string; body: URLSearchParams; call: number }) => {
  status: number; json?: unknown; throwNetwork?: boolean; unparseable?: boolean;
}): { fetch: FetchLike; calls: { url: string; body: URLSearchParams }[] } {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = new URLSearchParams(init.body);
    calls.push({ url, body });
    const r = handler({ url, body, call: calls.length });
    if (r.throwNetwork) throw Object.assign(new Error("ECONNREFUSED"), { name: "FetchError" });
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => {
        if (r.unparseable) throw new SyntaxError("Unexpected token < in JSON");
        return r.json;
      },
      text: async () => JSON.stringify(r.json ?? {}),
    };
  };
  return { fetch, calls };
}

const GRANT = {
  device_code: "DEVICE-SECRET", user_code: "ABCD-EFGH",
  verification_uri: "https://microsoft.com/devicelogin", expires_in: 900, interval: 5,
};

describe("microsoftDeviceCodeEndpoint — the endpoint is DERIVED, never stored", () => {
  it("derives the device endpoint from the tenant SEGMENT", () => {
    expect(microsoftDeviceCodeEndpoint("common"))
      .toBe("https://login.microsoftonline.com/common/oauth2/v2.0/devicecode");
    const guid = "12345678-1234-1234-1234-1234567890ab";
    expect(microsoftDeviceCodeEndpoint(guid)).toBe(
      `https://login.microsoftonline.com/${guid}/oauth2/v2.0/devicecode`,
    );
  });

  it("REFUSES an injected host or a traversal — the same closed shape as the token endpoint", () => {
    for (const bad of ["../evil", "common/../../x", "evil-com.example", "tenant with spaces", "", "http://x"]) {
      expect(() => microsoftDeviceCodeEndpoint(bad), bad).toThrow(OAuthConfigError);
    }
  });
});

describe("clientAuthFields — the seam that decides whether a secret goes on the wire", () => {
  it("a PUBLIC client sends client_id and NO client_secret key at all", () => {
    const f = clientAuthFields("public", "cid", undefined);
    expect(f).toEqual({ client_id: "cid" });
    // Not merely empty — ABSENT. An empty value is a present-but-blank credential to Entra.
    expect(Object.keys(f)).not.toContain("client_secret");
  });

  it("a public client handed a SECRET is REFUSED — the two doors must not be mixed", () => {
    expect(() => clientAuthFields("public", "cid", "leaked-secret")).toThrow(OAuthConfigError);
  });

  it("a CONFIDENTIAL client sends both", () => {
    expect(clientAuthFields("confidential", "cid", "csec"))
      .toEqual({ client_id: "cid", client_secret: "csec" });
  });

  it("a confidential client with an EMPTY secret is the NAMED refusal, not a public request", () => {
    // THE FAIL-OPEN THIS EXISTS TO CLOSE: without the named refusal, a deployment whose secret
    // failed to resolve would emit a public token request, get `invalid_client`, and have it mapped
    // to "provider unavailable" — a configuration fault indistinguishable from a Microsoft outage.
    for (const empty of ["", "   ", undefined]) {
      const err = (() => { try { clientAuthFields("confidential", "cid", empty); } catch (e) { return e; } })();
      expect(err, String(empty)).toBeInstanceOf(OAuthConfigError);
      expect((err as OAuthConfigError).configVar).toBe("MS_OAUTH_CLIENT_SECRET");
    }
  });
});

describe("the PUBLIC client never puts a secret on the wire", () => {
  it("refreshAccessToken with clientKind public omits client_secret entirely", async () => {
    const { fetch, calls } = fakeIdp(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600 } }));
    await refreshAccessToken({
      refreshToken: "RT", tenant: "common", clientId: "cid", clientKind: "public", fetch,
    }, () => 1_000);
    expect(calls[0]!.body.has("client_secret")).toBe(false);
    expect(calls[0]!.body.get("client_id")).toBe("cid");
    expect(calls[0]!.body.get("grant_type")).toBe("refresh_token");
  });

  it("exchangeAuthorizationCode with clientKind public omits it too — the desktop PKCE door", async () => {
    const { fetch, calls } = fakeIdp(() => ({
      status: 200, json: { access_token: "AT", refresh_token: "RT", expires_in: 3600 },
    }));
    await exchangeAuthorizationCode({
      code: "CODE", codeVerifier: "VERIFIER", redirectUri: loopbackRedirectUri(51789),
      tenant: "common", clientId: "cid", clientKind: "public", fetch,
    }, () => 1_000);
    expect(calls[0]!.body.has("client_secret")).toBe(false);
    // PKCE is what authenticates this exchange in place of the secret, so the verifier must be there.
    expect(calls[0]!.body.get("code_verifier")).toBe("VERIFIER");
    expect(calls[0]!.body.get("redirect_uri")).toBe("http://127.0.0.1:51789/oauth/microsoft");
  });

  it("the DEFAULT is still confidential — an omitted kind can never silently go public", async () => {
    const { fetch, calls } = fakeIdp(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600 } }));
    await refreshAccessToken({
      refreshToken: "RT", tenant: "common", clientId: "cid", clientSecret: "csec", fetch,
    }, () => 1_000);
    expect(calls[0]!.body.get("client_secret")).toBe("csec");
  });
});

describe("requestDeviceCode — step 1, and it is a PUBLIC client", () => {
  it("POSTs to the device endpoint with no secret, and returns the user-facing pair", async () => {
    const { fetch, calls } = fakeIdp(() => ({ status: 200, json: GRANT }));
    const grant = await requestDeviceCode({ tenant: "common", clientId: "cid", fetch }, () => 1_000);

    expect(calls[0]!.url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/devicecode");
    expect(calls[0]!.body.has("client_secret")).toBe(false);
    expect(calls[0]!.body.get("scope")).toContain("offline_access");
    expect(calls[0]!.body.get("scope")).toContain("IMAP.AccessAsUser.All");
    expect(calls[0]!.body.get("scope")).toContain("SMTP.Send");

    expect(grant.userCode).toBe("ABCD-EFGH");
    expect(grant.verificationUri).toBe("https://microsoft.com/devicelogin");
    expect(grant.deviceCode).toBe("DEVICE-SECRET");
    expect(grant.expiresAtMs).toBe(1_000 + 900_000);
    expect(grant.intervalMs).toBe(5_000);
  });

  it("does NOT ask for openid/email by default — identity scopes are opt-in on this door", async () => {
    const { fetch, calls } = fakeIdp(() => ({ status: 200, json: GRANT }));
    await requestDeviceCode({ tenant: "common", clientId: "cid", fetch });
    expect(calls[0]!.body.get("scope")).not.toContain("openid");
  });

  it("CLAMPS a hostile interval and ttl — a 0 would be a hot loop against the shared client id", async () => {
    const { fetch } = fakeIdp(() => ({ status: 200, json: { ...GRANT, interval: 0, expires_in: 0 } }));
    const grant = await requestDeviceCode({ tenant: "common", clientId: "cid", fetch }, () => 1_000);
    expect(grant.intervalMs).toBe(5_000);
    // An expires_in of 0 would report the ceremony expired before the person could approve it.
    expect(grant.expiresAtMs).toBe(1_000 + 30_000);
  });

  it("clamps the OTHER way too — an absurd ttl or interval cannot strand a ceremony", async () => {
    const { fetch } = fakeIdp(() => ({ status: 200, json: { ...GRANT, interval: 9_999, expires_in: 9_999_999 } }));
    const grant = await requestDeviceCode({ tenant: "common", clientId: "cid", fetch }, () => 0);
    expect(grant.intervalMs).toBe(60_000);
    expect(grant.expiresAtMs).toBe(30 * 60_000);
  });

  it("an INCOMPLETE grant is refused rather than returned as a half-ceremony", async () => {
    for (const missing of ["device_code", "user_code", "verification_uri"]) {
      const json: Record<string, unknown> = { ...GRANT };
      delete json[missing];
      const { fetch } = fakeIdp(() => ({ status: 200, json }));
      await expect(
        requestDeviceCode({ tenant: "common", clientId: "cid", fetch }), missing,
      ).rejects.toThrow(OAuthProviderUnavailableError);
    }
  });

  it("a 4xx, a 5xx, a network throw and an unparseable body are all UNAVAILABLE, never a verdict", async () => {
    for (const r of [
      { status: 400, json: { error: "unauthorized_client" } },
      { status: 503 },
      { status: 200, throwNetwork: true },
      { status: 200, unparseable: true },
    ]) {
      const { fetch } = fakeIdp(() => r);
      await expect(
        requestDeviceCode({ tenant: "common", clientId: "cid", fetch }), JSON.stringify(r),
      ).rejects.toThrow(OAuthProviderUnavailableError);
    }
  });

  it("an EMPTY body on a 4xx is still the honest verdict, not a TypeError", async () => {
    // `res.json()` RESOLVES to undefined/null for an empty body — no throw, so a `try/catch` never
    // runs and the next property read crashes. This is the shape that escaped as
    // `Cannot read properties of undefined` before `readJsonObject` existed. A 5xx no longer reaches
    // the body read at all (it is refused on status first), so the 4xx is where this must be proven.
    for (const json of [undefined, null, "a bare string", 42]) {
      const { fetch } = fakeIdp(() => ({ status: 400, json }));
      const err = await requestDeviceCode({ tenant: "common", clientId: "cid", fetch }).catch((e) => e);
      expect(err, JSON.stringify(json) ?? "undefined").toBeInstanceOf(OAuthProviderUnavailableError);
      expect((err as Error).message).toContain("http_400");
    }
  });

  it("a 200 whose body is not an object is an incomplete grant, not a crash", async () => {
    for (const json of [undefined, null, "nope"]) {
      const { fetch } = fakeIdp(() => ({ status: 200, json }));
      const err = await requestDeviceCode({ tenant: "common", clientId: "cid", fetch }).catch((e) => e);
      expect(err, String(json)).toBeInstanceOf(OAuthProviderUnavailableError);
    }
  });

  it("never carries Microsoft's error_description — only the closed-vocabulary code", async () => {
    const { fetch } = fakeIdp(() => ({
      status: 400,
      json: {
        error: "unauthorized_client",
        error_description: "AADSTS7000218: request id 9f1c-… at 2026-09-01T00:00:00Z for https://secret",
      },
    }));
    const err = await requestDeviceCode({ tenant: "common", clientId: "cid", fetch }).catch((e) => e);
    expect(String((err as Error).message)).toContain("unauthorized_client");
    expect(String((err as Error).message)).not.toContain("AADSTS7000218");
    expect(String((err as Error).message)).not.toContain("request id");
  });
});

describe("pollDeviceCodeOnce — the four normal states RETURN, and pending is an HTTP 400", () => {
  const base = { tenant: "common", clientId: "cid", deviceCode: "DEVICE-SECRET", intervalMs: 5_000 };

  it("sends the device grant_type and the device_code, with no secret", async () => {
    const { fetch, calls } = fakeIdp(() => ({ status: 400, json: { error: "authorization_pending" } }));
    await pollDeviceCodeOnce({ ...base, fetch });
    expect(calls[0]!.url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(calls[0]!.body.get("grant_type")).toBe(DEVICE_CODE_GRANT_TYPE);
    expect(calls[0]!.body.get("device_code")).toBe("DEVICE-SECRET");
    expect(calls[0]!.body.has("client_secret")).toBe(false);
  });

  it("authorization_pending on a 400 is `pending` — NOT an outage", async () => {
    // THE TRAP THIS CLOSES: routed through the refresh mapping, this 400 would be
    // OAuthProviderUnavailableError once every five seconds for the whole ceremony.
    const { fetch } = fakeIdp(() => ({ status: 400, json: { error: "authorization_pending" } }));
    await expect(pollDeviceCodeOnce({ ...base, fetch })).resolves.toEqual({ status: "pending" });
  });

  it("slow_down returns the interval ALREADY increased by five seconds (RFC 8628 §3.5)", async () => {
    const { fetch } = fakeIdp(() => ({ status: 400, json: { error: "slow_down" } }));
    await expect(pollDeviceCodeOnce({ ...base, fetch }))
      .resolves.toEqual({ status: "slow_down", nextIntervalMs: 10_000 });
  });

  it("slow_down cannot push the interval past the ceiling", async () => {
    const { fetch } = fakeIdp(() => ({ status: 400, json: { error: "slow_down" } }));
    await expect(pollDeviceCodeOnce({ ...base, intervalMs: 58_000, fetch }))
      .resolves.toEqual({ status: "slow_down", nextIntervalMs: 60_000 });
  });

  it("both spellings of a decline are `declined`", async () => {
    for (const error of ["authorization_declined", "access_denied"]) {
      const { fetch } = fakeIdp(() => ({ status: 400, json: { error } }));
      await expect(pollDeviceCodeOnce({ ...base, fetch }), error).resolves.toEqual({ status: "declined" });
    }
  });

  it("expired_token is `expired`", async () => {
    const { fetch } = fakeIdp(() => ({ status: 400, json: { error: "expired_token" } }));
    await expect(pollDeviceCodeOnce({ ...base, fetch })).resolves.toEqual({ status: "expired" });
  });

  it("bad_verification_code THROWS — a poll loop must not spin on our own malformed code", async () => {
    const { fetch } = fakeIdp(() => ({ status: 400, json: { error: "bad_verification_code" } }));
    await expect(pollDeviceCodeOnce({ ...base, fetch })).rejects.toThrow(OAuthProviderUnavailableError);
  });

  it("a 5xx is read WITHOUT parsing the body — an HTML error page is not an OAuth verdict", async () => {
    const { fetch } = fakeIdp(() => ({ status: 503, unparseable: true }));
    await expect(pollDeviceCodeOnce({ ...base, fetch })).rejects.toThrow(OAuthProviderUnavailableError);
  });

  it("an UNKNOWN error code throws rather than being read as one of the four states", async () => {
    const { fetch } = fakeIdp(() => ({ status: 400, json: { error: "something_new" } }));
    await expect(pollDeviceCodeOnce({ ...base, fetch })).rejects.toThrow(OAuthProviderUnavailableError);
  });

  it("a grant returns all three tokens with an absolute expiry", async () => {
    const { fetch } = fakeIdp(() => ({
      status: 200,
      json: { access_token: "AT", refresh_token: "RT", id_token: "IDT", expires_in: 3600 },
    }));
    const v = await pollDeviceCodeOnce({ ...base, fetch }, () => 5_000);
    expect(v).toEqual({
      status: "granted",
      tokens: { accessToken: "AT", refreshToken: "RT", idToken: "IDT", expiresAtMs: 5_000 + 3_600_000 },
    });
  });

  it("a grant with NO refresh token reports null — the caller refuses rather than storing it", async () => {
    const { fetch } = fakeIdp(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600 } }));
    const v = await pollDeviceCodeOnce({ ...base, fetch });
    expect(v.status).toBe("granted");
    expect(v.status === "granted" && v.tokens.refreshToken).toBeNull();
  });
});

describe("pollDeviceCodeUntilDone — bounded by the GRANT, not by a poll count", () => {
  const grant = (over: Partial<DeviceCodeGrant> = {}): DeviceCodeGrant => ({
    deviceCode: "DEVICE-SECRET", userCode: "ABCD-EFGH",
    verificationUri: "https://microsoft.com/devicelogin",
    expiresAtMs: 900_000, intervalMs: 5_000, ...over,
  });

  /** A clock the test drives, advanced by the injected sleep. No real time passes. */
  function fakeClock(start = 0) {
    let t = start;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  }

  it("polls through `pending` and resolves on the grant", async () => {
    const { fetch, calls } = fakeIdp(({ call }) => (call < 3
      ? { status: 400, json: { error: "authorization_pending" } }
      : { status: 200, json: { access_token: "AT", refresh_token: "RT", expires_in: 3600 } }));
    const clock = fakeClock();
    const out = await pollDeviceCodeUntilDone({
      tenant: "common", clientId: "cid", grant: grant(), fetch, sleep: clock.sleep, now: clock.now,
    });
    expect(out.outcome).toBe("granted");
    expect(out.outcome === "granted" && out.tokens.refreshToken).toBe("RT");
    expect(calls).toHaveLength(3);
  });

  it("a `slow_down` STRETCHES the interval cumulatively for every later wait", async () => {
    const waits: number[] = [];
    const { fetch } = fakeIdp(({ call }) => {
      if (call === 1) return { status: 400, json: { error: "slow_down" } };
      if (call === 2) return { status: 400, json: { error: "slow_down" } };
      if (call === 3) return { status: 400, json: { error: "authorization_pending" } };
      return { status: 200, json: { access_token: "AT", expires_in: 3600 } };
    });
    let t = 0;
    await pollDeviceCodeUntilDone({
      tenant: "common", clientId: "cid", grant: grant(), fetch,
      sleep: async (ms) => { waits.push(ms); t += ms; }, now: () => t,
    });
    // 5s, then +5 after the first slow_down, then +5 after the second — and it STAYS at 15s for the
    // pending poll rather than resetting, which is the half a naive implementation gets wrong.
    expect(waits).toEqual([5_000, 10_000, 15_000, 15_000]);
  });

  it("stops at the DEADLINE without issuing a pointless poll", async () => {
    const { fetch, calls } = fakeIdp(() => ({ status: 400, json: { error: "authorization_pending" } }));
    const clock = fakeClock();
    const out = await pollDeviceCodeUntilDone({
      // A ceremony with room for exactly two polls.
      tenant: "common", clientId: "cid", grant: grant({ expiresAtMs: 11_000 }),
      fetch, sleep: clock.sleep, now: clock.now,
    });
    expect(out).toEqual({ outcome: "expired" });
    expect(calls).toHaveLength(2);
  });

  it("a laptop that SUSPENDED mid-ceremony expires instead of polling a dead grant", async () => {
    const { fetch, calls } = fakeIdp(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600 } }));
    let t = 0;
    const out = await pollDeviceCodeUntilDone({
      tenant: "common", clientId: "cid", grant: grant({ expiresAtMs: 900_000 }), fetch,
      // The sleep overshoots by an hour, as a suspended host's does.
      sleep: async () => { t += 3_600_000; }, now: () => t,
    });
    expect(out).toEqual({ outcome: "expired" });
    expect(calls).toHaveLength(0);
  });

  it("a decline ends the loop immediately — it is not retried", async () => {
    const { fetch, calls } = fakeIdp(() => ({ status: 400, json: { error: "authorization_declined" } }));
    const clock = fakeClock();
    const out = await pollDeviceCodeUntilDone({
      tenant: "common", clientId: "cid", grant: grant(), fetch, sleep: clock.sleep, now: clock.now,
    });
    expect(out).toEqual({ outcome: "declined" });
    expect(calls).toHaveLength(1);
  });

  it("onPending never sees the device code", async () => {
    const seen: unknown[] = [];
    const { fetch } = fakeIdp(({ call }) => (call < 2
      ? { status: 400, json: { error: "authorization_pending" } }
      : { status: 200, json: { access_token: "AT", expires_in: 3600 } }));
    const clock = fakeClock();
    await pollDeviceCodeUntilDone({
      tenant: "common", clientId: "cid", grant: grant(), fetch,
      sleep: clock.sleep, now: clock.now,
      onPending: (i) => seen.push(i),
    });
    expect(JSON.stringify(seen)).not.toContain("DEVICE-SECRET");
    expect(seen).toEqual([{ pollCount: 1, msRemaining: 895_000 }]);
  });
});

describe("the desktop door's loopback redirect", () => {
  it("uses the IP LITERAL, not localhost — name resolution must not be able to move it", () => {
    expect(loopbackRedirectUri(51789)).toBe("http://127.0.0.1:51789/oauth/microsoft");
    expect(loopbackRedirectUri(51789)).not.toContain("localhost");
  });

  it("normalises a path missing its leading slash rather than emitting a URI Entra will refuse", () => {
    expect(loopbackRedirectUri(8080, "cb")).toBe("http://127.0.0.1:8080/cb");
  });

  it("refuses anything that is not a real TCP port", () => {
    for (const bad of [0, -1, 65_536, 1.5, Number.NaN]) {
      expect(() => loopbackRedirectUri(bad), String(bad)).toThrow(OAuthConfigError);
    }
  });

  it("recognises its own URIs and REFUSES the hosted https callback", () => {
    expect(isLoopbackRedirectUri(loopbackRedirectUri(51789))).toBe(true);
    expect(isLoopbackRedirectUri("http://[::1]:51789/oauth/microsoft")).toBe(true);
    // The hosted door's URI must never be selected by the desktop one, and vice versa.
    expect(isLoopbackRedirectUri("https://ohmail.app/api/mailboxes/oauth/microsoft/callback")).toBe(false);
    // AND the scheme is load-bearing on its own, not merely a consequence of the hostname: an
    // `https://127.0.0.1` entry is not the door the desktop app binds, and a check that keyed only
    // on the host would claim it was.
    expect(isLoopbackRedirectUri("https://127.0.0.1:51789/oauth/microsoft")).toBe(false);
    // `localhost` is deliberately NOT loopback here — it resolves by name.
    expect(isLoopbackRedirectUri("http://localhost:51789/cb")).toBe(false);
    // A host that merely LOOKS local.
    expect(isLoopbackRedirectUri("http://127.0.0.1.evil.example/cb")).toBe(false);
    expect(isLoopbackRedirectUri("not a url")).toBe(false);
  });
});

describe("MicrosoftTokenProvider — the PUBLIC door refreshes for ever without a secret", () => {
  const keyProvider = new StaticKeyProvider({ 1: Buffer.from("0".repeat(64), "hex") });

  const runtime = (over: Partial<MicrosoftOAuthRuntime>): MicrosoftOAuthRuntime => ({
    clientId: "cid", clientSecret: "", defaultTenant: "common",
    keyProvider, updateSecret: async () => {}, fetch: (null as unknown as FetchLike), ...over,
  });

  it("a public runtime mints a token with NO secret and no named refusal", async () => {
    const { fetch, calls } = fakeIdp(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600 } }));
    const p = new MicrosoftTokenProvider(runtime({ kind: "public", fetch }));
    const token = await p.forMailbox("mb-1")({ refreshToken: "RT", tenant: "common", provider: "microsoft" })();
    expect(token).toBe("AT");
    expect(calls[0]!.body.has("client_secret")).toBe(false);
  });

  it("a CONFIDENTIAL runtime with no secret is STILL the named refusal — the fail-open stays closed", async () => {
    const { fetch, calls } = fakeIdp(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600 } }));
    const p = new MicrosoftTokenProvider(runtime({ fetch }));
    const err = await p.forMailbox("mb-1")({ refreshToken: "RT", tenant: "common", provider: "microsoft" })()
      .catch((e) => e);
    expect(err).toBeInstanceOf(OAuthConfigError);
    expect((err as OAuthConfigError).configVar).toBe("MS_OAUTH_CLIENT_SECRET");
    // And it refused BEFORE spending a request.
    expect(calls).toHaveLength(0);
  });

  it("a resolveClient may declare the kind, and it wins over the runtime's", async () => {
    const { fetch, calls } = fakeIdp(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600 } }));
    const p = new MicrosoftTokenProvider(runtime({
      fetch, resolveClient: async () => ({ clientId: "row-id", clientSecret: "", kind: "public" }),
    }));
    // `clientKind` on the fetcher call is the MAILBOX's provenance and is now a real input: a
    // resolver is ASKED for a door, so a test that omitted it would be asserting that a resolver
    // may answer about a door nobody asked about. It is stated here rather than dropped, which is
    // what keeps this test about "the resolver's kind wins over the runtime's" instead of
    // accidentally becoming a test of the mismatch refusal below.
    await p.forMailbox("mb-1")({
      refreshToken: "RT", tenant: "common", provider: "microsoft", clientKind: "public",
    })();
    expect(calls[0]!.body.get("client_id")).toBe("row-id");
    expect(calls[0]!.body.has("client_secret")).toBe(false);
  });

  it("a CONFIDENTIAL registration MISLABELLED public is refused, not silently sent secretless", async () => {
    // FOUND BY REVIEW. The provider used to drop the secret before the seam could see it
    // (`...(kind === "confidential" ? { clientSecret } : {})`), which bypassed the very guard the
    // explicit kind exists to be. A wrong `kind` — on a config row, or from a resolver — would
    // discard a good secret, send a secretless request, and have Entra's `invalid_client` surface
    // as "provider unavailable": the fleet silently not refreshing while looking like an outage.
    const { fetch, calls } = fakeIdp(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600 } }));
    const p = new MicrosoftTokenProvider(runtime({ kind: "public", clientSecret: "real-secret", fetch }));
    const err = await p.forMailbox("mb-1")({ refreshToken: "RT", tenant: "common", provider: "microsoft" })()
      .catch((e) => e);
    expect(err).toBeInstanceOf(OAuthConfigError);
    // Refused BEFORE the request — the secret never reached the wire in either direction.
    expect(calls).toHaveLength(0);
  });

  it("the same refusal when a RESOLVER returns the mislabelled pair", async () => {
    const { fetch, calls } = fakeIdp(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600 } }));
    const p = new MicrosoftTokenProvider(runtime({
      fetch, resolveClient: async () => ({ clientId: "row-id", clientSecret: "row-secret", kind: "public" }),
    }));
    // The mailbox ASKS for the public door and the resolver answers about the public door, so the
    // door-mismatch check does not fire and `clientAuthFields` is still the thing that refuses —
    // which is what this test is about. Written this way deliberately: with `clientKind` omitted the
    // mismatch check would throw first, the assertion below would still pass, and the guard this
    // test exists to protect would no longer be the one being exercised.
    await expect(
      p.forMailbox("mb-1")({
        refreshToken: "RT", tenant: "common", provider: "microsoft", clientKind: "public",
      })(),
    ).rejects.toThrow(OAuthConfigError);
    expect(calls).toHaveLength(0);
  });

  it("a public grant that ROTATES its refresh token still persists the new one", async () => {
    const saved: { id: string; ct: string }[] = [];
    const { fetch } = fakeIdp(() => ({
      status: 200, json: { access_token: "AT", refresh_token: "RT2", expires_in: 3600 },
    }));
    const p = new MicrosoftTokenProvider(runtime({
      kind: "public", fetch,
      updateSecret: async (mailboxId, ct) => { saved.push({ id: mailboxId, ct }); },
    }));
    await p.forMailbox("mb-9")({ refreshToken: "RT", tenant: "common", provider: "microsoft" })();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.id).toBe("mb-9");
    // Sealed, not stored in the clear: the envelope must not contain the token.
    expect(saved[0]!.ct).not.toContain("RT2");
    expect(await keyProvider.decrypt(saved[0]!.ct, 1)).toBe("RT2");
  });
});

/**
 * THE CONFIG SEAM — one variable per door, and NO fallback between them.
 *
 * This is the half that decides whether the door exists at all, and the property under test is an
 * ABSENCE: `msDeviceEnv` must not read `MS_OAUTH_CLIENT_ID`, ever, in any circumstance. A
 * confidential application's client id fails the device grant outright (that grant carries no
 * secret, so Entra answers `unauthorized_client`), so a fallback would take a complete, working
 * bring-your-own registration and turn it into a second door that always fails — while reporting
 * itself as available.
 */
describe("msDeviceEnv — the public client is a SEPARATE variable, with no fallback", () => {
  it("reads MS_DEVICE_CLIENT_ID and defaults the tenant to common", () => {
    expect(msDeviceEnv({ MS_DEVICE_CLIENT_ID: "pub-id" }))
      .toEqual({ clientId: "pub-id", tenant: "common" });
  });

  it("takes an explicit tenant for a single-tenant registration", () => {
    expect(msDeviceEnv({ MS_DEVICE_CLIENT_ID: "pub-id", MS_DEVICE_TENANT: "contoso.onmicrosoft.com" }))
      .toEqual({ clientId: "pub-id", tenant: "contoso.onmicrosoft.com" });
  });

  it("NEVER borrows the confidential registration's client id", () => {
    // MUTATION: make `msDeviceEnv` fall back to `MS_OAUTH_CLIENT_ID` and this goes red. It is the
    // load-bearing assertion of the whole seam — a BYO deployment must NOT light the device door.
    const byoOnly = {
      MS_OAUTH_CLIENT_ID: "confidential-id",
      MS_OAUTH_CLIENT_SECRET: "a-secret",
      MS_OAUTH_TENANT: "common",
      MS_OAUTH_REDIRECT_URI: "https://mail.example.invalid/api/mailboxes/oauth/microsoft/callback",
    };
    expect(msDeviceEnv(byoOnly)).toBeNull();
    expect(deviceFlowAvailable(msDeviceEnv(byoOnly))).toBe(false);
    // …and the aliases the confidential resolver accepts are not read here either.
    expect(msDeviceEnv({ MICROSOFT_CLIENT_ID: "alias-id" })).toBeNull();
  });

  it("null for an empty or whitespace-only value — the tenant alone arms nothing", () => {
    expect(msDeviceEnv({})).toBeNull();
    expect(msDeviceEnv({ MS_DEVICE_CLIENT_ID: "" })).toBeNull();
    expect(msDeviceEnv({ MS_DEVICE_CLIENT_ID: "   " })).toBeNull();
    expect(msDeviceEnv({ MS_DEVICE_TENANT: "common" })).toBeNull();
  });

  it("the variable name is the one the refusals quote", () => {
    // One spelling, in one place. An operator who is told to set `MS_DEVICE_CLIENT_ID` must be able
    // to find the same string in the reader that looks for it.
    expect(MS_DEVICE_ENV.clientId).toBe("MS_DEVICE_CLIENT_ID");
    expect(MS_DEVICE_ENV.clientId).toBe(MS_CLIENT_ID_ENV.public);
    expect(MS_CLIENT_ID_ENV.confidential).toBe("MS_OAUTH_CLIENT_ID");
  });

  it("deviceFlowAvailable refuses a junk tenant, so the door cannot advertise a 500", () => {
    // The same clause the route re-checks. Without it an armed-looking door 500s inside the URL
    // builder instead of reporting itself unconfigured.
    expect(deviceFlowAvailable({ clientId: "pub-id", tenant: "common" })).toBe(true);
    expect(deviceFlowAvailable({ clientId: "pub-id", tenant: "../evil" })).toBe(false);
    expect(deviceFlowAvailable({ clientId: "pub-id", tenant: "" })).toBe(false);
    expect(deviceFlowAvailable(null)).toBe(false);
    expect(deviceFlowAvailable(undefined)).toBe(false);
  });
});

/**
 * WHICH DOOR ISSUED THE TOKEN TRAVELS WITH THE CREDENTIAL — and the mismatch is refused BY NAME.
 *
 * The failure this closes is the quietest one in the whole feature. A refresh token is bound to the
 * client that obtained it; presented by the other registration, Microsoft answers `invalid_client`,
 * and `refreshAccessToken` maps that to {@link OAuthProviderUnavailableError} deliberately (a
 * rejected client is not the mailbox's fault). So a device-connected mailbox refreshed against the
 * confidential registration would stop receiving mail one hour after it was connected, with nothing
 * quarantined, nothing paged, and every symptom pointing at Microsoft.
 */
describe("the mailbox's own door decides which registration refreshes it", () => {
  const keyProvider = new StaticKeyProvider({ 1: Buffer.from("0".repeat(64), "hex") });
  const runtime = (over: Partial<MicrosoftOAuthRuntime>): MicrosoftOAuthRuntime => ({
    clientId: "cid", clientSecret: "sec", defaultTenant: "common",
    keyProvider, updateSecret: async () => {}, fetch: (null as unknown as FetchLike), ...over,
  });

  /** A host holding BOTH registrations — the self-hosted install this whole seam exists for. */
  const bothDoors = (fetch: FetchLike): MicrosoftOAuthRuntime => runtime({
    fetch,
    resolveClient: async (want) => (want === "public"
      ? { clientId: "public-id", clientSecret: "", kind: "public" }
      : { clientId: "confidential-id", clientSecret: "confidential-secret", kind: "confidential" }),
  });

  it("a PUBLIC mailbox refreshes against the public id, with no secret on the wire", async () => {
    const { fetch, calls } = fakeIdp(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600 } }));
    const p = new MicrosoftTokenProvider(bothDoors(fetch));
    const token = await p.forMailbox("mb-device")({
      refreshToken: "RT", tenant: "common", provider: "microsoft", clientKind: "public",
    })();
    expect(token).toBe("AT");
    expect(calls[0]!.body.get("client_id")).toBe("public-id");
    expect(calls[0]!.body.has("client_secret")).toBe(false);
  });

  it("a CONFIDENTIAL mailbox on the SAME host refreshes against the confidential id, with its secret", async () => {
    // THE POINT OF THE PAIR: one process, one refresh path, two mailboxes, two registrations. A
    // host-wide setting would be right for exactly one of these two tests.
    const { fetch, calls } = fakeIdp(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600 } }));
    const p = new MicrosoftTokenProvider(bothDoors(fetch));
    await p.forMailbox("mb-byo")({ refreshToken: "RT", tenant: "common", provider: "microsoft" })();
    expect(calls[0]!.body.get("client_id")).toBe("confidential-id");
    expect(calls[0]!.body.get("client_secret")).toBe("confidential-secret");
  });

  it("an ABSENT clientKind is the confidential door — every mailbox stored before this existed", async () => {
    // The fail-safe direction. Absent, misspelt and unknown all read as confidential, which is the
    // door every pre-device-flow token came through; the opposite default would have dropped the
    // secret for the entire existing fleet on the first deploy.
    expect(wantedClientKind(undefined)).toBe("confidential");
    expect(wantedClientKind("")).toBe("confidential");
    expect(wantedClientKind("Public")).toBe("confidential");
    expect(wantedClientKind("nonsense")).toBe("confidential");
    expect(wantedClientKind("public")).toBe("public");
  });

  it("a device mailbox on a host with NO public client is refused BY NAME, before any request", async () => {
    // The self-hosted install whose operator armed the api and forgot the organizer — the exact
    // shape of "connects, then stops syncing in an hour". The refusal names the variable THEY can
    // set, not the confidential one, which on such a host is very likely present and irrelevant.
    const { fetch, calls } = fakeIdp(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600 } }));
    const p = new MicrosoftTokenProvider(runtime({
      fetch,
      resolveClient: async (want) => (want === "public"
        // No public client configured: an EMPTY id, which is what a host must return rather than
        // handing back the other door's credentials.
        ? { clientId: "", clientSecret: "", kind: "public" }
        : { clientId: "confidential-id", clientSecret: "sec", kind: "confidential" }),
    }));
    const err = await p.forMailbox("mb-device")({
      refreshToken: "RT", tenant: "common", provider: "microsoft", clientKind: "public",
    })().catch((e) => e);
    expect(err).toBeInstanceOf(OAuthConfigError);
    expect((err as OAuthConfigError).configVar).toBe("MS_DEVICE_CLIENT_ID");
    expect(calls, "refused before spending a request").toHaveLength(0);
  });

  it("a resolver that answers about the WRONG door is refused, not sent", async () => {
    // MUTATION: drop the `kind !== want` check and this goes green while sending a doomed refresh
    // whose `invalid_client` reads as a Microsoft outage. This is the guard that turns a silent
    // fleet-wide failure into one sentence an operator can act on.
    const { fetch, calls } = fakeIdp(() => ({ status: 200, json: { access_token: "AT", expires_in: 3600 } }));
    const p = new MicrosoftTokenProvider(runtime({
      fetch,
      // A host that ignores `want` and always returns the confidential registration — the honest
      // mistake, and the one every existing resolver made before this seam.
      resolveClient: async () => ({ clientId: "confidential-id", clientSecret: "sec", kind: "confidential" }),
    }));
    const err = await p.forMailbox("mb-device")({
      refreshToken: "RT", tenant: "common", provider: "microsoft", clientKind: "public",
    })().catch((e) => e);
    expect(err).toBeInstanceOf(OAuthConfigError);
    expect((err as OAuthConfigError).configVar).toBe("MS_DEVICE_CLIENT_ID");
    expect(calls).toHaveLength(0);
  });

  it("buildImapAuth carries the provenance through — and drops it when there is none", () => {
    // The seam between the stored row and the token client. A `buildImapAuth` that did not pass
    // `clientKind` on would make every device mailbox refresh against the wrong registration, and
    // nothing above this line could tell: the token provider would simply never be asked.
    const seen: { clientKind?: string }[] = [];
    const factory = (input: { refreshToken: string; tenant: string; provider: string; clientKind?: string }) => {
      seen.push({ ...(input.clientKind !== undefined ? { clientKind: input.clientKind } : {}) });
      return async () => "AT";
    };

    buildImapAuth(
      { user: "u@contoso-com.example", authType: "oauth2", provider: "microsoft", tenant: "common", clientKind: "public" },
      "REFRESH-TOKEN", factory,
    );
    expect(seen[0]).toEqual({ clientKind: "public" });

    // An existing row has no such field, and the KEY MUST BE ABSENT rather than present-undefined:
    // `wantedClientKind` reads absent as confidential either way, but a key that is always present
    // makes "did this row predate the device flow" unanswerable from the call site.
    buildImapAuth(
      { user: "u@contoso-com.example", authType: "oauth2", provider: "microsoft", tenant: "common" },
      "REFRESH-TOKEN", factory,
    );
    expect(seen[1]).toEqual({});
  });
});
