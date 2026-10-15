import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { authEvents } from "@trafficflow/db/cloud";
import { createApp, type ApiDeps } from "@trafficflow/api";
import { selfHostRoutes } from "@trafficflow/api/self-host";
import { makeHttpServer, makeTrustedProxies, type TrustedProxies } from "@trafficflow/core/adapters/http-host";
import { makeDeps } from "./helpers.js";

/**
 * THE SELF-HOST SERVER BEHIND ITS PROXY, end to end: the real route table and services on the real
 * adapter, the proxy's socket trusted by `TF_TRUSTED_PROXIES`, and the proxy's `x-forwarded-for`
 * written as the bundled proxy writes it (the client's address, one entry). Two clients are two
 * clients: one's wrong passwords do not lock the other out, the audit names each, and one's
 * registrations do not spend the other's. Without the setting the same requests are one client,
 * which is the shape the server shipped with and the reason the setting exists.
 */

const PW = "pw-correct-horse";
const A = "198.51.100.9";
const B = "192.0.2.44";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(() => r(null)));
  }
});

/** The server, listening on loopback; the test's own requests arrive from the "proxy" at 127.0.0.1. */
async function selfHost(deps: ApiDeps, trustedProxies?: TrustedProxies): Promise<string> {
  const app = createApp(selfHostRoutes);
  const server = makeHttpServer((r) => app.handle(r, { ...deps, session: null, idempotency: null }), {
    bodyMaxBytes: 64 * 1024, headersTimeoutMs: 30_000, requestTimeoutMs: 30_000,
    ...(trustedProxies ? { trustedProxies } : {}),
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
}

const loopbackProxy = (): TrustedProxies =>
  makeTrustedProxies(["127.0.0.1"], { lookup: async () => { throw new Error("no lookup expected"); } });

/** One request as the proxy forwards it for `client`. */
const post = (base: string, path: string, client: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": client },
    body: JSON.stringify(body),
  });

async function owner(base: string, email: string): Promise<void> {
  const res = await post(base, "/auth/register", A, { email, password: PW, displayName: "Owner", inviteCode: "INVITE-OK" });
  expect(res.status).toBe(201);
}

describe("self-host behind its proxy: the client address", () => {
  it("RED CONTROL: A's wrong passwords lock A, not B; the audit names each", async () => {
    const { db, deps } = await makeDeps(undefined, { maxFailures: 3 });
    const base = await selfHost(deps, loopbackProxy());
    await owner(base, "owner@x.example");

    for (let i = 0; i < 3; i++) {
      expect((await post(base, "/auth/login", A, { email: "owner@x.example", password: "WRONG" })).status).toBe(401);
    }
    expect((await post(base, "/auth/login", A, { email: "owner@x.example", password: PW })).status).toBe(423);
    expect((await post(base, "/auth/login", B, { email: "owner@x.example", password: PW })).status).toBe(200);

    const rows = await db.select({ event: authEvents.event, ip: authEvents.ip }).from(authEvents);
    expect(rows.filter((r) => r.event === "login_failed").map((r) => r.ip)).toEqual([A, A, A]);
    expect(rows.filter((r) => r.event === "enrollment_started").map((r) => r.ip).sort()).toEqual([A, B].sort());
  });

  it("RED CONTROL: A's registrations spend A's slot, never B's", async () => {
    const { deps } = await makeDeps(undefined, { maxRegistrationsPerWindow: 3 });
    const base = await selfHost(deps, loopbackProxy());
    const junk = (client: string, i: number) =>
      post(base, "/auth/register", client, { email: `j${i}@x.example`, password: PW, displayName: "J", inviteCode: "NOT-A-CODE" });
    for (let i = 0; i < 3; i++) expect((await junk(A, i)).status).toBe(403);
    expect((await junk(A, 3)).status).toBe(429);
    expect((await junk(B, 4)).status).toBe(403);
  });

  it("without the setting, the same requests are ONE client: the proxy", async () => {
    const { db, deps } = await makeDeps(undefined, { maxFailures: 3 });
    const base = await selfHost(deps);
    await owner(base, "owner@x.example");
    for (let i = 0; i < 3; i++) await post(base, "/auth/login", A, { email: "owner@x.example", password: "WRONG" });
    expect((await post(base, "/auth/login", B, { email: "owner@x.example", password: PW })).status).toBe(423);
    const failed = await db.select({ ip: authEvents.ip }).from(authEvents).where(eq(authEvents.event, "login_failed"));
    expect(new Set(failed.map((r) => r.ip))).toEqual(new Set(["127.0.0.1"]));
  });
});
