import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { WINDOW_CONSENT_READ_FAILED_ROUTE, WINDOW_SYNC_FAILED_ROUTE } from "../src/window-report.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE PAIRED DESKTOP'S CONSENT READ, OVER THE REAL CLOUD ENGINE (FIX-025).
 *
 * Measured against a fake account: the relay forwards `GET /consent` with the bearer and hands
 * the body back unchanged, so the table, the bearer and the parse are not why the window's read
 * failed. After one failed forward the relay marks the door offline; the next read asks the
 * account once, and an answer clears the flag. And the window's two reports reach THIS engine's
 * log instead of the relay's 404.
 */

const MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ring = (): Record<number, Buffer> => ({ 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) });
const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CONSENT_BODY = JSON.stringify({
  seedConfirmedAt: "2026-09-01T00:00:00.000Z", screeningResetAt: null, dormancyDays: 90,
  screeningBaselineAt: null, autoSuggestAt: null, counts: { activeUndecidedSenders: 0 },
});

interface Account { seen: Array<{ path: string; bearer: boolean }>; failConsent: number; fetchImpl: typeof fetch }

function account(): Account {
  const a: Account = { seen: [], failConsent: 0, fetchImpl: undefined as unknown as typeof fetch };
  a.fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    a.seen.push({ path: url.pathname, bearer: new Headers(init?.headers).get("authorization") === "Bearer access-1" });
    const send = (v: string): Response => new Response(v, { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/mailboxes") return send(JSON.stringify(mailboxList([hostedMailbox(MAILBOX, "me@ohmail.test")])));
    if (url.pathname === "/sync") return send(JSON.stringify({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: Buffer.from("1").toString("base64url"), hasMore: false, serverTime: new Date().toISOString(),
    }));
    if (url.pathname === "/messages/bodies") return send(JSON.stringify({ items: [], nextCursor: null }));
    if (url.pathname === "/consent") {
      if (a.failConsent > 0) { a.failConsent -= 1; throw new TypeError("fetch failed"); }
      return send(CONSENT_BODY);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return a;
}

async function boot(a: Account, lines: Array<{ event: string; fields: Record<string, unknown> }>): Promise<CloudSidecar> {
  const dataDir = await freshDataDir("ohmail-consent-forward-");
  dirs.push(dataDir);
  const sidecar = await createCloudSidecar({
    dataDir, cloudUrl: "https://cloud.test", address: "me@ohmail.test",
    tokens: { accessToken: "access-1", refreshToken: "refresh-1" },
    keks: ring(), fetchImpl: a.fetchImpl, pollIntervalMs: 60_000,
    log: (event, fields) => { lines.push({ event, fields }); },
  });
  sidecars.push(sidecar);
  await sidecar.start();
  return sidecar;
}

const consentAsks = (a: Account): number => a.seen.filter((s) => s.path === "/consent").length;

describe("the forwarded consent read on the cloud door", () => {
  it("reaches the account with the bearer and answers its body unchanged", { timeout: 40_000 }, async () => {
    const a = account();
    const sidecar = await boot(a, []);
    const auth = { authorization: `Bearer ${sidecar.sessionToken}` };
    const res = await sidecar.handle(new Request("http://sidecar/consent", { headers: auth }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CONSENT_BODY);
    expect(a.seen.filter((s) => s.path === "/consent")).toEqual([{ path: "/consent", bearer: true }]);
  });

  it("after one failed forward the next read asks the account, and its answer clears the offline flag", { timeout: 40_000 }, async () => {
    const a = account();
    a.failConsent = 1;
    const sidecar = await boot(a, []);
    const auth = { authorization: `Bearer ${sidecar.sessionToken}` };
    const first = await sidecar.handle(new Request("http://sidecar/consent", { headers: auth }));
    expect(first.status).toBe(503);
    const second = await sidecar.handle(new Request("http://sidecar/consent", { headers: auth }));
    expect(second.status, "a read after one failed forward was refused unasked").toBe(200);
    expect(await second.text()).toBe(CONSENT_BODY);
    const third = await sidecar.handle(new Request("http://sidecar/consent", { headers: auth }));
    expect(third.status).toBe(200);
  });

  it("a read that asks and fails leaves the door offline, and a write is refused unasked", { timeout: 40_000 }, async () => {
    const a = account();
    a.failConsent = 2;
    const sidecar = await boot(a, []);
    const auth = { authorization: `Bearer ${sidecar.sessionToken}` };
    expect((await sidecar.handle(new Request("http://sidecar/consent", { headers: auth }))).status).toBe(503);
    // Offline writes nothing, even while a read is owed its one ask.
    const seen = a.seen.length;
    const write = await sidecar.handle(new Request("http://sidecar/consent/seed", {
      method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}",
    }));
    expect(write.status).toBe(503);
    expect(a.seen.length, "an offline write reached the account").toBe(seen);
    expect((await sidecar.handle(new Request("http://sidecar/consent", { headers: auth }))).status).toBe(503);
    const asked = consentAsks(a);
    const third = await sidecar.handle(new Request("http://sidecar/consent", { headers: auth }));
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe("offline_read_only");
    expect(consentAsks(a), "a door whose probe failed kept asking the account").toBe(asked);
  });

  it("the window's two reports reach this engine's log, never the relay", { timeout: 40_000 }, async () => {
    const a = account();
    const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const sidecar = await boot(a, lines);
    const post = (path: string, body: unknown) => sidecar.handle(new Request(`http://sidecar${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect((await post(WINDOW_CONSENT_READ_FAILED_ROUTE, { attempt: 1, reason: "refused", status: 503 })).status).toBe(204);
    expect((await post(WINDOW_SYNC_FAILED_ROUTE, { attempt: 1, reason: "window_fault", errorClass: "TypeError" })).status).toBe(204);
    expect(lines.find((l) => l.event === "consent_read_failed")?.fields).toMatchObject({ count: 1, reason: "refused", status: 503 });
    expect(lines.some((l) => l.event === "window_sync_failed")).toBe(true);
    expect(lines.some((l) => l.event === "cloud_relay_refused")).toBe(false);
    expect(a.seen.some((s) => s.path.startsWith("/local/")), "a window report left the machine").toBe(false);
    const anon = await sidecar.handle(new Request(`http://sidecar${WINDOW_CONSENT_READ_FAILED_ROUTE}`, {
      method: "POST", body: JSON.stringify({ attempt: 1, reason: "shape" }),
    }));
    expect(anon.status, "a report without the launch bearer").toBe(401);
  });
});
