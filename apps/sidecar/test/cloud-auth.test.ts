import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StaticKeyProvider } from "@trafficflow/core";
import { createCloudAuth, loadSealedTokens, sealTokens } from "../src/cloud-auth.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-cloud-auth-"));
  dirs.push(d);
  return d;
}

const aKek = (): Buffer => Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
const json = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

describe("the Cloud bearer client", () => {
  it("attaches the bearer and, on 401, refreshes ONCE for a burst of concurrent requests", async () => {
    let refreshCount = 0;
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (u.endsWith("/auth/refresh")) {
        refreshCount++;
        const body = JSON.parse(String(init!.body)) as { refreshToken: string };
        expect(body.refreshToken).toBe("r1");
        return json({ tokens: { accessToken: "new", refreshToken: "r2" } });
      }
      const bearer = new Headers(init?.headers).get("authorization");
      seen.push(bearer ?? "");
      // The stale access token 401s; the rotated one is accepted.
      if (bearer === "Bearer old") return new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 });
      return json({ ok: true, bearer });
    }) as typeof fetch;

    const auth = createCloudAuth({
      baseUrl: "http://cloud.test",
      tokens: { accessToken: "old", refreshToken: "r1" },
      fetchImpl,
    });

    const [a, b, c] = await Promise.all([
      auth.authedFetch("/sync?since=0"),
      auth.authedFetch("/messages/bodies"),
      auth.authedFetch("/sync?since=1"),
    ]);

    // SINGLE-FLIGHT: three 401s, one refresh — a per-request refresh would rotate the family and
    // the hosted API would revoke it as a reuse signal.
    expect(refreshCount).toBe(1);
    expect((await a.json() as { bearer: string }).bearer).toBe("Bearer new");
    expect((await b.json() as { bearer: string }).bearer).toBe("Bearer new");
    expect((await c.json() as { bearer: string }).bearer).toBe("Bearer new");
    expect(auth.currentTokens()).toEqual({ accessToken: "new", refreshToken: "r2" });
    // The first attempt of each used the stale token; the retries used the rotated one.
    expect(seen.filter((s) => s === "Bearer old")).toHaveLength(3);
    expect(seen.filter((s) => s === "Bearer new")).toHaveLength(3);
  });

  it("returns the 401 (does not throw) when the refresh door REFUSES with one of its codes", async () => {
    const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
      if (String(url).endsWith("/auth/refresh")) {
        return new Response(JSON.stringify({ error: { code: "refresh_revoked" } }), { status: 401 });
      }
      return new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 });
    }) as typeof fetch;
    const auth = createCloudAuth({ baseUrl: "http://cloud.test", tokens: { accessToken: "x", refreshToken: "y" }, fetchImpl });
    const res = await auth.authedFetch("/sync");
    expect(res.status).toBe(401);
    expect(auth.session()).toMatchObject({ state: "refused", code: "refresh_revoked" });
  });

  it("an UNCODED 401 at the refresh is a platform's answer: the request is told offline, the session stays", async () => {
    const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
      if (String(url).endsWith("/auth/refresh")) return new Response("no", { status: 401 });
      return new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 });
    }) as typeof fetch;
    const auth = createCloudAuth({ baseUrl: "http://cloud.test", tokens: { accessToken: "x", refreshToken: "y" }, fetchImpl });
    const res = await auth.authedFetch("/sync");
    expect(res.status, "never the hosted 401 — the window read that as a sign-out").toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("offline_read_only");
    expect(auth.session()).toMatchObject({ state: "renewing", code: "http_401" });
    auth.stop();
  });

  it("seals a token pair under the install key and reads it back; a wrong key yields null", async () => {
    const path = join(tmp(), "cloud-tokens.seal");
    const kp = new StaticKeyProvider({ 1: aKek() });
    await sealTokens(path, kp, { accessToken: "acc-123", refreshToken: "ref-456" });

    // The file is a sealed envelope, not the tokens with extra steps.
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("acc-123");
    expect(raw).not.toContain("accessToken");

    expect(await loadSealedTokens(path, kp)).toEqual({ accessToken: "acc-123", refreshToken: "ref-456" });
    // A different key cannot open it — the recovery is a fresh environment token, not an error.
    expect(await loadSealedTokens(path, new StaticKeyProvider({ 1: aKek() }))).toBeNull();
    // A missing file is simply null.
    expect(await loadSealedTokens(join(tmp(), "nope.seal"), kp)).toBeNull();
  });

  it("re-seals the rotated pair, so a later launch resumes with no environment token", async () => {
    const path = join(tmp(), "cloud-tokens.seal");
    const kp = new StaticKeyProvider({ 1: aKek() });
    await sealTokens(path, kp, { accessToken: "old", refreshToken: "r1" });

    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(url).endsWith("/auth/refresh")) return json({ tokens: { accessToken: "rotated", refreshToken: "r2" } });
      const bearer = new Headers(init?.headers).get("authorization");
      return bearer === "Bearer old" ? new Response("", { status: 401 }) : json({ ok: true });
    }) as typeof fetch;

    const auth = createCloudAuth({
      baseUrl: "http://cloud.test",
      tokens: { accessToken: "old", refreshToken: "r1" },
      fetchImpl,
      keyProvider: kp,
      sealPath: path,
    });
    await auth.authedFetch("/sync");
    // The sealed file now carries the rotated pair, so a restart needs no environment token.
    expect(await loadSealedTokens(path, kp)).toEqual({ accessToken: "rotated", refreshToken: "r2" });
  });
});

describe("the Cloud bearer client bounds its requests and names a dead session", () => {
  it("a request nobody else bounds is aborted at the deadline — a half-open socket is a retry, not a wedge", async () => {
    // The measured failure: no deadline anywhere in the pull path, so a socket that went
    // half-open under a sleeping laptop parked the drain on a read that resolves never.
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })
    ) as unknown as typeof fetch;
    const auth = createCloudAuth({
      baseUrl: "https://cloud.test", tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl, requestDeadlineMs: 25,
    });
    await expect(auth.authedFetch("/sync?since=0")).rejects.toThrow();
  });

  it("a caller-supplied signal is exempt — the wake stream's held request stays held", async () => {
    let sawSignal: AbortSignal | null | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      sawSignal = init?.signal;
      return json({ ok: true });
    }) as unknown as typeof fetch;
    const auth = createCloudAuth({
      baseUrl: "https://cloud.test", tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl, requestDeadlineMs: 25,
    });
    const own = new AbortController();
    await auth.authedFetch("/events", { signal: own.signal });
    expect(sawSignal, "the held stream's own signal must ride through untouched").toBe(own.signal);
  });

  it("a CODED refresh refusal tells onSessionRefused exactly once, with its code; a 5xx tells it nothing", async () => {
    let mode: "dead" | "flaky" = "dead";
    const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u.endsWith("/auth/refresh")) {
        return mode === "dead"
          ? new Response(JSON.stringify({ error: { code: "refresh_expired" } }), { status: 401 })
          : new Response("busy", { status: 503 });
      }
      return new Response("expired", { status: 401 });
    }) as unknown as typeof fetch;
    const told: string[] = [];
    const auth = createCloudAuth({
      baseUrl: "https://cloud.test", tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl, onSessionRefused: (code) => { told.push(code); },
    });

    // Two failed rounds against a REFUSED session: the cue fires once, not per request.
    expect((await auth.authedFetch("/sync?since=0")).status).toBe(401);
    expect((await auth.authedFetch("/sync?since=0")).status).toBe(401);
    expect(told, "a dead session is announced once, not per retry, and names why").toEqual(["refresh_expired"]);

    // A server-shaped fault (5xx) is a blip, never a sign-out cue.
    told.length = 0;
    mode = "flaky";
    const auth2 = createCloudAuth({
      baseUrl: "https://cloud.test", tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl, onSessionRefused: (code) => { told.push(code); },
    });
    expect((await auth2.authedFetch("/sync?since=0")).status).toBe(503);
    expect(told, "a 503 on the refresh is not a dead session").toEqual([]);
    auth2.stop();
  });
});

/**
 * ═══ A LOST ROTATION ANSWER — THE RETRY IS THE SAME ATTEMPT, NOT A STRANGER ══════════════════
 *
 * The phone's case on the surface with neither a jar nor a keystore: the server consumes and
 * mints, the answer never arrives, and this client still holds the old token. Its retry used to
 * be byte-identical to a replay. The name is sealed beside the token BEFORE the request goes out,
 * so even a launch killed mid-rotation retries as itself. This is the CLIENT half; the server
 * half — N presentations under ONE name leave one live tail — is measured against the real schema
 * in `packages/services/test/refresh-retry-attempt.pg.test.ts`.
 */
describe("the Cloud bearer client's lost rotation answer", () => {
  /** A door that drops the refresh ANSWER (a throw — a broken connection judges nothing). */
  function lossyDoor(names: string[], state: { answer: "lost" | "ok" }): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (u.endsWith("/auth/refresh")) {
        const body = JSON.parse(String(init!.body)) as { refreshToken: string; attemptId: string };
        expect(body.refreshToken, "the retry presents the token it still holds").toBe("r1");
        names.push(body.attemptId);
        if (state.answer === "lost") throw new TypeError("fetch failed");
        return json({ tokens: { accessToken: "new", refreshToken: "r2" } });
      }
      const bearer = new Headers(init?.headers).get("authorization");
      if (bearer === "Bearer old") {
        return new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 });
      }
      return json({ ok: true, bearer });
    }) as typeof fetch;
  }

  it("retries under the SAME name, across a relaunch, and adopting clears it", async () => {
    const dir = tmp();
    const sealPath = join(dir, "cloud-tokens.seal");
    const keyProvider = new StaticKeyProvider({ 1: aKek() });
    const names: string[] = [];
    const state = { answer: "lost" as "lost" | "ok" };

    const first = createCloudAuth({
      baseUrl: "http://cloud.test",
      tokens: { accessToken: "old", refreshToken: "r1" },
      fetchImpl: lossyDoor(names, state), keyProvider, sealPath,
    });
    // The first meets the lost answer through a request; the retries run on the renewal's own
    // clock (driven here by `renewNow`, the window's Try again), never once per request.
    expect((await first.authedFetch("/sync?since=0")).status, "nothing judged: told offline").toBe(503);
    expect((await first.authedFetch("/sync?since=0")).status, "a pending retry is not hurried").toBe(503);
    expect(names, "the second request sent no refresh of its own").toHaveLength(1);
    for (let i = 0; i < 2; i += 1) {
      expect((await first.renewNow()).state, `retry ${i}: nothing judged`).toBe("unreachable");
    }
    first.stop();
    expect(names).toHaveLength(3);
    expect(new Set(names).size, "three retries of one lost answer, ONE name").toBe(1);
    // ON DISK, which is what a relaunch reads — and the pair it names is untouched.
    const sealedNow = await loadSealedTokens(sealPath, keyProvider);
    expect(sealedNow!.refreshToken, "a dropped answer clears nothing").toBe("r1");
    expect(sealedNow!.refreshAttempt).toBe(names[0]);

    // THE LAUNCH KILLED MID-ROTATION: a new client, built the way `cloud-engine` builds one, from
    // the seal alone.
    const relaunched = createCloudAuth({
      baseUrl: "http://cloud.test",
      tokens: sealedNow!,
      fetchImpl: lossyDoor(names, state), keyProvider, sealPath,
    });
    expect((await relaunched.authedFetch("/sync?since=0")).status).toBe(503);
    expect(names[3], "the relaunch retries as itself, not as a stranger").toBe(names[0]);

    // The answer lands at last: adopting IS clearing, in the same seal write that saves the pair.
    state.answer = "ok";
    expect((await relaunched.renewNow()).state).toBe("live");
    expect((await relaunched.authedFetch("/sync?since=0")).status).toBe(200);
    expect(names[4], "the answered attempt is still the same one").toBe(names[0]);
    expect(relaunched.currentTokens()).toEqual({ accessToken: "new", refreshToken: "r2" });
    const sealedAfter = await loadSealedTokens(sealPath, keyProvider);
    expect(sealedAfter!.refreshToken).toBe("r2");
    expect(sealedAfter!.refreshAttempt, "a name only stands where an answer never arrived").toBeUndefined();
  });

  it("names a NEW attempt for the next rotation — a finished attempt is never claimed twice", async () => {
    const names: string[] = [];
    const state = { answer: "ok" as "lost" | "ok" };
    // No seal: the name lives for this process, which is every retry a running client makes.
    const auth = createCloudAuth({
      baseUrl: "http://cloud.test",
      tokens: { accessToken: "old", refreshToken: "r1" },
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const u = String(url);
        if (u.endsWith("/auth/refresh")) {
          names.push((JSON.parse(String(init!.body)) as { attemptId: string }).attemptId);
          // Always hands back the SAME pair, so the next request 401s again and rotates again.
          return json({ tokens: { accessToken: "old", refreshToken: "r1" } });
        }
        return new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 });
      }) as typeof fetch,
    });

    await auth.authedFetch("/sync?since=0");
    await auth.authedFetch("/sync?since=1");
    expect(names).toHaveLength(2);
    expect(names[1], "the adopted attempt is not re-claimed").not.toBe(names[0]);
  });
});
