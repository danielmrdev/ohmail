import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { HOST_CLIENT_CSP } from "../src/host-static.js";
import {
  HOST_LOOPBACK_ADDRESS, maybeStartHostListener, type HostListener,
} from "../src/host-listener.js";

import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

// Every test here stands up the real sidecar (createSidecar boots the engine's PGlite and
// runs its migrations) in the test body — see pglite-budget.ts for the measured cost.
vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ═══ THE SERVED BROWSER CLIENT — the static half of the host door, over real sockets ═════════
 *
 * The host door serves two things through ONE `handleHost`: the API (the desktop-host route
 * table, which wins) and the built host-client bundle (everything else). The static half is what
 * turns "an API a phone could call" into "a mail client a phone opens", and every property here
 * is one whose silent loss would be an exposure or a broken pairing:
 *
 *  · **API precedence is structural** — `matchRoute` over the same table the app routes with, so
 *    a JSON route can never be shadowed by a file and the fallback can never swallow a redeem.
 *  · **Traversal defense is the resolve-and-prefix check**, mutation-watched: with the prefix
 *    check removed, the `..%2F` vector below serves a file from OUTSIDE the assets root, red.
 *  · **The credential page carries the CSP.** `/pair` reads a device-pair token out of
 *    `location.hash`; the mitigation that matters is refusing injected inline script, and the
 *    vite artifact has NO inline script — so the policy is `script-src 'self'` flat, which is
 *    strictly stronger than the flow-1/3 nonce idiom (a nonce authorises one inline block; this
 *    authorises none). The handler stamps it on every HTML answer, `/` and `/pair` alike.
 *  · **Hashed assets are immutable, the shell HTML is not** — a phone that cached `index.html`
 *    across a desktop update would reference assets the new dist no longer carries.
 *  · **Assets absent is a degraded door, never a crash**: the API keeps answering and app routes
 *    get one plain sentence.
 */

const AT = new Date("2026-08-18T09:00:00.000Z");
const SERVED_ORIGIN = "https://machine.tail1234.ts.net";

/** A hashed name in vite's own shape, so the cache rule is tested against the real artifact's. */
const HASHED_JS = "index-DfK9q2Lx.js";
const HASHED_CSS = "index-B3nT7wQa.css";

const dirs: string[] = [];
const sidecars: Sidecar[] = [];
const listeners: HostListener[] = [];

afterEach(async () => {
  for (const l of listeners.splice(0)) await l.close();
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A fake host-client dist plus a SECRET file OUTSIDE it — the thing every traversal vector below
 * tries to read. The secret sits in the parent directory, exactly one `..` away, so a defense
 * that normalises but does not prefix-check serves it.
 */
function fakeDist(): { assetsDir: string; secret: string } {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-host-static-"));
  dirs.push(root);
  const assetsDir = join(root, "host-client");
  mkdirSync(join(assetsDir, "assets"), { recursive: true });
  writeFileSync(
    join(assetsDir, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>ohmail</title>` +
      `<script type="module" crossorigin src="/assets/${HASHED_JS}"></script>` +
      `<link rel="stylesheet" crossorigin href="/assets/${HASHED_CSS}"></head>` +
      `<body><div id="root"></div></body></html>`,
  );
  writeFileSync(join(assetsDir, "assets", HASHED_JS), 'console.log("host client");');
  writeFileSync(join(assetsDir, "assets", HASHED_CSS), ":root{--ok:1}");
  const secret = "SEALED-MAILBOX-PASSWORD-DO-NOT-SERVE";
  writeFileSync(join(root, "secret.txt"), secret);
  return { assetsDir, secret };
}

async function standUp(opts: { assetsDir?: string } = {}): Promise<{ sidecar: Sidecar; port: number }> {
  const dir = await freshDataDir("ohmail-host-static-data-");
  dirs.push(dir);
  const sidecar = await createSidecar({
    dataDir: dir,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "mila@example.test", pass: "app-password-9f3a" } },
    adapterFactory: () => ({ close: async () => undefined }) as unknown as MailboxAdapter,
    now: () => AT,
    log: () => undefined,
    hostMode: true,
    hostOrigin: SERVED_ORIGIN,
    hostPort: 1,   // any valid value — the listener below binds port 0 and reads the real one
    ...(opts.assetsDir !== undefined ? { hostAssetsDir: opts.assetsDir } : {}),
  });
  sidecars.push(sidecar);
  // Bind on an ephemeral port through the SAME startHostListener production takes; the state's
  // configured port is irrelevant to what this suite proves, so drive the listener directly.
  const { startHostListener } = await import("../src/host-listener.js");
  const listener = await startHostListener({ handle: (req) => sidecar.handleHost!(req), port: 0 });
  listeners.push(listener);
  return { sidecar, port: listener.port };
}

/** One raw HTTP exchange — RAW, so encoded traversal bytes reach the server unnormalised. */
function raw(port: number, path: string, init: {
  method?: string; headers?: Record<string, string>; body?: string;
} = {}): Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: HOST_LOOPBACK_ADDRESS, port, path, method: init.method ?? "GET", headers: init.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

const json = (body: unknown): { body: string; headers: Record<string, string> } => ({
  body: JSON.stringify(body), headers: { "content-type": "application/json" },
});

describe("the shell HTML and the credential page", () => {
  it("GET / answers the built index with the CSP, nosniff and no-store", async () => {
    const { assetsDir } = fakeDist();
    const { port } = await standUp({ assetsDir });
    const res = await raw(port, "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["content-security-policy"]).toBe(HOST_CLIENT_CSP);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toContain(`/assets/${HASHED_JS}`);
  });

  it("GET /pair is the SAME document under the SAME policy — the index fallback serving the fragment landing", async () => {
    const { assetsDir } = fakeDist();
    const { port } = await standUp({ assetsDir });
    const res = await raw(port, "/pair");
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toBe(HOST_CLIENT_CSP);
    expect(res.body).toContain('<div id="root">');
    // The policy this page's credential depends on: NO inline script may run. `script-src 'self'`
    // with no nonce and no unsafe-inline is that, spelled — a regression to either is red here.
    expect(HOST_CLIENT_CSP).toContain("script-src 'self';");
    // `unsafe-inline` may appear in style-src ALONE (React writes style attributes; inline style
    // is not a code-execution primitive) — stripped, the word "unsafe" must survive nowhere.
    expect(HOST_CLIENT_CSP.replace(/style-src [^;]*/, "")).not.toContain("unsafe");
    expect(HOST_CLIENT_CSP).not.toContain("nonce");
    expect(HOST_CLIENT_CSP).toContain("frame-ancestors 'none'");
    // …and the served document itself carries no inline script for an injection to hide behind.
    expect(res.body).not.toMatch(/<script(?![^>]*\bsrc=)/i);
  });

  it("a deep app route falls back to the index; a MISSING FILE (extension) is a 404, not the shell", async () => {
    const { assetsDir } = fakeDist();
    const { port } = await standUp({ assetsDir });
    expect((await raw(port, "/settings/devices")).status).toBe(200);
    const missing = await raw(port, "/assets/gone-Zz9.js");
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).error.code).toBe("not_found");
  });
});

describe("caching follows the artifact's own shape", () => {
  it("a hashed asset is immutable for a year; correct content types on both kinds", async () => {
    const { assetsDir } = fakeDist();
    const { port } = await standUp({ assetsDir });
    const js = await raw(port, `/assets/${HASHED_JS}`);
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toContain("text/javascript");
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    const css = await raw(port, `/assets/${HASHED_CSS}`);
    expect(css.headers["content-type"]).toContain("text/css");
    expect(css.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("HEAD answers the same headers and no body", async () => {
    const { assetsDir } = fakeDist();
    const { port } = await standUp({ assetsDir });
    const head = await raw(port, `/assets/${HASHED_JS}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(head.body).toBe("");
  });
});

describe("traversal defense — the resolve-and-prefix check, against a real secret one level up", () => {
  const VECTORS = [
    "/../secret.txt",                       // plain
    "/assets/../../secret.txt",             // through a real subdirectory
    "/..%2Fsecret.txt",                     // encoded separator
    "/assets/%2e%2e/%2e%2e/secret.txt",     // encoded dots
    "/%2e%2e%2fsecret.txt",                 // fully encoded
    "/..\\secret.txt",                      // backslash (Windows separator semantics)
    "/assets/..%5C..%5Csecret.txt",         // encoded backslash
  ];

  it("every vector is refused, and the secret's bytes appear in no answer", async () => {
    const { assetsDir, secret } = fakeDist();
    const { port } = await standUp({ assetsDir });
    for (const vector of VECTORS) {
      const res = await raw(port, vector);
      expect(res.body, vector).not.toContain(secret);
      // Refused as not-found or as a bad request — never 200. (node's own HTTP parser may
      // reject the rawest forms before the handler; both refusals are correct.)
      expect(res.status, vector).toBeGreaterThanOrEqual(400);
    }
  });

  it("an encoded traversal under a VALID prefix cannot dress as a hashed asset either", async () => {
    const { assetsDir, secret } = fakeDist();
    const { port } = await standUp({ assetsDir });
    const res = await raw(port, `/assets/..%2f..%2fsecret.txt`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain(secret);
    expect(res.headers["cache-control"]).not.toBe("public, max-age=31536000, immutable");
  });

  it("a SYMLINK inside the assets dir cannot reach outside it — the boundary is canonical, not lexical", async () => {
    // The review finding: `resolve()` proves the LEXICAL path is below the root, and `readFile`
    // then follows symlinks — so a link planted at assets/leak.txt → ../../secret.txt passed the
    // prefix check and served the secret. The boundary has to hold on the CANONICAL path.
    const { assetsDir, secret } = fakeDist();
    symlinkSync(join(assetsDir, "..", "secret.txt"), join(assetsDir, "assets", "leak-Ab12Cd34.txt"));
    const { port } = await standUp({ assetsDir });
    const res = await raw(port, "/assets/leak-Ab12Cd34.txt");
    expect(res.status).toBe(404);
    expect(res.body).not.toContain(secret);
    // …while a symlink that stays INSIDE the root keeps working — macOS puts the whole tmpdir
    // behind /private, so the root itself is canonicalized too, or every legitimate file 404s.
    expect((await raw(port, `/assets/${HASHED_JS}`)).status).toBe(200);
  });
});

describe("the CSP covers every renderable document, not only the index", () => {
  it("a planted .svg and .html under assets carry the policy — an SVG navigated to directly can execute script", async () => {
    const { assetsDir } = fakeDist();
    writeFileSync(
      join(assetsDir, "assets", "logo-Ab12Cd34.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg"><script>fetch('/steal')</script></svg>`,
    );
    writeFileSync(join(assetsDir, "assets", "page-Ab12Cd34.html"), "<script>1</script>");
    const { port } = await standUp({ assetsDir });
    const svg = await raw(port, "/assets/logo-Ab12Cd34.svg");
    expect(svg.status).toBe(200);
    expect(svg.headers["content-security-policy"]).toBe(HOST_CLIENT_CSP);
    const html = await raw(port, "/assets/page-Ab12Cd34.html");
    expect(html.headers["content-security-policy"]).toBe(HOST_CLIENT_CSP);
    // …and the ordinary JS asset carries it too — the header is inert there and a branch that
    // decides "renderable or not" is a branch that can be wrong. One policy, every answer.
    const js = await raw(port, `/assets/${HASHED_JS}`);
    expect(js.headers["content-security-policy"]).toBe(HOST_CLIENT_CSP);
  });
});

describe("API paths take precedence — the door's routes win over every file", () => {
  it("GET /hello is the door's JSON, not the index fallback; POST /pair/redeem still redeems", async () => {
    const { assetsDir } = fakeDist();
    const { sidecar, port } = await standUp({ assetsDir });
    const hello = await raw(port, "/hello");
    expect(hello.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(hello.body).flavor).toBe("desktop-host");

    // A wrong-method API path is the API's 405, never a static 404 and never the shell.
    const wrongMethod = await raw(port, "/pair/redeem");
    expect(wrongMethod.status).toBe(405);

    // A write to a non-API path is refused without entering the filesystem.
    const strayWrite = await raw(port, "/assets/x.js", { method: "POST", ...json({}) });
    expect(strayWrite.status).toBe(404);
    expect(JSON.parse(strayWrite.body).error.code).toBe("not_found");

    void sidecar;
  });
});

describe("assets absent — the door degrades to API-only with a sentence, never a crash", () => {
  it("app routes answer one plain page, assets 404, and the API is untouched", async () => {
    const { port } = await standUp();       // no hostAssetsDir
    const root = await raw(port, "/");
    expect(root.status).toBe(200);
    expect(root.headers["content-type"]).toContain("text/html");
    expect(root.headers["content-security-policy"]).toBe(HOST_CLIENT_CSP);
    expect(root.body).toContain("serving its API only");
    expect(root.body).not.toMatch(/<script/i);
    expect((await raw(port, "/pair")).status).toBe(200);
    expect((await raw(port, `/assets/${HASHED_JS}`)).status).toBe(404);
    expect(JSON.parse((await raw(port, "/hello")).body).flavor).toBe("desktop-host");
  });

  it("a CONFIGURED directory with no index.html degrades the same way", async () => {
    const empty = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-host-static-empty-"));
    dirs.push(empty);
    const { port } = await standUp({ assetsDir: empty });
    const root = await raw(port, "/");
    expect(root.status).toBe(200);
    expect(root.body).toContain("serving its API only");
  });
});

describe("THE END-TO-END RUN — serve dist → pair via fragment → bearer /sync → refresh → revoke", () => {
  it("walks the whole phone journey over one socket", async () => {
    const { assetsDir } = fakeDist();
    const { sidecar, port } = await standUp({ assetsDir });

    // 1 · the window mints a pairing token on the STDIO door (the QR's fragment half).
    const mintRes = await sidecar.handle(new Request("http://sidecar/pair", {
      method: "POST",
      headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ grant: "device-pair", label: "Pixel in the kitchen" }),
    }));
    expect(mintRes.status).toBe(200);
    const { token } = await mintRes.json() as { token: string };

    // 2 · the phone opens https://<magicdns>/pair#<token>. The fragment NEVER reaches the wire —
    //     what the server sees is exactly `GET /pair`, and it answers the client under the CSP.
    const landing = await raw(port, "/pair");
    expect(landing.status).toBe(200);
    expect(landing.headers["content-security-policy"]).toBe(HOST_CLIENT_CSP);

    // 3 · the page redeems: kind "web", from the served origin, exactly as a phone browser would.
    const redeemed = await raw(port, "/pair/redeem", {
      method: "POST",
      headers: { "content-type": "application/json", origin: SERVED_ORIGIN },
      body: JSON.stringify({ grant: "device-pair", token, kind: "web" }),
    });
    expect(redeemed.status).toBe(200);
    expect(redeemed.headers["set-cookie"]).toBeUndefined();
    const first = (JSON.parse(redeemed.body) as { tokens: { accessToken: string; refreshToken: string } }).tokens;

    // 4 · the bearer works: /sync round-trips on the same socket.
    const sync = await raw(port, "/sync", { headers: { authorization: `Bearer ${first.accessToken}` } });
    expect(sync.status).toBe(200);

    // 5 · rotation: /auth/refresh (body token — the door is bearer-only) answers a NEW pair…
    const refreshed = await raw(port, "/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json", origin: SERVED_ORIGIN },
      body: JSON.stringify({ refreshToken: first.refreshToken }),
    });
    expect(refreshed.status).toBe(200);
    const second = (JSON.parse(refreshed.body) as { tokens: { accessToken: string; refreshToken: string } }).tokens;
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect((await raw(port, "/sync", { headers: { authorization: `Bearer ${second.accessToken}` } })).status).toBe(200);

    // 6 · the WINDOW revokes the device over its own door, and the phone's next request is 401 —
    //     the take-back that makes handing a credential across a room safe to offer at all.
    const devicesRes = await sidecar.handle(new Request("http://sidecar/devices", {
      headers: { authorization: `Bearer ${sidecar.sessionToken}` },
    }));
    const devices = (await devicesRes.json() as { devices?: Array<{ id: string; kind: string }>; items?: Array<{ id: string; kind: string }> });
    const list = devices.devices ?? devices.items ?? [];
    const phone = list.find((d) => d.kind === "web");
    expect(phone, "the paired phone appears in the window's device list").toBeDefined();
    const revoke = await sidecar.handle(new Request(`http://sidecar/devices/${phone!.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${sidecar.sessionToken}` },
    }));
    expect(revoke.status).toBe(204);

    const after = await raw(port, "/sync", { headers: { authorization: `Bearer ${second.accessToken}` } });
    expect(after.status).toBe(401);
    // …and the dead session cannot refresh its way back in.
    const deadRefresh = await raw(port, "/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json", origin: SERVED_ORIGIN },
      body: JSON.stringify({ refreshToken: second.refreshToken }),
    });
    expect(deadRefresh.status).toBe(401);
  });
});
