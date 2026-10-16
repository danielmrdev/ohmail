import { describe, it, expect, afterEach, vi } from "vitest";
import net from "node:net";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { makeOwnedDb, type OwnedDb } from "../src/client.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * A pool whose sockets die with a write still buffered must answer as soon as the database is back.
 *
 * postgres.js@3.4.9's `closed()` clears its flush timer but keeps the handle and the bytes, so the
 * next handshake of that connection is appended behind stale bytes and never sent until the buffer
 * passes the buffer's flush size: every attempt until then dies at `connect_timeout` (30 s). Measured as the
 * worker's 97-100 s resume after a database kill (`apps/worker/test/shared-db-fault.pg.test.ts`).
 * The fake clock makes the phase the reading: time moves only while the driver waits on its own
 * timers, so the wait is counted in `connect_timeout` periods, never in scheduler luck.
 */

const PG_UP = await realPgAvailable();
/** Captured before any fake clock: the real macrotask the socket I/O needs between fake ticks. */
const realSetTimeout = globalThis.setTimeout;
const realNow = Date.now.bind(Date);
const realTurn = (ms = 2): Promise<void> => new Promise((r) => { realSetTimeout(r, ms); });

const OPENER_CODES = new Set([196608, 80877103, 80877104, 80877102]);

/** One proxied connection, as the server side of the wire saw it. */
interface Leg { clientBytes: number; serverBytes: number; firstPacketIsOpener: boolean | null; closed: boolean }

/** A pass-through in front of Postgres that records what each connection sent first. */
class WireProxy {
  private server: net.Server | null = null;
  private readonly live = new Set<net.Socket>();
  readonly legs: Leg[] = [];
  port = 0;

  /** With `secure`, the proxy answers an SSLRequest with `S` and terminates a real TLS leg. */
  constructor(private readonly target: number, private readonly secure: { key: Buffer; cert: Buffer } | null = null) {}

  async listen(port = 0): Promise<void> {
    const server = net.createServer((client) => {
      const leg: Leg = { clientBytes: 0, serverBytes: 0, firstPacketIsOpener: null, closed: false };
      this.legs.push(leg);
      const upstream = net.createConnection({ host: "127.0.0.1", port: this.target });
      this.live.add(client);
      this.live.add(upstream);
      const first = (d: Buffer): void => {
        leg.firstPacketIsOpener = d.length >= 8 && d.readInt32BE(0) <= 10_000
          && OPENER_CODES.has(d.readInt32BE(4));
      };
      const kill = (): void => {
        leg.closed = true;
        client.destroy(); upstream.destroy();
        this.live.delete(client); this.live.delete(upstream);
      };
      for (const s of [client, upstream]) { s.on("error", kill); s.on("close", kill); }
      upstream.on("data", (d: Buffer) => { leg.serverBytes += d.length; });
      if (!this.secure) {
        client.on("data", (d: Buffer) => { if (leg.clientBytes === 0) first(d); leg.clientBytes += d.length; });
        client.pipe(upstream);
        upstream.pipe(client);
        return;
      }
      const creds = this.secure;
      client.once("data", (d: Buffer) => {
        first(d);
        leg.clientBytes += d.length;
        if (leg.firstPacketIsOpener !== true || d.readInt32BE(4) !== 80_877_103) { kill(); return; }
        client.write("S");
        const leg2 = new tls.TLSSocket(client, { isServer: true, key: creds.key, cert: creds.cert });
        leg2.on("error", kill);
        leg2.on("data", (x: Buffer) => { leg.clientBytes += x.length; });
        leg2.pipe(upstream);
        upstream.pipe(leg2);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    const addr = server.address();
    this.port = typeof addr === "object" && addr !== null ? addr.port : port;
    this.server = server;
  }

  /** The database goes away: a FIN on every live socket, as a pooler falling over sends. */
  cut(): void {
    this.server?.close();
    this.server = null;
    for (const s of this.live) s.end();
    this.live.clear();
  }

  async restore(): Promise<void> {
    if (!this.server) await this.listen(this.port);
  }

  /** Nothing is waiting on the server: no live connection, or every live one has sent nothing. */
  driverOnlyWaitsOnItsTimers(): boolean {
    return this.legs.every((l) => l.closed || l.clientBytes === 0);
  }

  bytesSoFar(): number {
    return this.legs.reduce((n, l) => n + l.clientBytes, 0);
  }
}

function urlVia(port: number, query = ""): string {
  const u = new URL(PG_TEST_URL);
  u.hostname = "127.0.0.1";
  u.port = String(port);
  return u.toString() + query;
}

type Outcome = { ok: true } | { ok: false; code: string };

/**
 * Drive one promise to settlement. Each turn moves the fake clock 1 ms; it JUMPS to the driver's
 * next timer only after a quiet real interval in which the driver provably waits on nothing but
 * that timer, so a slow server answer is waited for in real time and never timed out by the harness.
 */
async function settle(p: Promise<unknown>, proxy: WireProxy, budgetMs: number, clock: { ms: number; jumps: number[] }): Promise<Outcome | null> {
  let out: Outcome | null = null;
  p.then(() => { out = { ok: true }; }, (e: unknown) => {
    out = { ok: false, code: String((e as { code?: unknown }).code ?? (e as Error).message) };
  });
  let quietSince = realNow();
  let seen = proxy.bytesSoFar();
  while (out === null && clock.ms < budgetMs) {
    // 1 ms, not 0: an immediate queued while a tick lets real I/O in is due at now + 1.
    await vi.advanceTimersByTimeAsync(1);
    clock.ms += 1;
    await realTurn();
    if (proxy.bytesSoFar() !== seen) { seen = proxy.bytesSoFar(); quietSince = realNow(); continue; }
    if (realNow() - quietSince < 25 || !proxy.driverOnlyWaitsOnItsTimers()) continue;
    const t0 = Date.now();
    await vi.advanceTimersToNextTimerAsync();
    clock.ms += Date.now() - t0;
    clock.jumps.push(Date.now() - t0);
    quietSince = realNow();
  }
  return out;
}

interface Reading { answeredAfterMs: number | null; deadHandshakes: number; notAnOpener: number; failures: string[]; jumps: number[]; legs: number }

/**
 * Open every pooled connection, optionally leave a statement BUFFERED on each (the fake immediate
 * the driver flushes through is never run before the cut), cut, restore, then ask until answered —
 * a failed ask is re-issued, as the worker's next cycle would.
 */
async function cutAndResume(query: string, buffered: boolean, secure: { key: Buffer; cert: Buffer } | null = null): Promise<Reading> {
  const proxy = new WireProxy(Number(new URL(PG_TEST_URL).port || 5432), secure);
  await proxy.listen();
  proxies.push(proxy);
  const owned: OwnedDb = makeOwnedDb(urlVia(proxy.port, query));
  pools.push(owned);
  const clock = { ms: 0, jumps: [] as number[] };
  const warm = await settle(Promise.all(Array.from({ length: 5 },
    () => owned.db.execute(sql`select pg_sleep(0.05)`))), proxy, 60_000, clock);
  expect(warm, "the pool never opened through the proxy").toEqual({ ok: true });
  expect(proxy.legs.filter((l) => !l.closed).length, "the five connections are not all open").toBe(5);

  if (buffered) {
    const sent = proxy.bytesSoFar();
    const inFlight = Array.from({ length: 5 }, () => owned.db.execute(sql`select 1`).catch(() => "rejected"));
    await realTurn(20);
    expect(proxy.bytesSoFar(), "a statement reached the wire before the cut").toBe(sent);
    proxy.cut();
    const deadline = realNow() + 10_000;
    let settled = 0;
    for (const q of inFlight) void q.then(() => { settled++; });
    while (settled < 5 && realNow() < deadline) await realTurn(5);
    expect(settled, "the buffered statements were not rejected by the cut").toBe(5);
  } else {
    proxy.cut();
    await realTurn(100);
  }
  const legsBefore = proxy.legs.length;
  await proxy.restore();

  const failures: string[] = [];
  clock.ms = 0;
  clock.jumps = [];
  let answeredAfterMs: number | null = null;
  while (clock.ms < BUDGET_MS) {
    const out = await settle(owned.db.execute(sql`select 1`), proxy, BUDGET_MS, clock);
    if (out === null) break;
    if (out.ok) { answeredAfterMs = clock.ms; break; }
    failures.push(`${out.code}@${clock.ms}`);
  }
  const after = proxy.legs.slice(legsBefore);
  return {
    answeredAfterMs,
    deadHandshakes: after.filter((l) => l.closed && l.clientBytes === 0).length,
    notAnOpener: after.filter((l) => l.firstPacketIsOpener === false).length,
    failures, jumps: clock.jumps, legs: after.length,
  };
}

/** Three connect_timeouts past the claim's minute: a red that names its phase. */
const BUDGET_MS = 150_000;
const proxies: WireProxy[] = [];
const pools: OwnedDb[] = [];

describe.skipIf(!PG_UP)("a pool cut with a write buffered answers once the database is back", () => {
  afterEach(async () => {
    for (const p of proxies.splice(0)) p.cut();
    for (const o of pools.splice(0)) {
      const closing = o.close().catch(() => undefined);
      await vi.runAllTimersAsync().catch(() => undefined);
      await closing;
    }
    vi.useRealTimers();
  }, 30_000);

  const arms: Array<[string, string]> = [["a plain URL", ""], ["sslmode=prefer (the SSLRequest opener)", "?sslmode=prefer"]];
  for (const [name, query] of arms) {
    it(`${name}: the first ask after the restore answers without waiting out a connect_timeout`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate", "Date"] });
      const r = await cutAndResume(query, true);
      expect(r, `the pool did not answer inside the budget: ${JSON.stringify(r)}`).toMatchObject({ answeredAfterMs: expect.any(Number) });
      expect(r.deadHandshakes, `handshakes that sent nothing and died at connect_timeout (${r.failures.join(",")})`).toBe(0);
      expect(r.notAnOpener, "a connection sent the server stale bytes as its first packet").toBe(0);
      expect(r.answeredAfterMs!, "the resume waited on a driver timer past one reconnect").toBeLessThan(1_000);
    }, 120_000);
  }

  /* A real TLS leg (sslmode=require) through the same socket: the driver's own `tls.connect` over
     it, then the SSLRequest wedge. The certificate is minted per run; no openssl is a refusal. */
  it("sslmode=require over a real TLS leg: the pool answers, and answers again after a cut with a write buffered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-wedge-tls-"));
    try {
      execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
        "-subj", "/CN=localhost", "-days", "1", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")], { stdio: "ignore" });
      const secure = { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) };
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate", "Date"] });
      const r = await cutAndResume("?sslmode=require", true, secure);
      expect(r, `the TLS pool did not answer inside the budget: ${JSON.stringify(r)}`).toMatchObject({ answeredAfterMs: expect.any(Number) });
      expect(r.deadHandshakes).toBe(0);
      expect(r.notAnOpener).toBe(0);
      expect(r.answeredAfterMs!).toBeLessThan(1_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  /* B beside A: the same cut with nothing buffered resumes at once on the unfixed driver too, so
     the arms above read the buffered write and not the harness. */
  it("the same cut with nothing buffered answers at once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate", "Date"] });
    const r = await cutAndResume("", false);
    expect(r.deadHandshakes).toBe(0);
    expect(r.answeredAfterMs, JSON.stringify(r)).not.toBeNull();
    expect(r.answeredAfterMs!).toBeLessThan(1_000);
  }, 120_000);
});
