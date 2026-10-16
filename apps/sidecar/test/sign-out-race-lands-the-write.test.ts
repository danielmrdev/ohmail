import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { createCloudSidecar, SIGN_OUT_AT_HOST_MS, type CloudSidecar } from "../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * A WRITE ON ITS WAY AT THE SIGN-OUT PRESS IS APPLIED UNDER THE SESSION IT WAS MADE IN. The server
 * has real session state: the press's own `POST /auth/logout` ends the session the moment it
 * arrives, and a write is judged when IT arrives. Two shapes of "in flight": already judged and
 * being processed, or still on its way (a slow upload). Both land before the session ends.
 */
const dirs: string[] = [];
const sidecars: CloudSidecar[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const MSG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Shape = "processing" | "arriving";
async function door(shape: Shape) {
  const state = { revoked: false, applied: 0, refused401: 0, refreshes: 0 };
  const sleep = (ms: number, signal?: AbortSignal | null) => new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); });
  });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === `/messages/${MSG}` && method === "PATCH") {
      if (shape === "arriving") await sleep(1_500, init?.signal); // still uploading at the press
      if (state.revoked) {
        state.refused401 += 1;
        return json({ error: { code: "unauthorized", message: "authentication required" } }, 401);
      }
      if (shape === "processing") await sleep(1_500, init?.signal); // judged, then processed
      state.applied += 1;
      return json({ id: MSG, unread: false });
    }
    if (url.pathname === "/auth/logout") { state.revoked = true; return new Response(null, { status: 204 }); }
    if (url.pathname === "/auth/refresh") {
      state.refreshes += 1;
      return json({ error: { code: "refresh_revoked", message: "revoked" } }, 401);
    }
    if (url.pathname === "/mailboxes") return json(mailboxList([hostedMailbox("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "me@ohmail.test")]));
    if (url.pathname === "/sync") {
      return json({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c", hasMore: false, serverTime: new Date().toISOString() });
    }
    if (url.pathname === "/messages/bodies") return json({ items: [], nextCursor: null });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const dataDir = await freshDataDir("ohmail-sign-out-race-");
  dirs.push(dataDir);
  const sidecar = await createCloudSidecar({
    dataDir, cloudUrl: "https://host.test", address: "me@ohmail.test", fetchImpl,
    pollIntervalMs: 3_600_000, keks: { 1: Buffer.alloc(32, 7) },
    tokens: { accessToken: "held-access", refreshToken: "held-refresh" },
  });
  sidecars.push(sidecar);
  const auth = { authorization: `Bearer ${sidecar.sessionToken}` };
  const write = async () => {
    const res = await sidecar.handle(new Request(`http://sidecar/messages/${MSG}`, {
      method: "PATCH", headers: { ...auth, "content-type": "application/json", "idempotency-key": "race-key-1" },
      body: JSON.stringify({ unread: false }),
    }));
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    return { status: res.status, code: body?.error?.code ?? null };
  };
  const signOut = async () => (await sidecar.handle(new Request("http://sidecar/cloud/session", { method: "DELETE", headers: auth }))).status;
  return { write, signOut, state };
}

describe("a write on its way when Sign out is pressed lands under its session", () => {
  for (const shape of ["processing", "arriving"] as const) {
    it(`control (${shape}): with no press the write is applied`, { timeout: 30_000 }, async () => {
      const e = await door(shape);
      expect(await e.write()).toEqual({ status: 200, code: null });
      expect(e.state).toMatchObject({ applied: 1, refused401: 0 });
    });

    it(`a press 200 ms after the write left (${shape}): applied once, then the session ends`, { timeout: 30_000 }, async () => {
      const e = await door(shape);
      const pending = e.write();
      await new Promise((r) => setTimeout(r, 200));
      const t0 = Date.now();
      const deleted = await e.signOut();
      const pressMs = Date.now() - t0;
      const out = await pending;
      expect(deleted).toBe(200);
      expect(out, "the window was not told its write was done").toEqual({ status: 200, code: null });
      expect(e.state, "the write met the session the press ended").toMatchObject({ revoked: true, applied: 1, refused401: 0 });
      expect(pressMs, "the press waited past its deadline").toBeLessThan(SIGN_OUT_AT_HOST_MS);
    });
  }
});
