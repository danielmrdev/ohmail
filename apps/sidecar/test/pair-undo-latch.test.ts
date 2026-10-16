import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { encodeMirrorRecord } from "../src/cloud-origin.js";
import { SIGN_OUT_AT_HOST_MS } from "../src/pair-undo.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";

/**
 * AN UNDO WHILE THE REDEEM IS STILL OUT HAS ONE OUTCOME. `DELETE /cloud/session?revoke=host` marks
 * the in-flight redeem first; one that lands marked seals nothing, activates nothing, signs its
 * own bearer out at the other computer inside the undo's one deadline and answers 409
 * `pairing_undone`. Before this the undo asked the host nothing and the redeem sealed after it.
 */
vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 3 + 15_000 });

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const json = (v: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

type Logout = "ok" | "hang";
function pairingHost(opts: { logout?: Logout; account?: string } = {}) {
  const logouts: { bearer: string | null; at: number; abortedAt: number | null }[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let asked!: () => void;
  const redeemAsked = new Promise<void>((r) => { asked = r; });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === "/pair/redeem") {
      asked();
      await gate;
      return json({ grant: "device-pair", tokens: { accessToken: "paired-access", refreshToken: "paired-refresh" } }, 200,
        { "x-ohmail-account": opts.account ?? ACCOUNT });
    }
    if (url.pathname === "/auth/logout") {
      const row = { bearer: new Headers(init?.headers).get("authorization"), at: Date.now(), abortedAt: null as number | null };
      logouts.push(row);
      if (opts.logout === "hang") {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => { row.abortedAt = Date.now(); reject(init.signal!.reason); });
        });
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/mailboxes") return json(mailboxList([hostedMailbox("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "me@ohmail.test")]));
    if (url.pathname === "/sync") return json({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c", hasMore: false, serverTime: new Date().toISOString() });
    if (url.pathname === "/messages/bodies") return json({ items: [], nextCursor: null });
    return json({ error: { code: "not_found" } }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, logouts, release, redeemAsked };
}

async function engine(host: ReturnType<typeof pairingHost>, seed?: (dir: string) => void) {
  const dataDir = await freshDataDir("ohmail-pair-undo-");
  dirs.push(dataDir);
  seed?.(dataDir);
  const s = await createCloudSidecar({
    dataDir, cloudUrl: "https://desk.test", address: null, keks: { 1: Buffer.alloc(32, 9) },
    fetchImpl: host.fetchImpl, pollIntervalMs: 3_600_000,
  });
  sidecars.push(s);
  const auth = { authorization: `Bearer ${s.sessionToken}` };
  const pair = (): Promise<Response> => s.handle(new Request("http://sidecar/cloud/pair-redeem", {
    method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ token: "tok-abc" }),
  }));
  const undo = async (query = "?revoke=host"): Promise<{ body: Record<string, unknown>; ms: number }> => {
    const started = Date.now();
    const res = await s.handle(new Request(`http://sidecar/cloud/session${query}`, { method: "DELETE", headers: auth }));
    return { body: (await res.json()) as Record<string, unknown>, ms: Date.now() - started };
  };
  const read = async (): Promise<number> => (await s.handle(new Request("http://sidecar/mailboxes", { headers: auth }))).status;
  return { s, dataDir, pair, undo, read };
}

describe("an undo while the redeem is out", () => {
  it("keeps nothing here and signs the bearer out at the other computer", async () => {
    const host = pairingHost();
    const e = await engine(host);
    const pairing = e.pair();
    await host.redeemAsked;
    const undoing = e.undo();
    host.release();
    const [paired, undone] = await Promise.all([pairing, undoing]);

    expect(paired.status).toBe(409);
    expect(((await paired.json()) as { error: { code: string } }).error.code).toBe("pairing_undone");
    expect(undone.body).toEqual({ status: "signed_out", revokedAtHost: true, queued: 0 });
    expect(host.logouts.map((l) => l.bearer)).toEqual(["Bearer paired-access"]);
    expect(existsSync(join(e.dataDir, "cloud-tokens.seal")), "the undone redeem sealed its session").toBe(false);
    expect(e.s.signedIn(), "the undone redeem activated its session").toBe(false);
    expect(await e.read()).toBe(409);
  });

  it("a plain sign-out marks the redeem too: every DELETE is the undo", async () => {
    const host = pairingHost();
    const e = await engine(host);
    const pairing = e.pair();
    await host.redeemAsked;
    const undoing = e.undo("");
    host.release();
    const [paired, undone] = await Promise.all([pairing, undoing]);
    expect(paired.status, "a redeem that landed under a sign-out was kept").toBe(409);
    expect(undone.body).toEqual({ status: "signed_out", revokedAtHost: true, queued: 0 });
    expect(host.logouts.map((l) => l.bearer)).toEqual(["Bearer paired-access"]);
    expect(existsSync(join(e.dataDir, "cloud-tokens.seal"))).toBe(false);
  });

  it("answers within ONE deadline when the other computer holds the sign-out", async () => {
    const host = pairingHost({ logout: "hang" });
    const e = await engine(host);
    const pairing = e.pair();
    await host.redeemAsked;
    const undoing = e.undo();
    await new Promise((r) => setTimeout(r, 2_000));
    host.release();
    const [paired, undone] = await Promise.all([pairing, undoing]);

    expect(paired.status).toBe(409);
    expect(undone.body).toEqual({ status: "signed_out", revokedAtHost: false, queued: 0 });
    expect(undone.ms).toBeLessThan(SIGN_OUT_AT_HOST_MS + 1_500);
    /* The redeem's sign-out spends what the undo had left, not a bound of its own. */
    const [logout] = host.logouts;
    expect(logout?.abortedAt, "the hung sign-out was never given up").not.toBeNull();
    expect(logout!.abortedAt! - (logout!.at - 2_000)).toBeLessThan(SIGN_OUT_AT_HOST_MS + 700);
    expect(existsSync(join(e.dataDir, "cloud-tokens.seal"))).toBe(false);
  });

  it("a redeem still out at the deadline is said as not taken back, and keeps nothing when it lands", async () => {
    const host = pairingHost();
    const e = await engine(host);
    const pairing = e.pair();
    await host.redeemAsked;
    const undone = await e.undo();
    expect(undone.body).toEqual({ status: "signed_out", revokedAtHost: false, queued: 0 });
    expect(undone.ms).toBeLessThan(SIGN_OUT_AT_HOST_MS + 1_500);
    host.release();
    const paired = await pairing;
    expect(paired.status).toBe(409);
    expect(host.logouts.map((l) => l.bearer)).toEqual(["Bearer paired-access"]);
    expect(existsSync(join(e.dataDir, "cloud-tokens.seal"))).toBe(false);
  });
});

describe("a redeem this install refuses", () => {
  it("signs the session the other computer minted out there too", async () => {
    const host = pairingHost({ account: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    const e = await engine(host, (dir) => {
      writeFileSync(join(dir, "mirror-owner"), encodeMirrorRecord(null, "https://desk.test", ACCOUNT), { mode: 0o600 });
    });
    host.release();
    const res = await e.pair();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("pair_account_mismatch");
    expect(host.logouts.map((l) => l.bearer)).toEqual(["Bearer paired-access"]);
  });
});

describe("the positive control", () => {
  it("a redeem nobody undid keeps its session, and signs nothing out", async () => {
    const host = pairingHost();
    const e = await engine(host);
    host.release();
    const res = await e.pair();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(e.s.signedIn()).toBe(true);
    expect(host.logouts).toEqual([]);
    expect(existsSync(join(e.dataDir, "cloud-tokens.seal"))).toBe(true);
  });
});
