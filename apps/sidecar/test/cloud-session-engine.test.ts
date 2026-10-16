import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { DataDirLockedError } from "../src/db.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE ENGINE'S SIDE OF A DURABLE SESSION, through the real constructor and `/health`.
 *
 * `/health.sessionExpired` opens the sign-in dialog, so it may be true only after a coded refusal.
 * A firewall's 403 keeps the engine signed in with its seal and its mirror; a coded refusal
 * returns it to sign-in and names why; a second engine on the same directory is refused before
 * it can touch the running one's seal; a seal this key cannot open is named at launch.
 */

const MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ring = (): Record<number, Buffer> => ({ 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) });

const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Host {
  fetchImpl: typeof fetch;
  /** Every request this host saw, by path. */
  seen: string[];
  /** Once true, the launch access token is stale and the next pull asks for a renewal. */
  expired: boolean;
}

/** A hosted API whose refresh door answers `refresh()`. */
function host(refresh: () => Response): Host {
  const h: Host = { seen: [], expired: false, fetchImpl: undefined as unknown as typeof fetch };
  h.fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    h.seen.push(url.pathname);
    const send = (v: unknown): Response =>
      new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/auth/refresh") return refresh();
    if (h.expired && new Headers(init?.headers).get("authorization") === "Bearer access-1") {
      return new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 });
    }
    if (url.pathname === "/mailboxes") return send(mailboxList([hostedMailbox(MAILBOX, "me@ohmail.test")]));
    if (url.pathname === "/sync") return send({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: Buffer.from("1").toString("base64url"), hasMore: false, serverTime: new Date().toISOString(),
    });
    if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return h;
}

async function boot(dataDir: string, h: Host, over: {
  keks?: Record<number, Buffer>; address?: string; tokens?: boolean;
} = {}): Promise<CloudSidecar> {
  const sidecar = await createCloudSidecar({
    dataDir,
    cloudUrl: "https://cloud.test",
    address: over.address ?? "me@ohmail.test",
    ...(over.tokens === false ? {} : { tokens: { accessToken: "access-1", refreshToken: "refresh-1" } }),
    keks: over.keks ?? ring(),
    fetchImpl: h.fetchImpl,
    pollIntervalMs: 40,
  });
  sidecars.push(sidecar);
  await sidecar.start();
  return sidecar;
}

type Health = {
  signedIn: boolean; sessionExpired: boolean;
  session: { state: string; code: string | null; since: string } | null;
};
const health = async (s: CloudSidecar): Promise<Health> =>
  (await s.handle(new Request("http://sidecar/health"))).json() as never;

async function until(s: CloudSidecar, want: (h: Health) => boolean, what: string): Promise<Health> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const h = await health(s);
    if (want(h)) return h;
    if (Date.now() > deadline) throw new Error(what);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const html403 = (): Response =>
  new Response("<html>Access denied</html>", { status: 403, headers: { "content-type": "text/html" } });

describe("the cloud engine's session through /health", () => {
  it("a firewall's 403 at the refresh: still signed in, not expired, the seal and the mirror kept", { timeout: 40_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-session-403-");
    dirs.push(dataDir);
    const h = host(html403);
    const sidecar = await boot(dataDir, h);
    h.expired = true;
    const got = await until(sidecar, (x) => x.session?.state === "renewing", "the engine never met the 403");
    expect(got).toMatchObject({ signedIn: true, sessionExpired: false, session: { code: "http_403" } });
    expect(existsSync(join(dataDir, "cloud-tokens.seal")), "the seal is not a casualty of a firewall").toBe(true);
    const auth = { authorization: `Bearer ${sidecar.sessionToken}` };
    const list = await sidecar.handle(new Request("http://sidecar/mailboxes", { headers: auth }));
    expect(list.status, "the mirror keeps serving what it holds").toBe(200);

    // The window's Try again reaches the door once more and answers where that leaves it.
    const before = h.seen.filter((p) => p === "/auth/refresh").length;
    const renew = await sidecar.handle(new Request("http://sidecar/cloud/session/renew", { method: "POST", headers: auth }));
    expect(((await renew.json()) as { session: { state: string } }).session.state).toBe("renewing");
    expect(h.seen.filter((p) => p === "/auth/refresh").length).toBe(before + 1);
  });

  it("a coded refusal: signed out, expired, the code named, the spent seal removed", { timeout: 40_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-session-revoked-");
    dirs.push(dataDir);
    const h = host(() => new Response(JSON.stringify({ error: { code: "refresh_revoked" } }), { status: 401 }));
    const sidecar = await boot(dataDir, h);
    h.expired = true;
    const got = await until(sidecar, (x) => x.sessionExpired, "the engine never took the refusal");
    expect(got).toMatchObject({ signedIn: false, session: { state: "refused", code: "refresh_revoked" } });
    const deadline = Date.now() + 10_000;
    while (existsSync(join(dataDir, "cloud-tokens.seal"))) {
      if (Date.now() > deadline) throw new Error("the refused seal was never removed");
      await new Promise((r) => setTimeout(r, 25));
    }
  });
});

describe("one engine per data directory", () => {
  it("a second engine is refused by name before it touches the running one's seal or store", { timeout: 40_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-session-twice-");
    dirs.push(dataDir);
    const first = await boot(dataDir, host(html403));
    const sealPath = join(dataDir, "cloud-tokens.seal");
    const sealBefore = readFileSync(sealPath);

    // The same door, and a DIFFERENT address — the one whose owner check discards a mirror.
    for (const address of ["me@ohmail.test", "someone-else@ohmail.test"]) {
      const second = host(html403);
      const refusal = await boot(dataDir, second, { address }).then(() => null, (err: unknown) => err);
      expect(refusal, `a second engine (${address === "me@ohmail.test" ? "same" : "other"} address)`)
        .toBeInstanceOf(DataDirLockedError);
      expect((refusal as DataDirLockedError).holder, "the refusal names the running engine").toBe(`pid ${process.pid}`);
      expect(second.seen, "the refused engine dialled nothing").toEqual([]);
      expect(readFileSync(sealPath).equals(sealBefore), "the running engine's seal is byte-identical").toBe(true);
      expect(existsSync(join(dataDir, "pgdata")), "and its store is where it was").toBe(true);
    }
    expect((await health(first)).signedIn, "the first engine keeps running").toBe(true);
    const auth = { authorization: `Bearer ${first.sessionToken}` };
    expect((await first.handle(new Request("http://sidecar/mailboxes", { headers: auth }))).status).toBe(200);
  });
});

describe("a seal on disk this key cannot open", () => {
  it("is named at launch, apart from a first run; the right key opens it", { timeout: 40_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-session-unreadable-");
    dirs.push(dataDir);
    const keks = ring();
    await (await boot(dataDir, host(html403), { keks })).stop();
    sidecars.splice(0);

    const other = await boot(dataDir, host(html403), { keks: ring(), tokens: false });
    expect(await health(other)).toMatchObject({
      signedIn: false, sessionExpired: false, session: { state: "seal_failed", code: "seal_unreadable" },
    });
    await other.stop();
    sidecars.splice(0);

    // The positive control: the key that wrote it opens it, and the launch is signed in.
    const same = await boot(dataDir, host(html403), { keks, tokens: false });
    expect(await health(same)).toMatchObject({ signedIn: true, session: { state: "live" } });
  });
});
