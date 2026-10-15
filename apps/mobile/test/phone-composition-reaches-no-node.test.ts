/**
 * THE PHONE'S COMPOSITION REACHES NO NODE-ONLY MODULE WHILE IT IS BUILT — over the ARTIFACT.
 *
 * `createSidecar` constructs every door on every composition, and a door that called `path.join`
 * at construction stopped every standalone phone at connect ("path.join() is not available in this
 * app") while each desktop suite stayed green. The shim throws on CALL, so a caller that swallows
 * the throw hides it; this census reads the shim's own record instead, from the first call until
 * the door is handed back, on the form's start and on the sealed relaunch. The planted cases prove
 * the record sees a construction-time reach through the same bundler, interop and shim.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BUNDLE, buildPhoneEngine, bundleProbe } from "../scripts/bundle-engine.mjs";
import { openStandaloneMailbox, reopenStandaloneMailbox } from "../src/engine/standalone-door";
import { EMPTY_STANDALONE } from "../src/ui/standalone-form";

const require_ = createRequire(import.meta.url);
const sqlite = require_("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void; close(): void;
    prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown; columns?(): { column?: string | null; name?: string }[] };
  };
};

const REACHED = Symbol.for("ohmail.node-absent.reached");
const G = globalThis as unknown as Record<symbol, string[] | undefined>;

function loadArtifact(path: string): Record<string, unknown> {
  const Module = require_("node:module") as { _load(r: string, p: unknown, m: boolean): unknown };
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
    delete (require_ as unknown as { cache?: Record<string, unknown> }).cache?.[path];
    return require_(path) as Record<string, unknown>;
  } finally { Module._load = original; }
}

/** `node:sqlite` on a FILE behind the statement-runner contract, so a relaunch opens the same store. */
function sqlExecutor(file: string): Record<string, unknown> {
  const raw = new sqlite.DatabaseSync(file);
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T,>(job: () => Promise<T> | T): Promise<T> => {
    const next = tail.then(job, job); tail = next.catch(() => undefined); return next;
  };
  const yielded = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return {
    all: (sql: string, params: readonly unknown[]) => serial(async () => {
      await yielded();
      const st = raw.prepare(sql);
      const columns = (st.columns?.() ?? []).map((c) => c.name ?? c.column ?? "");
      const objects = st.all(...(params as unknown[])) as Record<string, unknown>[];
      return { columns, rows: columns.length > 0 ? objects.map((o) => columns.map((c) => o[c])) : objects.map((o) => Object.values(o)) };
    }),
    run: (sql: string, params: readonly unknown[]) => serial(async () => { await yielded(); raw.prepare(sql).run(...(params as unknown[])); }),
    batch: (sts: readonly { sql: string; params?: readonly unknown[] }[]) => serial(async () => {
      await yielded(); raw.exec("BEGIN IMMEDIATE");
      try { for (const { sql, params = [] } of sts) raw.prepare(sql).run(...(params as unknown[])); raw.exec("COMMIT"); }
      catch (e) { try { raw.exec("ROLLBACK"); } catch { /* keep the first error */ } throw e; }
    }),
    close: async () => { try { raw.close(); } catch { /* already closed */ } },
  };
}

/** A loopback IMAP server that logs anybody in and holds an empty INBOX. */
function acceptingImap(): Promise<{ port: number; close(): Promise<void> }> {
  const live = new Set<Socket>();
  const srv = createServer((sock) => {
    live.add(sock);
    sock.on("error", () => undefined);
    sock.on("close", () => live.delete(sock));
    const write = (s: string): void => { if (!sock.destroyed) sock.write(s); };
    let buf = "";
    sock.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [tag, cmd, ...args] = line.split(" ");
        const c = (cmd ?? "").toUpperCase();
        if (c === "CAPABILITY") write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
        else if (c === "LOGIN") write(`${tag} OK logged in\r\n`);
        else if (c === "LIST" && args.join(" ") === `"" ""`) write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK done\r\n`);
        else if (c === "LIST") write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK done\r\n`);
        else if (c === "LOGOUT") write(`* BYE\r\n${tag} OK\r\n`);
        else write(`${tag} OK done\r\n`);
      }
    });
    write("* OK fake imap ready\r\n");
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({
      port: (srv.address() as { port: number }).port,
      close: () => new Promise<void>((res) => { for (const s of live) s.destroy(); srv.close(() => res()); }),
    }));
  });
}

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  delete G[REACHED];
  for (const c of closers.splice(0).reverse()) await c();
});

/** What the shim recorded while `run` ran — and only then. */
async function reachedDuring<T>(run: () => Promise<T>): Promise<{ value: T; reached: string[] }> {
  const reached: string[] = [];
  G[REACHED] = reached;
  try { return { value: await run(), reached: [...reached] }; } finally { delete G[REACHED]; }
}

type Door = { handle(r: Request): Promise<Response>; sessionToken: string; stop(): Promise<void> };

describe("the phone's composition, over the artifact", () => {
  it("reaches no node-only module on the form's start or on the sealed relaunch", async () => {
    await buildPhoneEngine();
    const mod = loadArtifact(BUNDLE);
    const imap = await acceptingImap();
    closers.push(imap.close);
    const dir = mkdtempSync(join(tmpdir(), "ohmail-phone-reach-"));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "engine.db");
    const app = {
      platform: async () => ({ kind: "ready" as const, exec: sqlExecutor(file) as never, keks: { 1: "a".repeat(64) } }),
      machineName: () => "ohmail on a phone",
      installId: async () => "reach-census",
    };

    const first = await reachedDuring(() => openStandaloneMailbox(
      { ...EMPTY_STANDALONE, address: "someone@example.test", password: "any", imapHost: "127.0.0.1",
        imapPort: String(imap.port), imapTls: false },
      { ...app, startEngine: mod.startPhoneEngine as never },
    ));
    expect(first.reached, "the form's start called no node-only member").toEqual([]);
    expect(first.value.ok, "the form's start opened the mailbox").toBe(true);
    if (!first.value.ok) return;
    const door = first.value.door as unknown as Door;
    const hello = await door.handle(new Request("http://sidecar/hello", { headers: { authorization: `Bearer ${door.sessionToken}` } }));
    expect(hello.status, "the door it handed back answers").toBe(200);
    // The window outbox is the desktop window's door; the phone's outbox lives in its own store.
    const outbox = await reachedDuring(() => door.handle(new Request("http://sidecar/local/window/outbox?scope=mb-1", {
      headers: { authorization: `Bearer ${door.sessionToken}` },
    })));
    expect(outbox.value.status, "the phone serves no window outbox").toBe(404);
    expect(outbox.reached).toEqual([]);
    await door.stop();

    const again = await reachedDuring(() => reopenStandaloneMailbox(
      { ...app, startFromSealed: mod.startPhoneEngineFromSealed as never },
    ));
    expect(again.reached, "the sealed relaunch called no node-only member").toEqual([]);
    expect(again.value.ok, "the sealed relaunch opened the mailbox").toBe(true);
    if (again.value.ok) closers.push(() => (again.value as { door: Door }).door.stop().catch(() => undefined));
  }, 90_000);
});

describe("the record sees a construction-time reach (planted)", () => {
  it("PLANTED: a module that joins a path when it is built is recorded, by module and member", async () => {
    const probe = await bundleProbe(
      `import { join } from "node:path";\n` +
      `export function plantedDoor(dir: string) { const file = join(dir, "x.json"); return { file }; }\n`,
    );
    closers.push(() => rmSync(probe.dir, { recursive: true, force: true }));
    const planted = loadArtifact(probe.bundlePath) as { plantedDoor(d: string): unknown };
    const { reached } = await reachedDuring(async () => { try { planted.plantedDoor("d"); } catch { /* swallowed, as a caller might */ } });
    expect(reached).toEqual(["path.join"]);
  });

  it("the window outbox, built under the phone's substitutions, reaches `path` at first use and not before", async () => {
    const probe = await bundleProbe(
      `export { createWindowOutbox } from "${join(__dirname, "..", "..", "sidecar", "src", "window-outbox.ts")}";\n`,
    );
    closers.push(() => rmSync(probe.dir, { recursive: true, force: true }));
    const { createWindowOutbox } = loadArtifact(probe.bundlePath) as {
      createWindowOutbox(d: Record<string, unknown>): { handle(r: Request): Promise<Response> };
    };
    const built = await reachedDuring(async () => createWindowOutbox({
      dataDir: "d", owner: { address: "me@example.test", base: "https://cloud.test" },
      authorized: async () => true, scope: () => "mb-1", log: () => undefined,
    }));
    expect(built.reached, "construction called no node-only member").toEqual([]);
    const used = await reachedDuring(async () => {
      try { await built.value.handle(new Request("http://sidecar/local/window/outbox?scope=mb-1")); } catch { /* the refusal */ }
    });
    expect(used.reached, "the first read is where the file's path is made").toContain("path.join");
  });
});
