import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { sql } from "drizzle-orm";

import { createSidecar, SIDECAR_NET_TIMEOUTS, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ═══ A MAIL SERVER ON THIS COMPUTER GETS THE SYNC DIAL'S WAIT, THROUGH THE REAL ROUTES ═════
 *
 * The probe option is proved in `packages/api` on an injected dialler; this file proves the
 * desktop's own composition passes it. Each case drives the shipped route through
 * `config.adapterFactory` (the same `probeOpts` the production branch builds, one key for both) and
 * a dialler that holds the sign-in in virtual time, honouring the socket timeout it was BUILT with
 * the way imapflow does — so a probe dialled with the old timeout dies at it here too.
 */

const SEED_HOST = "imap.example.test";
const SEED_USER = "owner@example.test";
const PROBE_USER = "gateway-user@example.test";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Hold { ms: number; honour: boolean; refuse?: boolean }

/** The engine's dialler: the seed boots at once; a probe for PROBE_USER holds per `hold`. */
function dialer(hold: Hold, built: Array<{ host?: string; timeouts?: unknown }>) {
  return (cfg: { auth?: { user?: string }; host?: string; timeouts?: { socketMs?: number } }) => ({
    async connect(): Promise<void> {
      if (cfg.auth?.user !== PROBE_USER) return;
      built.push({ host: cfg.host, timeouts: cfg.timeouts });
      await new Promise<void>((resolve, reject) => {
        const socketMs = cfg.timeouts?.socketMs ?? Number.POSITIVE_INFINITY;
        if (hold.honour && hold.ms > socketMs) {
          setTimeout(() => reject(Object.assign(new Error("Socket timeout"), { code: "ETIMEOUT" })), socketMs);
        } else {
          setTimeout(() => {
            if (hold.refuse) reject(Object.assign(new Error("LOGIN failed"), { authenticationFailed: true }));
            else resolve();
          }, hold.ms);
        }
      });
    },
    async close(): Promise<void> {},
    async listFolders(): Promise<string[]> { return ["INBOX", "Sent", "Drafts", "Trash", "Junk", "Archive", "Notes"]; },
    leaseIo: () => ({
      async ensureMetaFolder(): Promise<void> {},
      async listClaims(): Promise<never[]> { return []; },
      async appendClaim(): Promise<void> {},
      async removeClaims(): Promise<void> {},
      uidValidity: () => 4_100,
    }),
    leasePeekIo: () => ({ async listClaims(): Promise<never[]> { return []; } }),
    async capabilities() {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince() { return { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } }; },
    async move() { return { folder: "INBOX", ref: "1:1" }; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
  });
}

async function boot(hold: Hold): Promise<{ s: Sidecar; built: Array<{ host?: string; timeouts?: unknown }> }> {
  const built: Array<{ host?: string; timeouts?: unknown }> = [];
  const dataDir = await freshDataDir("ohmail-local-wait-");
  const s = await createSidecar({
    dataDir,
    imap: { host: SEED_HOST, port: 993, secure: true, auth: { user: SEED_USER, pass: "seed-password" } },
    address: SEED_USER,
    machineName: "this machine",
    pollIntervalMs: 60 * 60 * 1000,
    leaseStaleAfterMs: 60_000,
    keks: { 1: Buffer.alloc(32, 7) },
    adapterFactory: dialer(hold, built),
    log: () => {},
  } as never);
  cleanups.push(async () => {
    await s.stop().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  });
  await s.start();
  return { s, built };
}

const imapBody = (host: string) => ({ host, port: 1143, secure: false, user: PROBE_USER, pass: "gateway-password" });

/** One request, run under virtual time until `runMs` has passed; the response and when it came. */
async function underVirtualTime(s: Sidecar, path: string, body: unknown, runMs: number) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
  const t0 = Date.now();
  let at: number | null = null;
  const pending = s.handle(new Request(`http://local${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })).then((r) => { at = Date.now() - t0; return r; });
  await vi.advanceTimersByTimeAsync(runMs);
  const res = await pending;
  vi.useRealTimers();
  return { res, at: at as number | null };
}

const credentialRows = async (s: Sidecar): Promise<number> =>
  Number(((await s.db.execute(sql`select count(*)::int as n from mailbox_credentials`)) as unknown as {
    rows: Array<{ n: number }>;
  }).rows[0]!.n);

describe("POST /local/mailboxes/probe — the local-gateway wait", () => {
  it("127.0.0.1 holding the sign-in 90 s answers 200 with the folder count, dialled with the sync dial's timeouts", async () => {
    const { s, built } = await boot({ ms: 90_000, honour: true });
    const { res } = await underVirtualTime(s, "/local/mailboxes/probe", { address: PROBE_USER, imap: imapBody("127.0.0.1") }, 95_000);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { folders?: number }).folders).toBe(7);
    expect(built.map((b) => b.timeouts)).toEqual([SIDECAR_NET_TIMEOUTS]);
  });

  it("the same hold on a remote host is refused as a timeout, with no local stamp", async () => {
    const { s } = await boot({ ms: 90_000, honour: true });
    const { res } = await underVirtualTime(s, "/local/mailboxes/probe", { address: PROBE_USER, imap: imapBody("imap.public.test") }, 95_000);
    expect(res.status).toBe(502);
    const wire = (await res.json()) as { error: { code: string; details?: { reason?: string; localServer?: boolean } } };
    expect(wire.error.details?.reason).toBe("timeout");
    expect(wire.error.details?.localServer).toBeUndefined();
  });

  it("a NO from a server on this computer carries details.localServer: true", async () => {
    const { s } = await boot({ ms: 1_000, honour: true, refuse: true });
    const { res } = await underVirtualTime(s, "/local/mailboxes/probe", { address: PROBE_USER, imap: imapBody("localhost") }, 2_000);
    expect(res.status).toBe(400);
    const wire = (await res.json()) as { error: { details?: { reason?: string; localServer?: boolean } } };
    expect(wire.error.details).toMatchObject({ reason: "auth", localServer: true });
    expect((wire.error as { message?: string }).message).not.toMatch(/app-specific password/);
  });
});

describe("POST /local/mailboxes — a hold past the bound stores nothing", () => {
  it("a sign-in that never answers is refused as a timeout at the 150 s bound, and no credential row is written", async () => {
    const { s } = await boot({ ms: 400_000, honour: false });
    const before = await credentialRows(s);
    const { res, at } = await underVirtualTime(s, "/local/mailboxes", {
      provider: "imap", address: PROBE_USER, imap: imapBody("127.0.0.1"),
      smtp: { host: "127.0.0.1", port: 1025, secure: false },
    }, 160_000);
    expect(res.status).toBe(502);
    // This route's envelope carries the engine's message and no details; the first-run connect
    // renders that message, so the local reading has to be in it.
    expect(((await res.json()) as { error: { message?: string } }).error.message)
      .toMatch(/^The server on this computer did not answer in time\./);
    const bound = SIDECAR_NET_TIMEOUTS.connectionMs + SIDECAR_NET_TIMEOUTS.greetingMs + SIDECAR_NET_TIMEOUTS.socketMs;
    expect(at).toBeGreaterThanOrEqual(bound);
    expect(at).toBeLessThan(bound + 5_000);
    expect(await credentialRows(s)).toBe(before);
  });
});
