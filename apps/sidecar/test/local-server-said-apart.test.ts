import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImapConfig } from "@trafficflow/core/adapters/imap";
import {
  createSidecar, dialWentQuiet, discloseLocalSyncFailures, LOCAL_CONNECTION_DEAD_AFTER_MS, type Sidecar,
} from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * A SERVER ON THIS COMPUTER IS SAID AS ITS OWN (ruled 2026-10-07 runtime-timeout-sentence). A
 * local gateway's NO is its own sign-in refusing, and its silence is that sign-in still running;
 * the runtime keeps both facts and the overlay names them beside the code, for a loopback host
 * only. A remote host that went quiet is an outage as before: the generic line, after the bound.
 */

const AT = new Date("2026-10-07T12:00:00.000Z");
type State = Parameters<typeof discloseLocalSyncFailures>[1][number];
const row = (id: string) => ({
  id, status: "connected", organizerRole: "organizer", organizeConsentedAt: "2026-09-01T00:00:00.000Z",
  errorCode: null, errorDetail: null, syncBlockedReason: null, syncBlockedSince: null,
});
async function overlay(states: State[]): Promise<Array<Record<string, unknown>>> {
  const res = new Response(JSON.stringify({ items: states.map((s) => row(s.mailboxId)) }));
  return ((await (await discloseLocalSyncFailures(res, states, AT)).json()) as { items: Array<Record<string, unknown>> }).items;
}
const young = new Date(AT.getTime() - 5_000);

describe("the overlay names a local server's refusal and silence beside the code", () => {
  it("a local NO is auth with errorLocalServer; a remote NO is auth alone", async () => {
    const [local, remote] = await overlay([
      { mailboxId: "l", connection: { signInRefused: true, unreachableSince: null, localServer: true } },
      { mailboxId: "r", connection: { signInRefused: true, unreachableSince: null, localServer: false } },
    ]);
    expect(local).toMatchObject({ status: "error", errorCode: "auth", errorLocalServer: true });
    expect(remote).toMatchObject({ status: "error", errorCode: "auth" });
    expect(remote!.errorLocalServer).toBeUndefined();
  });

  it("a local server that went quiet is timeout at once, the dial having waited its two minutes", async () => {
    const [local] = await overlay([
      { mailboxId: "l", connection: { signInRefused: false, unreachableSince: young, localServer: true, signInWentQuiet: true } },
    ]);
    expect(local).toMatchObject({ status: "error", errorCode: "timeout", errorLocalServer: true });
  });

  it("a REMOTE host that went quiet keeps the generic outage: nothing young, connect after the bound (ruled control)", async () => {
    const [youngRemote, oldRemote] = await overlay([
      { mailboxId: "y", connection: { signInRefused: false, unreachableSince: young, localServer: false, signInWentQuiet: true } },
      {
        mailboxId: "o",
        connection: {
          signInRefused: false, unreachableSince: new Date(AT.getTime() - LOCAL_CONNECTION_DEAD_AFTER_MS - 1),
          localServer: false, signInWentQuiet: true,
        },
      },
    ]);
    expect(youngRemote).toMatchObject({ status: "connected", errorCode: null });
    expect(youngRemote!.unreachableSince).toBe(young.toISOString());
    expect(oldRemote).toMatchObject({ status: "error", errorCode: "connect" });
    expect(oldRemote!.errorLocalServer).toBeUndefined();
  });

  it("a local server that is merely unreachable (refused, not quiet) is the generic outage too", async () => {
    const [local] = await overlay([
      { mailboxId: "l", connection: { signInRefused: false, unreachableSince: young, localServer: true, signInWentQuiet: false } },
    ]);
    expect(local).toMatchObject({ status: "connected", errorCode: null });
  });
});

describe("dialWentQuiet — only the socket's silence", () => {
  it("is ETIMEOUT, at any depth of cause, and nothing else", () => {
    expect(dialWentQuiet(Object.assign(new Error("Socket timeout"), { code: "ETIMEOUT" }))).toBe(true);
    expect(dialWentQuiet(Object.assign(new Error("wrapped"), { cause: Object.assign(new Error("x"), { code: "ETIMEOUT" }) }))).toBe(true);
    for (const code of ["ECONNREFUSED", "GREETING_TIMEOUT", "CONNECT_TIMEOUT", "ETIMEDOUT", "NoConnection"]) {
      expect(dialWentQuiet(Object.assign(new Error(code), { code })), code).toBe(false);
    }
    expect(dialWentQuiet(Object.assign(new Error("LOGIN failed"), { authenticationFailed: true }))).toBe(false);
  });
});

/* ── the runtime, through the engine's own routes ──────────────────────────────────────────── */

const USER = "me@gateway.test";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function bootQuiet(host: string): Promise<Sidecar> {
  const dataDir = await freshDataDir("ohmail-local-quiet-");
  const s = await createSidecar({
    dataDir,
    imap: { host, port: 1143, secure: false, auth: { user: USER, pass: "gateway-password" } },
    address: USER,
    machineName: "this machine",
    pollIntervalMs: 60 * 60 * 1000,
    leaseStaleAfterMs: 60_000,
    keks: { 1: Buffer.alloc(32, 7) },
    adapterFactory: (_cfg: ImapConfig) => ({
      async connect(): Promise<void> { throw Object.assign(new Error("Socket timeout"), { code: "ETIMEOUT" }); },
      async close(): Promise<void> {},
    }),
    log: () => {},
  } as never);
  cleanups.push(async () => {
    await s.stop().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  });
  await s.start().catch(() => undefined);
  return s;
}

async function read(s: Sidecar, path: string): Promise<Array<Record<string, unknown>>> {
  const res = await s.handle(new Request(`http://local${path}`, { headers: { authorization: `Bearer ${s.sessionToken}` } }));
  return ((await res.json()) as { items: Array<Record<string, unknown>> }).items;
}

describe("the runtime keeps the facts, and the routes say them", () => {
  it("a loopback seed whose launch went quiet: localServer and signInWentQuiet, and the row is timeout", async () => {
    const s = await bootQuiet("127.0.0.1");
    const [conn] = await read(s, "/local/mailboxes/connections");
    expect(conn).toMatchObject({ localServer: true, signInWentQuiet: true, signInRefused: false });
    const [mbx] = await read(s, "/mailboxes");
    expect(mbx).toMatchObject({ status: "error", errorCode: "timeout", errorLocalServer: true });
  });

  it("the same silence from a remote seed is the young generic outage (ruled control)", async () => {
    const s = await bootQuiet("imap.remote.test");
    const [conn] = await read(s, "/local/mailboxes/connections");
    expect(conn).toMatchObject({ localServer: false, signInWentQuiet: true });
    const [mbx] = await read(s, "/mailboxes");
    expect(mbx).toMatchObject({ status: "connected" });
    expect(mbx!.errorLocalServer).toBeUndefined();
    expect(typeof mbx!.unreachableSince).toBe("string");
  });
});
