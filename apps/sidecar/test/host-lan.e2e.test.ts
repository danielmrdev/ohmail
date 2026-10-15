import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, createServer } from "node:net";
import { once } from "node:events";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pemHeader } from "../../../test/support/fixture-credentials.js";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { createSidecar, type Sidecar } from "../src/engine.js";
import {
  maybeStartLanListener, resolveLanBind, startLanListener, type LanListener,
} from "../src/host-lan.js";
import {
  ensureLanIdentity, spkiFingerprint, LAN_KEY_FILE, type LanIdentity,
} from "../src/host-lan-tls.js";
import { createAdmission, HOST_MAX_CONCURRENT_REQUESTS } from "../src/host-listener.js";

import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

// Every test here stands up the real sidecar (createSidecar boots the engine's PGlite and
// runs its migrations) in the test body — see pglite-budget.ts for the measured cost.
vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ═══ THE LAN DOOR — the no-Tailscale second bind, and the decision it encodes ═══════════
 *
 * The LAN fallback ships API-ONLY, and this suite pins both halves of that ruling:
 *
 *  · **Opt-in, twice over.** The bind exists only when `OHMAIL_LAN_BIND` names an address AND
 *    host mode is armed — absent, the armed composition is byte-identical (no `handleLan`, no
 *    socket, no log line). Mutation watched red: a listener that binds without the knob accepts
 *    the loopback connect below (a null address on `listen()` is the wildcard bind).
 *  · **A chosen address, never the wildcard.** `resolveLanBind` accepts one bare IPv4 interface
 *    literal and refuses loopback (that is the host door's own bind), the unspecified address,
 *    names, ports and IPv6 — and `startLanListener` re-checks the kernel's answer at bind time.
 *    Census: one `listen()` call site, no `0.0.0.0` anywhere in the code.
 *  · **API-only.** The door serves `desktopHostRoutes` and an honest script-free explainer for
 *    everything else — NEVER the packaged browser client, even when the assets are right there.
 *    The reason is the secure-context audit (see `host-lan.ts`'s header): the served client
 *    depends on `[SecureContext]` APIs a plain-HTTP network origin does not provide, and the
 *    auth origin model refuses non-loopback http origins by design.
 *  · **The guard posture.** Native (app) requests carry no Origin and pass; anything
 *    browser-shaped mutating with the LAN's own plain-http origin — or any foreign origin — is
 *    refused as cross-site. That is the EXISTING guard judging honestly, not a widened one: the
 *    Tailscale door's config is untouched, proven by the side-by-side test at the bottom.
 */

const AT = new Date("2026-08-19T09:00:00.000Z");
const SERVED_ORIGIN = "https://machine.tail1234.ts.net";

const dirs: string[] = [];
const sidecars: Sidecar[] = [];
const listeners: LanListener[] = [];

afterEach(async () => {
  for (const l of listeners.splice(0)) await l.close();
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Line = [string, Record<string, unknown>];

async function standUp(opts: {
  hostMode?: boolean; hostOrigin?: string; hostPort?: number; lanBind?: string; hostAssetsDir?: string;
} = {}): Promise<{ sidecar: Sidecar; lines: Line[] }> {
  const dir = await freshDataDir("ohmail-host-lan-");
  dirs.push(dir);
  const lines: Line[] = [];
  const sidecar = await createSidecar({
    dataDir: dir,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "mila@example.test", pass: "app-password-9f3a" } },
    adapterFactory: () => ({ close: async () => undefined }) as unknown as MailboxAdapter,
    now: () => AT,
    log: (event, detail) => { lines.push([event, detail]); },
    ...(opts.hostMode !== undefined ? { hostMode: opts.hostMode } : {}),
    ...(opts.hostOrigin !== undefined ? { hostOrigin: opts.hostOrigin } : {}),
    ...(opts.hostPort !== undefined ? { hostPort: opts.hostPort } : {}),
    ...(opts.lanBind !== undefined ? { lanBind: opts.lanBind } : {}),
    ...(opts.hostAssetsDir !== undefined ? { hostAssetsDir: opts.hostAssetsDir } : {}),
  });
  sidecars.push(sidecar);
  return { sidecar, lines };
}

/** A packaged host-client stand-in — enough for the static handler to accept the directory. */
function fakeAssets(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-lan-assets-"));
  dirs.push(dir);
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><html><body>VITE-CLIENT-INDEX</body></html>");
  return dir;
}

/** One IPv4 address of a real non-internal interface, when this machine has one. */
function realLanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.internal || iface.family !== "IPv4") continue;
      if (iface.address.startsWith("169.254.")) continue;
      return iface.address;
    }
  }
  return null;
}

function connectRefused(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    sock.once("connect", () => { sock.destroy(); resolve(false); });
    sock.once("error", () => resolve(true));
  });
}

/**
 * A PORT THIS MACHINE'S LOOPBACK PROVABLY DOES NOT HOLD — reserved on 127.0.0.1, then released.
 *
 * The chosen-interface bind below asks whether the SAME port refuses on loopback. Taken from
 * `port: 0` that question is unanswerable: a loopback-only listener on P does not conflict with
 * a bind of <interface>:P, so the kernel hands P out and the door reads "answered" with no
 * defect anywhere (measured 2026-09-17: 19 loopback listeners sit in this host's ephemeral
 * range, and a parallel sidecar run opens more). Reserving on loopback first makes the port's
 * loopback half the test's own, so an answer there is the door and nothing else.
 */
async function portLoopbackDoesNotHold(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = probe.address();
  if (addr === null || typeof addr === "string") throw new Error("no port from the loopback probe");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return addr.port;
}

/**
 * ONE REAL REQUEST OVER THE WIRE, PINNED THE WAY A PHONE PINS.
 *
 * `rejectUnauthorized: false` here is not a shortcut past the check — it turns OFF the check this
 * door deliberately does not use (a chain to a certificate authority, which no self-signed key
 * has) and the caller then performs the check it DOES use: the presented key's SPKI fingerprint
 * must equal `expectFingerprint`. That is the same rule the phone applies natively, expressed in
 * the only place node lets a test express it, so a door that started serving a different key
 * fails HERE rather than silently passing.
 */
function wireRequest(host: string, port: number, path: string, init: {
  method?: string; headers?: Record<string, string>; body?: string; expectFingerprint?: string;
} = {}): Promise<{ status: number; headers: IncomingMessage["headers"]; body: string; peerFingerprint: string }> {
  return new Promise((resolve, reject) => {
    let peerFingerprint = "";
    const req = httpsRequest(
      {
        host, port, path,
        method: init.method ?? "GET",
        headers: init.headers ?? {},
        rejectUnauthorized: false,
        // The name in the certificate asserts nothing (`host-lan-tls.ts`), so name checking is
        // off for the same reason the phone's verifier has it off — the pin is the identity.
        servername: undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
          peerFingerprint,
        }));
      },
    );
    req.on("socket", (sock) => {
      sock.on("secureConnect", () => {
        const peer = (sock as import("node:tls").TLSSocket).getPeerX509Certificate();
        if (!peer) { req.destroy(new Error("no peer certificate")); return; }
        peerFingerprint = createHash("sha256")
          .update(peer.publicKey.export({ type: "spki", format: "der" }))
          .digest("base64url");
        // THE PIN, ENFORCED BEFORE A BYTE OF THE REQUEST IS TRUSTED. A mismatch destroys the
        // socket rather than reading the answer — which is what makes the negative test below a
        // real refusal and not an assertion made after the fact.
        if (init.expectFingerprint !== undefined && peerFingerprint !== init.expectFingerprint) {
          req.destroy(new Error(`pinned key mismatch: presented ${peerFingerprint}`));
        }
      });
    });
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/** A LAN identity for the direct-listener tests, in its own throwaway directory. */
function anIdentity(): LanIdentity {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-lan-id-"));
  dirs.push(dir);
  const out = ensureLanIdentity(dir);
  if (out.kind !== "identity") throw new Error(`no identity: ${out.refusal.reason}`);
  return out.identity;
}

/** Drive the LAN handler directly — the headless equivalent of a request on the LAN socket. */
async function lanFetch(sidecar: Sidecar, path: string, init: RequestInit = {}): Promise<Response> {
  return sidecar.handleLan!(new Request(`http://192.168.1.10:6245${path}`, init));
}

// ═════ resolveLanBind — one reading of the knob, IPv4-interface-literal or refused ═══════════

describe("resolveLanBind", () => {
  it("absent is silent: no address, no reason — the ordinary install says nothing", () => {
    expect(resolveLanBind({})).toEqual({ address: null, reason: null });
    expect(resolveLanBind({ hostMode: true })).toEqual({ address: null, reason: null });
    expect(resolveLanBind({ hostMode: true, lanBind: "   " })).toEqual({ address: null, reason: null });
  });

  it("set without host mode armed is a surfaced refusal, never a bind", () => {
    const out = resolveLanBind({ lanBind: "192.168.1.5" });
    expect(out.address).toBeNull();
    expect(out.reason).toContain("OHMAIL_LAN_BIND");
    expect(out.reason).toContain("host mode");
  });

  it("accepts one bare IPv4 interface literal", () => {
    expect(resolveLanBind({ hostMode: true, lanBind: "192.168.1.5" }))
      .toEqual({ address: "192.168.1.5", reason: null });
    expect(resolveLanBind({ hostMode: true, lanBind: " 10.0.0.7 " }))
      .toEqual({ address: "10.0.0.7", reason: null });
  });

  it("refuses everything that is not a chosen LAN interface — loopback, unspecified, names, ports, IPv6", () => {
    for (const bad of [
      "0.0.0.0",          // the wildcard — the exact thing the ruling forbids
      "0.1.2.3",          // 0.0.0.0/8 — never a routable interface
      "127.0.0.1",        // the host door's own bind, not a LAN interface
      "127.9.9.9",
      "::1",
      "fe80::1",
      "2a02:1234::1",     // v1 is IPv4-only, stated in the refusal
      "example.com",      // a name is not an interface literal
      "192.168.1.5:6245", // the port is OHMAIL_HOST_PORT's, not this knob's
      "http://192.168.1.5",
      "999.1.1.1",
      // The high reserved space: 224/4 multicast, 240/4 reserved, and 255.255.255.255 — the
      // limited-broadcast address, which some kernels bind exactly like the wildcard while the
      // kernel echo still matches. None of these is ever a unicast interface address.
      "224.0.0.1",
      "239.255.255.250",
      "240.0.0.1",
      "255.255.255.255",
    ]) {
      const out = resolveLanBind({ hostMode: true, lanBind: bad });
      expect(out.address, bad).toBeNull();
      expect(out.reason, bad).toContain("OHMAIL_LAN_BIND");
      // Fixed text — the reason never echoes the configured value.
      expect(out.reason, bad).not.toContain(bad);
    }
  });
});

// ═════ The bind census — one listen call, no wildcard, refused at runtime too ════════════════

describe("the LAN bind is the chosen address and NOTHING wider", () => {
  const SRC = readFileSync(
    join(fileURLToPath(new URL("../src/", import.meta.url)), "host-lan.ts"), "utf8");
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/.*$/gm, "");

  it("source census: exactly ONE listen() call site, and no 0.0.0.0 anywhere in the code", () => {
    const listens = code.match(/\.listen\(/g) ?? [];
    expect(listens, "exactly one listen call site").toHaveLength(1);
    expect(code).toMatch(/\.listen\(\s*opts\.port\s*,\s*opts\.address\s*,/);
    expect(code).not.toContain("0.0.0.0");
  });

  it("startLanListener refuses loopback, the unspecified address and the broadcast address at runtime", async () => {
    for (const bad of ["127.0.0.1", "0.0.0.0", "::", "255.255.255.255"]) {
      await expect(
        startLanListener({ handle: async () => new Response("ok"), address: bad, port: 0, identity: anIdentity() }),
      ).rejects.toThrow(/LAN/i);
    }
  });

  it("startLanListener refuses an address this machine's interfaces do not hold — by name, before any bind", async () => {
    // 192.0.2.1 is TEST-NET-1 (RFC 5737): documentation-only, never assigned to a real
    // interface. Without the membership check the kernel would refuse most such binds anyway
    // (EADDRNOTAVAIL) — but the special addresses a kernel treats as bindable-wide are exactly
    // the dangerous ones, so membership in the machine's own interface list is the rule, and
    // the refusal names it.
    await expect(
      startLanListener({ handle: async () => new Response("ok"), address: "192.0.2.1", port: 0, identity: anIdentity() }),
    ).rejects.toThrow(/interface/i);
  });

  const lanIp = realLanAddress();
  it.skipIf(lanIp === null)("binds the real chosen interface and re-checks the kernel's answer", async () => {
    const identity = anIdentity();
    const port = await portLoopbackDoesNotHold();
    const listener = await startLanListener({
      handle: async () => new Response("ok"), address: lanIp!, port, identity,
    });
    listeners.push(listener);
    expect(listener.port).toBe(port);
    const res = await wireRequest(lanIp!, listener.port, "/", { expectFingerprint: identity.fingerprint });
    expect(res.status).toBe(200);
    expect(res.peerFingerprint).toBe(identity.fingerprint);
    // The chosen-interface bind is NOT a loopback bind: the same port refuses on 127.0.0.1, and
    // the port was ours on loopback a moment ago, so an answer here is this door binding wide.
    expect(
      await connectRefused(listener.port),
      "this port answered on 127.0.0.1, and this test held it on loopback a moment earlier — the bind is wider than the chosen interface",
    ).toBe(true);
  });
});

// ═════ ONE admission budget for the whole process, however many doors are open ═══════════════

describe("the admission bound is shared across doors", () => {
  it("handlers in flight on one door refuse admission on the other — 16 is the PROCESS bound, not per-socket", async () => {
    // Two doors, one budget: without sharing, a client that can reach both addresses holds
    // 2 × 16 near-cap bodies and the one engine heap pays double the ruled bound.
    const admission = createAdmission();
    let release!: () => void;
    const gate = new Promise<Response>((r) => { release = () => r(new Response("ok")); });
    const doorA = admission.wrap(() => gate);
    const doorB = admission.wrap(async () => new Response("ok"));
    const held = Array.from({ length: HOST_MAX_CONCURRENT_REQUESTS }, () =>
      doorA(new Request("http://a.local/x")));
    const refused = await doorB(new Request("http://b.local/y"));
    expect(refused.status).toBe(503);
    const body = await refused.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("host_busy");
    release();
    await Promise.all(held);
    // Drained, the other door admits again.
    expect((await doorB(new Request("http://b.local/y"))).status).toBe(200);
  });
});

// ═════ Opt-in: LAN absent ⇒ no handler, no socket, no line — the armed boot is unchanged ═════

describe("LAN off ⇒ no LAN door at all (the default, mutation-watched)", () => {
  it("an armed sidecar without OHMAIL_LAN_BIND has no handleLan and mounts no LAN listener", async () => {
    const { sidecar, lines } = await standUp({ hostMode: true, hostOrigin: SERVED_ORIGIN, hostPort: 6245 });
    expect(sidecar.handleLan).toBeUndefined();
    expect(sidecar.lanState).toEqual({ address: null, reason: null });

    const port = 34871; // any port — nothing may bind it
    const mounted = await maybeStartLanListener(
      {
        hostState: { ...sidecar.hostState, port },
        lanState: sidecar.lanState,
        handleLan: sidecar.handleLan,
        lanIdentity: sidecar.lanIdentity,
      },
      (e, d) => lines.push([e, d]),
    );
    expect(mounted).toBeNull();
    // The wildcard mutation (a null address reaching listen()) would accept THIS connect.
    expect(await connectRefused(port)).toBe(true);
    expect(lines.map(([e]) => e)).not.toContain("host_lan_listening");
  });

  it("a garbage OHMAIL_LAN_BIND degrades the LAN half with a surfaced reason and leaves host mode armed", async () => {
    const { sidecar, lines } = await standUp({
      hostMode: true, hostOrigin: SERVED_ORIGIN, hostPort: 6245, lanBind: "not-an-address",
    });
    expect(sidecar.hostState.armed).toBe(true);
    expect(sidecar.handleHost).toBeDefined();
    expect(sidecar.handleLan).toBeUndefined();
    expect(sidecar.lanState.address).toBeNull();
    expect(String(sidecar.lanState.reason)).toContain("OHMAIL_LAN_BIND");
    expect(lines.some(([e]) => e === "host_lan_config_invalid")).toBe(true);
  });

  it("LAN configured but host mode not armed: no door of any kind", async () => {
    const { sidecar } = await standUp({ lanBind: "192.168.1.5", hostPort: 6245 });
    expect(sidecar.handleHost).toBeUndefined();
    expect(sidecar.handleLan).toBeUndefined();
    expect(sidecar.lanState.address).toBeNull();
    expect(String(sidecar.lanState.reason)).toContain("host mode");
  });
});

// ═════ The LAN door itself: API-only, guard posture, honest explainer ════════════════════════

describe("the LAN door is API-only with the existing guard posture", () => {
  it("serves /hello as desktop-host, cookie-free — the same composition, one more socket", async () => {
    const { sidecar } = await standUp({
      hostMode: true, hostOrigin: SERVED_ORIGIN, hostPort: 6245, lanBind: "192.168.1.10",
    });
    expect(sidecar.lanState).toEqual({ address: "192.168.1.10", reason: null });
    const res = await lanFetch(sidecar, "/hello");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    const hello = await res.json() as { flavor?: string; features?: { pairing?: boolean } };
    expect(hello.flavor).toBe("desktop-host");
    expect(hello.features?.pairing).toBe(true);
  });

  it("a mutation with NO Origin (the app shape) reaches the route; the LAN's own plain-http origin is refused as cross-site", async () => {
    const { sidecar } = await standUp({
      hostMode: true, hostOrigin: SERVED_ORIGIN, hostPort: 6245, lanBind: "192.168.1.10",
    });
    // No Origin: the request guard's native branch — the route itself judges the token.
    const app = await lanFetch(sidecar, "/pair/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "not-a-real-token" }),
    });
    expect(app.status).not.toBe(403);
    const appBody = await app.json() as { error?: { code?: string } };
    expect(appBody.error?.code).not.toBe("cross_site_denied");

    // A browser ON the LAN origin: plain http on a non-loopback host can never be allow-listed
    // (`normalizeOrigin` refuses it), so the guard refuses the mutation — which is the API-only
    // ruling made structural: no browser client is served here, and none could authenticate.
    for (const origin of ["http://192.168.1.10:6245", "https://evil.example"]) {
      const res = await lanFetch(sidecar, "/pair/redeem", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ token: "not-a-real-token" }),
      });
      expect(res.status, origin).toBe(403);
      const body = await res.json() as { error?: { code?: string } };
      expect(body.error?.code, origin).toBe("cross_site_denied");
    }
  });

  it("app routes answer the honest explainer — script-free, CSP'd, naming the key and Tailscale — NEVER the packaged client", async () => {
    const assets = fakeAssets();
    const { sidecar } = await standUp({
      hostMode: true, hostOrigin: SERVED_ORIGIN, hostPort: 6245,
      lanBind: "192.168.1.10", hostAssetsDir: assets,
    });
    for (const path of ["/", "/pair", "/inbox"]) {
      const res = await lanFetch(sidecar, path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toContain("text/html");
      expect(res.headers.get("content-security-policy"), path).toContain("script-src 'self'");
      const html = await res.text();
      expect(html, path).not.toContain("<script");
      expect(html, path).not.toContain("VITE-CLIENT-INDEX");
      // RE-POINTED, NOT WEAKENED. This used to require the word "HTTPS", because the page's
      // reason was "this connection is plain HTTP". The transport changed and that sentence
      // became the false one, so the assertion moved to what the page must say NOW: the reason
      // (this computer's own key, which the app checks at pairing) and the way out (Tailscale).
      // The retired sentence is refused outright below so it cannot come back by copy-paste.
      expect(html, path).toContain("key of its own");
      expect(html, path).toContain("Tailscale");
      expect(html.toLowerCase(), path).not.toContain("plain http");
    }
    // …while the TAILSCALE door of the very same process still serves the packaged client.
    const viaHost = await sidecar.handleHost!(new Request("http://127.0.0.1:6245/"));
    expect(await viaHost.text()).toContain("VITE-CLIENT-INDEX");

    // Asset paths are honestly absent rather than proxied to the packaged dist.
    const asset = await lanFetch(sidecar, "/assets/app-abcdef123456.js");
    expect(asset.status).toBe(404);
  });

  it("maybeStartLanListener skips with a named reason when armed without a port", async () => {
    const { sidecar } = await standUp({
      hostMode: true, hostOrigin: SERVED_ORIGIN, lanBind: "192.168.1.10",
    });
    const lines: Line[] = [];
    const mounted = await maybeStartLanListener(
      {
        hostState: sidecar.hostState,
        lanState: sidecar.lanState,
        handleLan: sidecar.handleLan,
        lanIdentity: sidecar.lanIdentity,
      },
      (e, d) => lines.push([e, d]),
    );
    expect(mounted).toBeNull();
    expect(lines.some(([e, d]) => e === "host_lan_skipped" && String(d.reason).includes("OHMAIL_HOST_PORT"))).toBe(true);
  });

  const lanIp = realLanAddress();
  it.skipIf(lanIp === null)("the production mount serves the real socket and says host_lan_listening", async () => {
    const { sidecar } = await standUp({
      hostMode: true, hostOrigin: SERVED_ORIGIN, hostPort: 6245, lanBind: lanIp!,
    });
    const lines: Line[] = [];
    const mounted = await maybeStartLanListener(
      {
        hostState: { ...sidecar.hostState, port: 0 },
        lanState: sidecar.lanState,
        handleLan: sidecar.handleLan,
        lanIdentity: sidecar.lanIdentity,
      },
      (e, d) => lines.push([e, d]),
    );
    expect(mounted).not.toBeNull();
    listeners.push(mounted!);
    // The line carries the PORT only — the chosen address identifies the operator's network,
    // which is exactly what the log census keeps off every line.
    expect(lines.some(([e, d]) => e === "host_lan_listening" && d.port === mounted!.port && !("address" in d))).toBe(true);
    const hello = await wireRequest(lanIp!, mounted!.port, "/hello", {
      expectFingerprint: sidecar.lanIdentity!.fingerprint,
    });
    expect(hello.status).toBe(200);
    expect(hello.headers["set-cookie"]).toBeUndefined();
    // The LAN bind is not a loopback bind.
    expect(await connectRefused(mounted!.port)).toBe(true);
  });
});

// ═════ THE TRANSPORT — TLS, pinned by the ceremony, with no cleartext left anywhere ══════════

/**
 * The defect these guards close: the door served plain HTTP and the only client it exists
 * for — a release build of the native app — refuses to open a cleartext socket at all. These are
 * the guards for the fix, and the FIRST of them is the original failure turned into the check:
 * a plain-HTTP request to this socket must not get an HTTP answer.
 */
describe("the LAN door serves TLS and nothing else", () => {
  const lanIp = realLanAddress();

  it.skipIf(lanIp === null)("a plain-HTTP request to the LAN door gets NO http answer — the cleartext door is gone", async () => {
    const identity = anIdentity();
    const listener = await startLanListener({
      handle: async () => new Response("ok"), address: lanIp!, port: 0, identity,
    });
    listeners.push(listener);
    // The socket accepts the connection (it is a listener), and then the TLS record layer
    // refuses the plaintext request line. What must NOT happen is a 200 with a body — which is
    // exactly what this same call returned before the fix, and what makes this a real negative.
    const spoken = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
      const req = httpRequest(
        { host: lanIp!, port: listener.port, path: "/hello", method: "GET" },
        (res) => resolve({ ok: true, detail: `answered ${res.statusCode}` }),
      );
      req.on("error", (e) => resolve({ ok: false, detail: String(e) }));
      req.end();
    });
    expect(spoken.ok, `plain HTTP was answered: ${spoken.detail}`).toBe(false);
    // …while the SAME port answers over TLS, so this is not a dead socket passing by accident.
    const overTls = await wireRequest(lanIp!, listener.port, "/hello", {
      expectFingerprint: identity.fingerprint,
    });
    expect(overTls.status).toBe(200);
  });

  it.skipIf(lanIp === null)("a WRONG pinned fingerprint refuses the connection — the pin is what is checked", async () => {
    const identity = anIdentity();
    const other = anIdentity();
    expect(other.fingerprint).not.toBe(identity.fingerprint);
    const listener = await startLanListener({
      handle: async () => new Response("ok"), address: lanIp!, port: 0, identity,
    });
    listeners.push(listener);
    // Same address, same port, same live door — only the expected key differs, and that alone
    // is the refusal. This is the phone's rule: not the chain, not the name, the KEY.
    await expect(
      wireRequest(lanIp!, listener.port, "/hello", { expectFingerprint: other.fingerprint }),
    ).rejects.toThrow(/pinned key mismatch/);
    // The right one still passes, so the refusal above is the pin and not a broken door.
    const ok = await wireRequest(lanIp!, listener.port, "/hello", {
      expectFingerprint: identity.fingerprint,
    });
    expect(ok.status).toBe(200);
  });

  it("the fingerprint the window publishes IS the key the door serves", async () => {
    // The pairing link is composed from `GET /local/lan/pin`; the socket is served from
    // `lanIdentity`. If those two could differ, a pairing would fail at the handshake with
    // nothing on either machine to point at — so they are one object, and this is the assertion
    // that says so out loud.
    const { sidecar } = await standUp({
      hostMode: true, hostOrigin: SERVED_ORIGIN, hostPort: 6245, lanBind: "192.168.1.10",
    });
    const res = await sidecar.handle(new Request("http://localhost/local/lan/pin", {
      headers: { authorization: `Bearer ${sidecar.sessionToken}` },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { fingerprint?: string | null };
    expect(typeof body.fingerprint).toBe("string");
    expect(body.fingerprint).toBe(sidecar.lanIdentity!.fingerprint);
    expect(body.fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url, no padding

    // …and it is the WINDOW's route, never the paired phone's — the same narrowness
    // `/local/lan/candidates` keeps, for the same reason. The host door has no such route, so
    // the path falls through to its static half: what must not come back is this JSON.
    const viaHost = await sidecar.handleHost!(new Request("http://127.0.0.1:6245/local/lan/pin"));
    expect(viaHost.headers.get("content-type") ?? "").not.toContain("application/json");
    expect(await viaHost.text()).not.toContain(body.fingerprint!);
  });

  it("with same-network access off there is no key and the window is told so plainly", async () => {
    const { sidecar } = await standUp({ hostMode: true, hostOrigin: SERVED_ORIGIN, hostPort: 6245 });
    expect(sidecar.lanIdentity).toBeNull();
    const res = await sidecar.handle(new Request("http://localhost/local/lan/pin", {
      headers: { authorization: `Bearer ${sidecar.sessionToken}` },
    }));
    expect(await res.json()).toEqual({ fingerprint: null });
  });

  it("the identity survives a restart, so paired devices stay paired", async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-lan-persist-"));
    dirs.push(dir);
    const first = ensureLanIdentity(dir);
    const second = ensureLanIdentity(dir);
    expect(first.kind).toBe("identity");
    expect(second.kind).toBe("identity");
    const a = (first as { identity: LanIdentity }).identity;
    const b = (second as { identity: LanIdentity }).identity;
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.key).toBe(a.key);
    // …and the fingerprint really is the KEY's, not the certificate's — which is what makes it
    // survive a re-issued certificate over the same key (the certificate IS re-issued above).
    expect(spkiFingerprint(createPublicKey(createPrivateKey(a.key)))).toBe(a.fingerprint);
  });

  it("an UNREADABLE key is refused, never re-keyed — a permission bit must not un-pair a household", () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-lan-locked-"));
    dirs.push(dir);
    const made = ensureLanIdentity(dir);
    const fingerprint = (made as { identity: LanIdentity }).identity.fingerprint;
    const keyPath = join(dir, LAN_KEY_FILE);
    const kept = readFileSync(keyPath, "utf8");
    // A file that exists and is not a key — the shape a truncated write leaves behind: this key, cut short.
    const truncated = kept.slice(0, Math.floor(kept.length / 2));
    expect(truncated.startsWith(pemHeader("PRIVATE KEY")), "the cut file still opens like a key").toBe(true);
    writeFileSync(keyPath, truncated);
    const lines: Line[] = [];
    const out = ensureLanIdentity(dir, (e, d) => lines.push([e, d]));
    expect(out.kind).toBe("refused");
    expect(lines.some(([e]) => e === "host_lan_identity_unreadable")).toBe(true);
    // THE POINT: the door is off, and the operator's own file is exactly as they left it. A
    // silent regeneration here would have been an un-pairing of every phone in the house.
    expect(readFileSync(keyPath, "utf8")).toBe(truncated);
    // Put the real key back and the same install is the same identity again.
    writeFileSync(keyPath, kept);
    expect((ensureLanIdentity(dir) as { identity: LanIdentity }).identity.fingerprint).toBe(fingerprint);
  });

  it("NO IDENTITY ⇒ NO SOCKET. The door never falls back to cleartext", async () => {
    const { sidecar } = await standUp({
      hostMode: true, hostOrigin: SERVED_ORIGIN, hostPort: 6245, lanBind: "192.168.1.10",
    });
    const port = 34873; // any port — nothing may bind it
    const lines: Line[] = [];
    const mounted = await maybeStartLanListener(
      {
        hostState: { ...sidecar.hostState, port },
        lanState: sidecar.lanState,
        handleLan: sidecar.handleLan,
        lanIdentity: null,
      },
      (e, d) => lines.push([e, d]),
    );
    expect(mounted).toBeNull();
    expect(await connectRefused(port)).toBe(true);
    expect(lines.some(([e, d]) => e === "host_lan_skipped" && String(d.reason).includes("no key"))).toBe(true);
    expect(lines.map(([e]) => e)).not.toContain("host_lan_listening");
  });

  it("source census: the LAN listener has no plain-http construction left in it", () => {
    const src = readFileSync(
      join(fileURLToPath(new URL("../src/", import.meta.url)), "host-lan.ts"), "utf8");
    const bare = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/.*$/gm, "");
    // ONE makeHttpServer call, and it carries the tls bag. A second call site — or this one
    // losing the bag — is how a cleartext door comes back, and neither compiles into a failure
    // anywhere else: the socket would bind and log exactly as it does now.
    expect((bare.match(/makeHttpServer\(/g) ?? [])).toHaveLength(1);
    expect(bare).toMatch(/tls:\s*\{\s*key:\s*opts\.identity\.key,\s*cert:\s*opts\.identity\.cert\s*\}/);
  });
});

// ═════ The connection bound on the REACHABLE door — anyone on the network can hold sockets ═══

describe("the LAN door bounds CONNECTIONS, not only requests", () => {
  const lanIp = realLanAddress();

  /** One raw socket, connected and SILENT — no TLS handshake, not one byte. */
  async function silentSocket(host: string, port: number): Promise<ReturnType<typeof connect>> {
    const sock = connect({ host, port });
    sock.on("error", () => { /* a refused socket ends here, not in the run */ });
    await once(sock, "connect");
    return sock;
  }

  function closedByServer(sock: ReturnType<typeof connect>, ms: number): Promise<boolean> {
    if (sock.destroyed || sock.readyState === "readOnly") return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      sock.once("close", () => { clearTimeout(timer); resolve(true); });
      sock.once("end", () => { clearTimeout(timer); resolve(true); });
    });
  }

  /**
   * THE REACHABLE HALF OF THAT CHANGE. This door is the one anybody on the
   * chosen network can dial, and a socket that never starts its TLS handshake reaches no
   * request, no handler and no cap — so before the bound one client could hold every socket the
   * kernel would give it, each for node's own two-minute handshake default.
   */
  it.skipIf(lanIp === null)("holds at most the bound, turns the next away at the accept, and COUNTS it", async () => {
    const lines: Line[] = [];
    const max = 8;
    const listener = await startLanListener({
      handle: async () => new Response("ok"),
      address: lanIp!,
      port: 0,
      identity: anIdentity(),
      log: (e, d) => lines.push([e, d]),
      maxConnections: max,
    });
    listeners.push(listener);

    const held = [];
    for (let i = 0; i < max; i++) held.push(await silentSocket(lanIp!, listener.port));
    expect(held.filter((s) => !s.destroyed && s.readyState === "open")).toHaveLength(max);

    const overflow = await silentSocket(lanIp!, listener.port);
    expect(await closedByServer(overflow, 3_000), "the socket past the bound was still held")
      .toBe(true);
    expect(overflow.bytesRead).toBe(0);

    const refusal = lines.find(([e]) => e === "host_conn_refused");
    expect(refusal, "a refused connection on the LAN door was not counted").toBeDefined();
    expect(refusal![1].count).toBe(1);
    // The chosen interface address identifies the operator's network — never on a line.
    expect(JSON.stringify(refusal![1])).not.toContain(lanIp!);

    for (const s of [...held, overflow]) s.destroy();
  });

  /**
   * The TLS door's own half: `headersTimeout` cannot reach a socket that has not finished
   * negotiating, so the handshake gets the same ceiling — node's default there is 120 s, which
   * is the hole a bounded door would still have had.
   */
  it.skipIf(lanIp === null)("a socket that never completes the handshake is cut off inside the header ceiling, and COUNTED", async () => {
    const lines: Line[] = [];
    const listener = await startLanListener({
      handle: async () => new Response("ok"),
      address: lanIp!,
      port: 0,
      identity: anIdentity(),
      log: (e, d) => lines.push([e, d]),
      headersTimeoutMs: 300,
      connectionsCheckingIntervalMs: 50,
    });
    listeners.push(listener);

    const sock = await silentSocket(lanIp!, listener.port);
    expect(await closedByServer(sock, 5_000), "a handshake-less socket outlived the ceiling")
      .toBe(true);
    const timedOut = lines.find(([e]) => e === "host_header_timeout");
    expect(timedOut, "a handshake timeout was not counted").toBeDefined();
    expect(timedOut![1].count).toBe(1);
    sock.destroy();
  });
});
