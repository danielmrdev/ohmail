import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HttpAdapter, OhmailEngine, type EngineMutation } from "@ohmail/client-engine";

import { WindowOutboxStore } from "../../desktop/src/window-outbox-store.js";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * A SEND WITH NO DRAFT ROW IS TWO REQUESTS UNDER ONE KEY — `POST /drafts`, then
 * `POST /drafts/:id/send` — and the first one's 2xx is not the send's verdict. An unsent reply or
 * forward still waiting on this computer is counted wherever the waiting changes are said: before
 * the press, in the press's answer, on the refused card, and after a restart.
 */
const dirs: string[] = [];
const sidecars: CloudSidecar[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const MBX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DRAFT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SEND = {
  kind: "mail_send", inReplyTo: null, mailboxId: MBX, subject: "Invoice 12", body: "hello",
  to: [{ name: null, address: "ada@fake.test" }], cc: [], bcc: [],
} as unknown as EngineMutation;

interface Server {
  create: "ok" | "busy" | "slowOk";
  send: "busy" | "ok";
  refresh: "minted" | "refused";
  creates: Array<{ key: string | null; answered: number }>;
  sends: Array<{ key: string | null; answered: number }>;
}

function serverFetch(s: Server): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/drafts" && method === "POST") {
      const row = { key: new Headers(init?.headers).get("idempotency-key"), answered: 0 };
      s.creates.push(row);
      if (s.create === "busy") {
        row.answered = 503;
        return json({ error: { code: "unavailable", message: "busy", retryable: true } }, 503);
      }
      if (s.create === "slowOk") await new Promise((r) => setTimeout(r, 1_000));
      row.answered = 201;
      return json({ id: DRAFT, mailboxId: MBX, subject: "Invoice 12", bcc: [], contentRevision: "r1", updatedAt: new Date().toISOString() }, 201);
    }
    if (url.pathname === `/drafts/${DRAFT}/send` && method === "POST") {
      const row = { key: new Headers(init?.headers).get("idempotency-key"), answered: 0 };
      s.sends.push(row);
      if (s.send === "busy") {
        row.answered = 503;
        return json({ error: { code: "unavailable", message: "busy", retryable: true } }, 503);
      }
      row.answered = 200;
      return json({ status: "sent", providerMessageId: "<p1@fake.test>" });
    }
    if (url.pathname === "/auth/refresh") {
      if (s.refresh === "refused") return json({ error: { code: "refresh_revoked", message: "revoked" } }, 401);
      return json({ tokens: { accessToken: "minted-access", refreshToken: "minted-refresh", expiresIn: 900 } });
    }
    if (url.pathname === "/auth/logout") return new Response(null, { status: 204 });
    if (url.pathname === "/mailboxes") return json(mailboxList([hostedMailbox(MBX, "me@ohmail.test")]));
    if (url.pathname === "/sync") {
      return json({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c", hasMore: false, serverTime: new Date().toISOString() });
    }
    if (url.pathname === "/messages/bodies") return json({ items: [], nextCursor: null });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

async function launch(dataDir: string, s: Server, tokens: { accessToken: string; refreshToken: string }) {
  const sidecar = await createCloudSidecar({
    dataDir, cloudUrl: "https://host.test", address: "me@ohmail.test", fetchImpl: serverFetch(s),
    pollIntervalMs: 3_600_000, keks: { 1: Buffer.alloc(32, 7) }, tokens,
  });
  sidecars.push(sidecar);
  const bridge = async (path: string, init?: unknown): Promise<Response> => {
    const i = (init ?? {}) as RequestInit;
    const headers = new Headers(i.headers);
    headers.set("authorization", `Bearer ${sidecar.sessionToken}`);
    return sidecar.handle(new Request(`http://sidecar${path}`, { ...i, headers }));
  };
  const stop = async (): Promise<void> => {
    sidecars.splice(sidecars.indexOf(sidecar), 1);
    await sidecar.stop();
  };
  return { sidecar, bridge, stop };
}

function windowOver(bridge: (p: string, i?: unknown) => Promise<Response>, scope: string, clock: { ms: number }) {
  return new OhmailEngine({
    adapter: new HttpAdapter({ baseUrl: "", fetch: bridge as never }),
    store: new WindowOutboxStore({ scope, write: bridge, read: bridge }),
    now: () => new Date(clock.ms),
  });
}

/** Every outbox_entry row in every outbox file of the directory, with its key. */
const outboxKeys = (dataDir: string): string[] => {
  const keys: string[] = [];
  for (const f of readdirSync(dataDir)) {
    if (!/^window-outbox(\.[0-9a-f]{24})?\.json$/.test(f)) continue;
    const rows = (JSON.parse(readFileSync(join(dataDir, f), "utf8")) as { rows?: Array<{ type: string; entity?: { key?: string } }> }).rows ?? [];
    for (const r of rows) if (r.type === "outbox_entry") keys.push(String(r.entity?.key ?? ""));
  }
  return keys;
};
const until = async (ms: number, ok: () => boolean): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return ok();
};
const healthOf = async (bridge: (p: string, i?: unknown) => Promise<Response>) => {
  const h = (await (await bridge("/health")).json()) as { signedIn?: boolean; sessionExpired?: boolean; queued?: { count?: number | null } };
  return { signedIn: h.signedIn ?? null, sessionExpired: h.sessionExpired ?? null, queued: h.queued?.count ?? null };
};
const signOut = async (bridge: (p: string, i?: unknown) => Promise<Response>) =>
  (await (await bridge("/cloud/session", { method: "DELETE" })).json()) as { queued?: number; revokedAtHost?: boolean };

describe("an unsent send whose draft create was answered is counted as waiting", () => {
  it("the draft create answered 201, the send busy: counted before, in and after the press", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-sendkey-1-"); dirs.push(dataDir);
    const s: Server = { create: "ok", send: "busy", refresh: "minted", creates: [], sends: [] };
    const a = await launch(dataDir, s, { accessToken: "held-access", refreshToken: "held-refresh" });
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), { ms: Date.now() });
    await w.start();
    expect((await w.mutate(SEND)).status).toBe("queued");
    const onDisk = outboxKeys(dataDir);
    expect(onDisk, "control: the unsent send is on disk under the key both halves carried").toEqual([s.creates[0]!.key]);
    expect(s.sends[0]!.key).toBe(s.creates[0]!.key);
    expect((await healthOf(a.bridge)).queued, "an unsent message was left out before the press").toBe(1);
    expect((await signOut(a.bridge)).queued, "an unsent message was left out of the press's count").toBe(1);
    expect((await healthOf(a.bridge)).queued).toBe(1);
  });

  it("control: the draft create refused too, the same one row is counted", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-sendkey-2-"); dirs.push(dataDir);
    const s: Server = { create: "busy", send: "busy", refresh: "minted", creates: [], sends: [] };
    const a = await launch(dataDir, s, { accessToken: "held-access", refreshToken: "held-refresh" });
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), { ms: Date.now() });
    await w.start();
    expect((await w.mutate(SEND)).status).toBe("queued");
    expect(outboxKeys(dataDir)).toHaveLength(1);
    expect((await signOut(a.bridge)).queued).toBe(1);
  });

  it("Send, then Sign out while the draft create is on its way: the kept send is counted", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-sendkey-3-"); dirs.push(dataDir);
    const s: Server = { create: "slowOk", send: "ok", refresh: "minted", creates: [], sends: [] };
    const a = await launch(dataDir, s, { accessToken: "held-access", refreshToken: "held-refresh" });
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), { ms: Date.now() });
    await w.start();
    const pending = w.mutate(SEND);
    expect(await until(10_000, () => s.creates.length === 1)).toBe(true);
    const del = await signOut(a.bridge);
    const r = await pending;
    await until(1_000, () => outboxKeys(dataDir).length === 1);
    expect(r.status, "control: the send met the signed-out engine and was kept").toBe("queued");
    expect(s.creates.map((x) => x.answered), "control: the share let the draft create land").toEqual([201]);
    expect(outboxKeys(dataDir)).toHaveLength(1);
    expect(del.queued, "the unsent message the press kept was left out of its count").toBe(1);
    expect((await healthOf(a.bridge)).queued).toBe(1);
  });

  it("the draft create answered, the send busy, then the session refused: the card counts it", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-sendkey-4-"); dirs.push(dataDir);
    const s: Server = { create: "ok", send: "busy", refresh: "refused", creates: [], sends: [] };
    const a = await launch(dataDir, s, { accessToken: "held-access", refreshToken: "held-refresh" });
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), { ms: Date.now() });
    await w.start();
    expect((await w.mutate(SEND)).status).toBe("queued");
    await a.bridge("/cloud/session/renew", { method: "POST" });
    const card = await healthOf(a.bridge);
    expect(card.sessionExpired, "control: the session was refused").toBe(true);
    expect(outboxKeys(dataDir)).toHaveLength(1);
    expect(card.queued, "the refused card was told nothing waits while an unsent message does").toBe(1);
  });

  it("the kept send is counted after a restart and delivered once, under its key, at the next sign-in", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-sendkey-5-"); dirs.push(dataDir);
    const s: Server = { create: "ok", send: "busy", refresh: "minted", creates: [], sends: [] };
    const a = await launch(dataDir, s, { accessToken: "held-access", refreshToken: "held-refresh" });
    const clock = { ms: Date.now() };
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), clock);
    await w.start();
    await w.mutate(SEND);
    expect((await signOut(a.bridge)).queued).toBe(1);
    await a.stop();
    s.send = "ok";
    clock.ms += 10 * 60_000;
    const b = await launch(dataDir, s, { accessToken: "second-access", refreshToken: "second-refresh" });
    expect((await healthOf(b.bridge)).queued, "the restarted engine's count").toBe(1);
    const w2 = windowOver(b.bridge, b.sidecar.servedMailboxId(), clock);
    await w2.start();
    expect(await until(10_000, () => s.sends.some((x) => x.answered === 200)), "the next sign-in did not send it").toBe(true);
    expect(await until(3_000, () => outboxKeys(dataDir).length === 0), "a delivered send stayed on disk").toBe(true);
    const delivered = s.sends.filter((x) => x.answered === 200);
    expect(delivered, "not delivered exactly once").toHaveLength(1);
    expect(delivered[0]!.key, "delivered under another key").toBe(s.creates[0]!.key);
  });
});
