/**
 * THE STANDALONE DOOR — the same client, talking to an engine in this runtime instead of a server.
 *
 * A paired phone reaches a desktop or the hosted service over the network. A standalone phone
 * organizes its own mailbox, and the engine doing that runs in this same runtime, so the client's
 * transport is a function call rather than a socket. This file drives `bootEngine` on that arm.
 *
 * ── THE PROPERTY THAT MATTERS MOST IS THE ONE ABOUT THE OTHER THREE DOORS ─────────────────
 *
 * This app already has three doors and they must not acquire a branch. So the assertions here come
 * in pairs: what the standalone arm does, and — in the last block — that the ordinary paired door
 * still behaves exactly as it did, composed the same way, through a network transport. A test file
 * for a new arm that only exercises the new arm cannot see the regression it is most likely to
 * cause.
 *
 * ── AND THE TRANSPORT IS ASSERTED BY DRIVING IT, NOT BY READING THE COMPOSITION ────────────
 *
 * The door below answers the real `/sync` contract — snapshot, then pages — so the engine actually
 * drains through it and the mirror actually holds mail at the end. A test that asserted "the fetch
 * seam was set to the right function" would pass over a composition that never used it.
 */
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeSeqCursor,
  type SqlExecutor,
  type SqlRow,
  type SqlValue,
  type SyncChange,
} from "@ohmail/client-engine";

import {
  LOCAL_ENGINE_ORIGIN,
  bootEngine,
  type LocalEngineDoor,
  type MobileEngineDeps,
} from "../src/engine/boot";
import { sayRefusal } from "../src/refusal";

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function nodeSqlExecutor(db: DatabaseSync): SqlExecutor {
  return {
    async all(sql: string, params: ReadonlyArray<SqlValue> = []): Promise<SqlRow[]> {
      return db.prepare(sql).all(...params) as SqlRow[];
    },
    async batch(statements): Promise<void> {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const { sql, params = [] } of statements) db.prepare(sql).run(...params);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

const handles: DatabaseSync[] = [];
function deps(overrides: Partial<MobileEngineDeps> = {}): MobileEngineDeps {
  return {
    /* One in-memory store per open. The NAME is deliberately ignored: this fixture is about the
       transport, and a store keyed by name would make two cases share one database. */
    openExecutor: () => {
      const db = new sqlite.DatabaseSync(":memory:");
      handles.push(db);
      return nodeSqlExecutor(db);
    },
    deleteDatabase: async () => undefined,
    uuid: () => `11111111-1111-4111-8111-${String(handles.length).padStart(12, "0")}`,
    /**
     * THE GLOBAL TRANSPORT, ARMED TO FAIL. Any request that escaped the local door would come
     * here, and it must not be a silent fallback: the whole claim of this arm is that mail never
     * touches a network on a standalone install.
     */
    fetch: async () => {
      throw new Error("the global transport was used on the standalone door");
    },
    ...overrides,
  };
}

afterEach(() => {
  for (const h of handles.splice(0)) { try { h.close(); } catch { /* already closed */ } }
});

interface DoorLog {
  readonly urls: string[];
  readonly bearers: (string | null)[];
}

/**
 * The engine's own local API, minimally: the `/sync` family, answering the real contract.
 *
 * `sessionToken` is a GETTER so the case below can prove the bearer is read per request rather
 * than captured once — a captured token would be stale on a launch that rotated it.
 */
function localDoor(log: DoorLog, changes: SyncChange[], token: { value: string }): LocalEngineDoor {
  return {
    get sessionToken() { return token.value; },
    async handle(req: Request): Promise<Response> {
      const url = new URL(req.url);
      log.urls.push(req.url);
      log.bearers.push(req.headers.get("authorization"));
      const json = (status: number, body: unknown): Response =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

      if (url.pathname === "/sync/snapshot") {
        return json(200, {
          asOfSeq: changes.length,
          changes: changes.map((c, i) => ({ ...c, seq: i + 1 })),
          nextCursor: null,
          window: { days: 90, minRows: 5000 },
        });
      }
      if (url.pathname === "/sync") {
        return json(200, {
          changes: { creates: [], updates: [], moves: [], deletes: [] },
          cursor: encodeSeqCursor(changes.length),
          hasMore: false,
          serverTime: new Date().toISOString(),
        });
      }
      if (url.pathname === "/sync/pull" && req.method === "POST") {
        return json(200, { results: [] });
      }
      return json(404, { error: { code: "not_found", message: url.pathname } });
    },
  };
}

/**
 * A `message` create in the shape the real sync service emits.
 *
 * Copied from the neighbouring suite's own fixture rather than invented: the first version here was
 * hand-built with a `data` field and the drain accepted the page, applied nothing, and reported a
 * mirror with zero messages — a green transport over an empty store. The change carries `entity`,
 * an `updatedAt`, and a DTO whose every field the projection reads.
 */
function messageChange(id: string, seq: number, subject: string, accountId = "acct-standalone"): SyncChange {
  return {
    type: "message",
    op: "create",
    id,
    seq,
    updatedAt: "2026-09-07T08:00:00Z",
    entity: {
      id,
      accountId,
      mailboxId: "mb-1",
      threadId: null,
      messageIdHeader: `<${id}@local>`,
      subject,
      from: { name: "A Sender", address: "sender@example.test" },
      to: [],
      cc: [],
      date: "2026-09-07T08:00:00Z",
      folder: "INBOX",
      snippet: subject,
      unread: true,
      hasAttachments: false,
      attachmentCount: 0,
      sensitivity: {
        sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false,
        priority: false,
      },
      triage: null,
      labels: [],
      remoteContent: "none",
      updatedAt: "2026-09-07T08:00:00Z",
      seqHint: seq,
    },
  } as unknown as SyncChange;
}

describe("the standalone door", () => {
  it("drains through the engine in this runtime, and never through a network", async () => {
    const log: DoorLog = { urls: [], bearers: [] };
    const token = { value: "launch-token-1" };
    const boot = await bootEngine(deps(), {
      origin: LOCAL_ENGINE_ORIGIN,
      accountId: "acct-standalone",
      localEngine: localDoor(log, [messageChange("m1", 1, "Welcome"), messageChange("m2", 2, "Your invoice")], token),
    });

    expect(boot.kind).toBe("ready");
    if (boot.kind !== "ready") return;

    await boot.engine.start();

    // THE MAIL IS IN THE MIRROR. Asserted through the engine's own reader rather than through a
    // call count: a composition that used the door and dropped the answer would satisfy the count.
    expect(boot.engine.read().list("message").length).toBe(2);

    // EVERY request went to the local door, on the absolute local base, and none to the network —
    // the `fetch` in `deps()` throws precisely so a fallback cannot be silent.
    expect(log.urls.length).toBeGreaterThan(0);
    expect(log.urls.every((u) => u.startsWith(`${LOCAL_ENGINE_ORIGIN}/`))).toBe(true);
    boot.store.close();
  }, 60_000);

  it("carries the engine's own bearer, read per request", async () => {
    const log: DoorLog = { urls: [], bearers: [] };
    const token = { value: "first" };
    const boot = await bootEngine(deps(), {
      origin: LOCAL_ENGINE_ORIGIN,
      accountId: "acct-standalone",
      localEngine: localDoor(log, [messageChange("m1", 1, "Welcome")], token),
    });
    if (boot.kind !== "ready") throw new Error(sayRefusal(boot.reason));

    await boot.engine.start();
    expect(log.bearers.every((b) => b === "Bearer first")).toBe(true);

    // ROTATED MID-LAUNCH: the next request must carry the new one. A captured token would keep
    // sending the old value, which on a real door is a 401 on every request after a rotation.
    token.value = "second";
    const before = log.bearers.length;
    await boot.engine.syncOnce();
    expect(log.bearers.slice(before).every((b) => b === "Bearer second")).toBe(true);
    boot.store.close();
  }, 60_000);

  it("needs no credential from its caller — the engine mints its own", async () => {
    // A standalone install has nobody to be given a token by. It still needs an account id, which
    // is what keys the mirror.
    const log: DoorLog = { urls: [], bearers: [] };
    const boot = await bootEngine(deps(), {
      origin: LOCAL_ENGINE_ORIGIN,
      accountId: "acct-standalone",
      localEngine: localDoor(log, [], { value: "t" }),
    });
    expect(boot.kind).toBe("ready");
    if (boot.kind === "ready") boot.store.close();
  }, 60_000);

  it("still refuses when the account id is missing", async () => {
    // The positive control's mirror image: "no credential needed" must not have become "nothing
    // needed". Without an account id the mirror has no owner and a wrong one costs a wipe.
    const log: DoorLog = { urls: [], bearers: [] };
    const boot = await bootEngine(deps(), {
      origin: LOCAL_ENGINE_ORIGIN,
      accountId: "   ",
      localEngine: localDoor(log, [], { value: "t" }),
    });
    expect(boot).toMatchObject({ kind: "refused" });
  }, 60_000);

  it("refuses a local engine handed a remote address", async () => {
    const log: DoorLog = { urls: [], bearers: [] };
    const boot = await bootEngine(deps(), {
      origin: "https://mail.example.org",
      accountId: "acct-standalone",
      localEngine: localDoor(log, [], { value: "t" }),
    });
    // Refused rather than corrected: a caller passing both has not decided which it is talking to,
    // and keying the mirror by the other string would fork one install's copy of its own mailbox.
    expect(boot).toMatchObject({ kind: "refused" });
    if (boot.kind === "refused") expect(sayRefusal(boot.reason)).toContain(LOCAL_ENGINE_ORIGIN);
    expect(log.urls).toEqual([]);
  }, 60_000);

  it("opens the drain routes immediately, without asking the door about itself", async () => {
    const log: DoorLog = { urls: [], bearers: [] };
    const boot = await bootEngine(deps(), {
      origin: LOCAL_ENGINE_ORIGIN,
      accountId: "acct-standalone",
      localEngine: localDoor(log, [], { value: "t" }),
    });
    if (boot.kind !== "ready") throw new Error(sayRefusal(boot.reason));

    // The identity probe exists to catch a bearer belonging to a DIFFERENT account than the mirror
    // is keyed by — a remote server's answer about a locally stored id. There is no remote server
    // here and exactly one account, so running it would ask the local door a question about itself
    // and hold the drain shut for the full deadline with no route to answer.
    const before = log.urls.length;
    expect(await boot.verifyIdentity()).toEqual({ kind: "unverified" });
    expect(log.urls.slice(before)).toEqual([]);

    // And the drain works straight away rather than after a timeout.
    await boot.engine.start();
    expect(log.urls.length).toBeGreaterThan(before);
    boot.store.close();
  }, 60_000);
});

describe("the paired door, unchanged — the regression this file exists to catch", () => {
  it("still composes over a network transport with a static bearer", async () => {
    const seen: { url: string; bearer: string | null }[] = [];
    const changes = [messageChange("p1", 1, "Paired", "acct-remote")];
    const netFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      const u = new URL(url);
      seen.push({ url, bearer: new Headers(init?.headers).get("authorization") });
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (u.pathname === "/auth/session") return json({ account: { id: "acct-remote" } });
      if (u.pathname === "/sync/snapshot") {
        return json({
          asOfSeq: 1,
          changes: changes.map((c, i) => ({ ...c, seq: i + 1 })),
          nextCursor: null,
          window: { days: 90, minRows: 5000 },
        });
      }
      if (u.pathname === "/sync") {
        return json({
          changes: { creates: [], updates: [], moves: [], deletes: [] },
          cursor: encodeSeqCursor(1), hasMore: false, serverTime: new Date().toISOString(),
        });
      }
      if (u.pathname === "/sync/pull") return json({ results: [] });
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    };

    const boot = await bootEngine(deps({ fetch: netFetch }), {
      origin: "https://mail.example.org",
      accountId: "acct-remote",
      token: "paired-token",
    });
    if (boot.kind !== "ready") throw new Error(sayRefusal(boot.reason));

    // The probe RUNS on this door — the behaviour the standalone arm skips — and clears.
    expect((await boot.verifyIdentity()).kind).not.toBe("mismatch");
    await boot.engine.start();

    expect(boot.engine.read().list("message").length).toBe(1);
    expect(seen.every((s) => s.url.startsWith("https://mail.example.org/"))).toBe(true);
    expect(seen.every((s) => s.bearer === "Bearer paired-token")).toBe(true);
    // And it really did reach for the network seam rather than a local door.
    expect(seen.some((s) => s.url.includes("/auth/session"))).toBe(true);
    boot.store.close();
  }, 60_000);
});
