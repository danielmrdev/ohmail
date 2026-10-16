import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StaticKeyProvider, type KeyProvider } from "@trafficflow/core/mail";

import { createCloudAuth, loadSealedTokens } from "../src/cloud-auth.js";

/**
 * A STOPPED SESSION ASKS NOTHING MORE AND WRITES NOTHING. `stop()` is the sign-out's: it ends every
 * request the session bounded, leaves a caller's own signal alone, and no pair reaches the seal
 * after it, whether the renewal's answer or the key's work is what arrives late.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const KEY = { 1: Buffer.alloc(32, 3) };
const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const pathOf = (input: string | URL | Request): string =>
  new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;

function sealDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-auth-stop-"));
  dirs.push(dir);
  return join(dir, "cloud-tokens.seal");
}

describe("CloudAuth.stop()", () => {
  it("a renewal answered after the stop leaves the seal as the stop found it", async () => {
    const sealPath = sealDir();
    const keyProvider = new StaticKeyProvider(KEY);
    let answer: (res: Response) => void = () => {};
    let asked: () => void = () => {};
    const refreshAsked = new Promise<void>((r) => { asked = r; });
    /* A transport that IGNORES its signal: the answer arrives whatever the stop said. */
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      if (pathOf(input) !== "/auth/refresh") return new Response("not found", { status: 404 });
      asked();
      return new Promise<Response>((r) => { answer = r; });
    }) as unknown as typeof fetch;
    const auth = createCloudAuth({
      baseUrl: "https://host.test", tokens: { accessToken: "a1", refreshToken: "r1" }, fetchImpl, keyProvider, sealPath,
    });
    const renewing = auth.renewNow();
    await refreshAsked;
    expect((await loadSealedTokens(sealPath, keyProvider))?.accessToken, "the attempt's name is sealed first").toBe("a1");
    auth.stop();
    answer(json({ tokens: { accessToken: "a2", refreshToken: "r2", expiresIn: 900 } }));
    await renewing;
    expect((await loadSealedTokens(sealPath, keyProvider))?.accessToken, "a pair minted after the stop was sealed").toBe("a1");
  });

  it("a stop that lands while the key works on a renewed pair writes nothing", async () => {
    const sealPath = sealDir();
    const real = new StaticKeyProvider(KEY);
    let calls = 0;
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const inSecondEncrypt = new Promise<void>((r) => { entered = r; });
    const keyProvider: KeyProvider = {
      encrypt: async (plaintext) => {
        calls += 1;
        if (calls === 2) { entered(); await gate; }
        return real.encrypt(plaintext);
      },
      decrypt: (ciphertext, version) => real.decrypt(ciphertext, version),
      currentKeyVersion: () => real.currentKeyVersion(),
      deriveSubkey: (info) => real.deriveSubkey(info),
    };
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> =>
      pathOf(input) === "/auth/refresh"
        ? json({ tokens: { accessToken: "a2", refreshToken: "r2", expiresIn: 900 } })
        : new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const auth = createCloudAuth({
      baseUrl: "https://host.test", tokens: { accessToken: "a1", refreshToken: "r1" }, fetchImpl, keyProvider, sealPath,
    });
    const renewing = auth.renewNow();
    await inSecondEncrypt;
    auth.stop();
    release();
    await renewing;
    expect(calls, "the minted pair never reached the key").toBe(2);
    expect((await loadSealedTokens(sealPath, real))?.accessToken, "the minted pair was sealed past the stop").toBe("a1");
  });

  it("ends every request it bounded, and leaves a caller's own signal alone", async () => {
    const seen: { path: string; aborted: boolean }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const row = { path: pathOf(input), aborted: false };
      seen.push(row);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => { row.aborted = true; reject(init.signal!.reason); });
      });
    }) as unknown as typeof fetch;
    const auth = createCloudAuth({ baseUrl: "https://host.test", tokens: { accessToken: "a1", refreshToken: "r1" }, fetchImpl });
    const own = new AbortController();
    const pull = auth.authedFetch("/sync").then(() => "answered", (err: Error) => err.name);
    const held = auth.authedFetch("/events", { signal: own.signal }).then(() => "answered", (err: Error) => err.name);
    await new Promise((r) => setTimeout(r, 20));
    auth.stop();
    const verdict = await Promise.race([pull, new Promise((r) => setTimeout(() => r("still pending"), 1_000))]);
    expect(verdict, "the stop did not end the request it bounded").toBe("AbortError");
    expect(seen.find((r) => r.path === "/events")?.aborted, "the stop reached a caller's own signal").toBe(false);
    own.abort();
    expect(await held).toBe("AbortError");
  });

  it("a request asked after the stop goes out already aborted", async () => {
    /* Read as each request is made: a finished request's controller is still held until its deadline. */
    const abortedWhenAsked: (boolean | undefined)[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      abortedWhenAsked.push(init?.signal?.aborted);
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const auth = createCloudAuth({ baseUrl: "https://host.test", tokens: { accessToken: "a1", refreshToken: "r1" }, fetchImpl });
    expect((await auth.authedFetch("/before")).status, "the positive control: before the stop, a request goes").toBe(204);
    auth.stop();
    const after = await auth.authedFetch("/after").then(() => "answered", (err: Error) => err.name);
    expect(after).toBe("AbortError");
    expect(abortedWhenAsked).toEqual([false, true]);
  });
});

describe("what the stop ends is what is still OUT", () => {
  /** A client whose every request records its signal; `answer` says how the server replies. */
  function client(answer: (signal: AbortSignal) => Promise<Response> | Response) {
    const signals: AbortSignal[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      signals.push(init!.signal!);
      return answer(init!.signal!);
    }) as unknown as typeof fetch;
    const auth = createCloudAuth({ baseUrl: "https://host.test", tokens: { accessToken: "a1", refreshToken: "r1" }, fetchImpl });
    return { auth, signals };
  }

  it("a request whose answer was read to the end is not ended by a later stop", async () => {
    const { auth, signals } = client(() => json({ ok: true }));
    expect(await (await auth.authedFetch("/read")).json()).toEqual({ ok: true });
    auth.stop();
    expect(signals[0]!.aborted, "a finished request was still held for the stop").toBe(false);
  });

  it.each([
    ["whose answer was cancelled", async () => {
      const c = client(() => json({ ok: true }));
      await (await c.auth.authedFetch("/cancelled")).body!.cancel();
      return c;
    }],
    ["with no body", async () => {
      const c = client(() => new Response(null, { status: 204 }));
      await c.auth.authedFetch("/bodiless");
      return c;
    }],
    ["that failed", async () => {
      const c = client(() => Promise.reject(new TypeError("fetch failed")));
      await c.auth.authedFetch("/failed").catch(() => undefined);
      return c;
    }],
    ["whose body failed", async () => {
      const c = client(() => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.error(new Error("the connection dropped")); },
      }), { status: 200 }));
      await (await c.auth.authedFetch("/broken")).text().catch(() => undefined);
      return c;
    }],
  ] as const)("nor one %s", async (_name, made) => {
    const c = await made();
    c.auth.stop();
    expect(c.signals[0]!.aborted, "an ended request was still held for the stop").toBe(false);
  });

  it("a request whose body is still being read IS ended by the stop", async () => {
    /* The body is tied to the signal, as the platform's fetch ties it: one chunk, then it waits. */
    const { auth } = client((signal) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        signal.addEventListener("abort", () => controller.error(signal.reason));
      },
    }), { status: 200 }));
    const reading = (await auth.authedFetch("/slow-page")).text().then(() => "read", (err: Error) => err.name);
    await new Promise((r) => setTimeout(r, 20));
    auth.stop();
    const verdict = await Promise.race([reading, new Promise((r) => setTimeout(() => r("still reading"), 1_000))]);
    expect(verdict, "the stop let a body read run on").toBe("AbortError");
  });
});
