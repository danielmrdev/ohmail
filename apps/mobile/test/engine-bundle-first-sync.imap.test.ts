import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { BUNDLE, buildPhoneEngine } from "../scripts/bundle-engine.mjs";

/**
 * THE ARTIFACT'S FIRST SYNC READS EVERY SELECT ANSWER — PERF-026, against a real IMAP server, under
 * BOTH schedulers the bundle meets: node's `setImmediate`, and React Native's, which bridgeless 0.86
 * installs as a `queueMicrotask` shim (`Libraries/Core/setUpTimers.js`). With a microtask `nextTick`
 * the parser's next line lands in imapflow's reader guard gap and the SELECT answer is never read
 * (measured: 0 of 30 at the 30 s bound). The phone bundle re-arms that reader (`bundle-engine.mjs`).
 */
const require_ = createRequire(import.meta.url);
const sqlite = require_("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void; close(): void;
    prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown; columns?(): { name?: string }[] };
  };
};
const HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.OHMAIL_PHONE_IMAP_PORT ?? process.env.IMAP_PORT ?? 3143);
const LETTERS = 30;

function loadArtifact(): Record<string, unknown> {
  const Module = require_("node:module") as { _load(req: string, parent: unknown, isMain: boolean): unknown };
  const original = Module._load;
  Module._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === "react-native-tcp-socket") {
      const net = require_("node:net") as Record<string, unknown>;
      const tls = require_("node:tls") as Record<string, unknown>;
      return { createConnection: net.createConnection, connectTLS: tls.connect, TLSSocket: tls.TLSSocket,
               isIP: net.isIP, isIPv4: net.isIPv4, isIPv6: net.isIPv6 };
    }
    if (request === "react-native-quick-crypto") return require_("node:crypto");
    return original.call(this, request, parent, isMain);
  };
  try {
    delete (require_ as unknown as { cache?: Record<string, unknown> }).cache?.[BUNDLE];
    return require_(BUNDLE) as Record<string, unknown>;
  } finally { Module._load = original; }
}

function sqlExecutor() {
  const raw = new sqlite.DatabaseSync(":memory:");
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T,>(job: () => T): Promise<T> => { const n = tail.then(job, job); tail = n.catch(() => undefined); return n; };
  return {
    all: (sql: string, params: readonly unknown[]) => serial(() => {
      const st = raw.prepare(sql);
      const columns = (st.columns?.() ?? []).map((c) => c.name ?? "");
      const objects = st.all(...(params as unknown[])) as Record<string, unknown>[];
      return { columns, rows: columns.length > 0 ? objects.map((o) => columns.map((c) => o[c])) : objects.map((o) => Object.values(o)) };
    }),
    run: (sql: string, params: readonly unknown[]) => serial(() => { raw.prepare(sql).run(...(params as unknown[])); }),
    batch: (statements: readonly { sql: string; params?: readonly unknown[] }[]) => serial(() => {
      raw.exec("BEGIN IMMEDIATE");
      try { for (const { sql, params = [] } of statements) raw.prepare(sql).run(...(params as unknown[])); raw.exec("COMMIT"); }
      catch (err) { try { raw.exec("ROLLBACK"); } catch { /* keep the first error */ } throw err; }
    }),
    close: async () => { try { raw.close(); } catch { /* closed */ } },
  };
}

/** A fresh fixture mailbox of `LETTERS` letters. The server runs with authentication disabled. */
async function seed(user: string): Promise<void> {
  const { ImapFlow } = require_(require_.resolve("imapflow", { paths: [require_.resolve("../../../packages/core/package.json")] })) as {
    ImapFlow: new (o: unknown) => { connect(): Promise<void>; append(p: string, raw: string): Promise<unknown>; logout(): Promise<void> };
  };
  const c = new ImapFlow({ host: HOST, port: PORT, secure: false, auth: { user, pass: "fixture" }, logger: false });
  await c.connect();
  for (let i = 0; i < LETTERS; i += 1) {
    await c.append("INBOX", [`From: Sender ${i % 5} <s${i % 5}@sender.test>`, `To: ${user}`, `Subject: Letter ${i}`,
      "Date: Wed, 30 Sep 2026 12:00:00 +0000", `Message-ID: <first-sync-${i}-${user}>`, "", `Body ${i}.`, ""].join("\r\n"));
  }
  await c.logout();
}

let live: { stop(): Promise<void> } | null = null;
afterEach(async () => { if (live) await live.stop().catch(() => undefined); live = null; });

/** React Native's `setImmediate` as bridgeless 0.86 installs it: a `queueMicrotask` shim. */
const nodeSetImmediate = globalThis.setImmediate;
function installReactNativeImmediate(): void {
  (globalThis as { setImmediate: unknown }).setImmediate = (cb: (...a: unknown[]) => void, ...args: unknown[]) => {
    globalThis.queueMicrotask(() => { cb.apply(undefined, args); });
    return 0;
  };
}
afterEach(() => { (globalThis as { setImmediate: unknown }).setImmediate = nodeSetImmediate; });

async function firstSync(): Promise<{ messages?: number } | null> {
  await buildPhoneEngine();
  const user = `first-sync-${randomUUID().slice(0, 8)}@lane.test`;
  await seed(user);
  const mod = loadArtifact();
  const start = mod.startPhoneEngine as (d: unknown) => Promise<{ stop(): Promise<void> }>;
  let finished: { messages?: number } | null = null;
  live = await start({
    exec: sqlExecutor(),
    imap: { host: HOST, port: PORT, secure: false, auth: { user, pass: "fixture" } },
    address: user, machineName: "first-sync census", installId: `install-${randomUUID()}`, keks: { 1: "c".repeat(64) },
    logSink: (line: string) => {
      if (!line.includes('"first_sync_finished"')) return;
      finished = JSON.parse(line) as { messages?: number };
    },
  });
  for (let i = 0; i < 240 && finished === null; i += 1) await new Promise((r) => setTimeout(r, 250));
  return finished;
}

describe("the phone engine artifact against a real IMAP server", () => {
  it("finishes its first sync under node's setImmediate", async () => {
    const finished = await firstSync();
    expect(finished, "the first sync never finished: an IMAP answer was pushed and never read").not.toBeNull();
    expect(finished!.messages, "the first sync finished without the mailbox's letters").toBe(LETTERS);
  }, 120_000);

  it("finishes its first sync under React Native's setImmediate, a microtask", async () => {
    installReactNativeImmediate();
    const finished = await firstSync();
    expect(finished, "the first sync never finished: an IMAP answer was pushed and never read").not.toBeNull();
    expect(finished!.messages, "the first sync finished without the mailbox's letters").toBe(LETTERS);
  }, 120_000);
});
