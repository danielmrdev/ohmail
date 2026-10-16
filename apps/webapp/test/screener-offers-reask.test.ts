import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SyncChange } from "@ohmail/client-engine";
import { createEngine } from "../app/shell/engine-config.js";

/**
 * THE TWO SCREENER OFFERS ARE ASKED AGAIN WHEN WHAT THEY COUNT CHANGES.
 *
 * "Held behind a rule you already made" counts rules whose past-mail walk has finished (or that
 * asked for none), and "from senders you have not decided about" counts mail no rule decides; both
 * count every mailbox. A rule reaching that state, or a mailbox removed, now re-asks both at the
 * settle of the pull that brought it. Before, each waited for its own trigger: the settings stamp,
 * or the next time the Screener opened. Driven through the engine the shell builds.
 */

const ARMED = { NEXT_PUBLIC_API_BASE: "/api" } as const;
const T = "2026-09-28T08:00:00.000Z";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function rule(id: string, retro: { requestedAt: string | null; doneAt: string | null }): Record<string, unknown> {
  return {
    id, kind: "sender", match: `${id}@one.test`, destination: "INBOX", priority: 0, provenance: "manual",
    enabled: true, subjectContains: null, bodyContains: null,
    stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: T, updatedAt: T, retro,
  };
}

let calls: string[] = [];
let page: SyncChange[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  page = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url.startsWith("/api/sync/snapshot")) {
      return Promise.resolve(json(200, {
        asOfSeq: 1, nextCursor: null, window: { days: 0, minRows: 0 },
        changes: [
          { type: "mailbox", op: "create", id: "mb2", seq: 1, updatedAt: T, entity: { id: "mb2", address: "two@example.test" } },
          { type: "rule", op: "create", id: "walking", seq: 1, updatedAt: T, entity: rule("walking", { requestedAt: T, doneAt: null }) },
        ],
      }));
    }
    if (url.startsWith("/api/sync?")) {
      const changes = page;
      page = [];
      return Promise.resolve(json(200, {
        changes: { creates: changes.filter((c) => c.op === "create"), updates: changes.filter((c) => c.op === "update"),
          moves: [], deletes: changes.filter((c) => c.op === "delete") },
        cursor: "2", hasMore: false, serverTime: T,
      }));
    }
    if (url === "/api/screener/held-releases") return Promise.resolve(json(200, { groups: [], total: 0, max: 200, fingerprint: "", dismissed: false }));
    if (url === "/api/screener/unscreened") return Promise.resolve(json(200, { groups: [], total: 0, max: 200 }));
    return Promise.resolve(json(404, { error: { code: "not_found", message: "no stub for this route" } }));
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

const asks = (from: number) => ({
  held: calls.slice(from).filter((c) => c === "GET /api/screener/held-releases").length,
  unscreened: calls.slice(from).filter((c) => c === "GET /api/screener/unscreened").length,
});
async function settled(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
}

async function armed() {
  const engine = createEngine(false, ARMED);
  await engine.start();
  // The Screener asks both on mount, which is what arms them in this process.
  await engine.refreshHeldReleases();
  await engine.refreshUnscreened();
  return engine;
}

describe("the Screener's two offers", () => {
  it("are asked again when a rule's past-mail walk finishes", async () => {
    const engine = await armed();
    const from = calls.length;
    page = [{ type: "rule", op: "update", id: "walking", seq: 2, updatedAt: T, entity: rule("walking", { requestedAt: T, doneAt: T }) } as SyncChange];
    await engine.syncOnce();
    await settled();
    expect(asks(from), "a finished walk left both offers as they were").toEqual({ held: 1, unscreened: 1 });
  });

  it("are asked again when a rule arrives that asked for no walk", async () => {
    const engine = await armed();
    const from = calls.length;
    page = [{ type: "rule", op: "create", id: "now", seq: 2, updatedAt: T, entity: rule("now", { requestedAt: null, doneAt: null }) } as SyncChange];
    await engine.syncOnce();
    await settled();
    expect(asks(from)).toEqual({ held: 1, unscreened: 1 });
  });

  it("are asked again when a mailbox is removed", async () => {
    const engine = await armed();
    const from = calls.length;
    page = [{ type: "mailbox", op: "delete", id: "mb2", seq: 2, updatedAt: T, entity: null } as unknown as SyncChange];
    await engine.syncOnce();
    await settled();
    expect(asks(from), "a removal left both offers counting its mail").toEqual({ held: 1, unscreened: 1 });
  });

  it("are not asked again for a rule whose walk is still running", async () => {
    const engine = await armed();
    const from = calls.length;
    page = [{ type: "rule", op: "create", id: "fresh", seq: 2, updatedAt: T, entity: rule("fresh", { requestedAt: T, doneAt: null }) } as SyncChange];
    await engine.syncOnce();
    await settled();
    expect(asks(from)).toEqual({ held: 0, unscreened: 0 });
  });

  it("are not asked by a process whose Screener never asked", async () => {
    const engine = createEngine(false, ARMED);
    await engine.start();
    const from = calls.length;
    page = [{ type: "mailbox", op: "delete", id: "mb2", seq: 2, updatedAt: T, entity: null } as unknown as SyncChange];
    await engine.syncOnce();
    await settled();
    expect(asks(from)).toEqual({ held: 0, unscreened: 0 });
  });
});
