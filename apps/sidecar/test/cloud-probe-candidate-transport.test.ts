import { createServer as createHttpServer, type Server } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";

/**
 * `POST /cloud/probe` WITH A CANDIDATE — WHICH TRANSPORT DIALS IT.
 *
 * ── THE ROW ───────────────────────────────────────────────────────────────────────────────────
 *
 * The candidate arms of this route dialled through `config.fetchImpl`, which on a paired-desktop
 * door is not a test seam at all: `createCloudSidecar` composes ONE pinned transport for the
 * configured host and puts it there, so every candidate probe went out through the transport
 * belonging to the door the person is trying to LEAVE.
 *
 * The reachable shape is the ordinary one: somebody paired with a computer of their own, that
 * computer is off or gone, and they open the middle door to move to a server they run instead.
 * The pinned transport refuses before it dials anything — it cannot establish the other machine's
 * identity — so a self-hosted server that is up and answering was reported with a sentence about
 * a computer that has nothing to do with the address they typed, telling them to go and check
 * that it is switched on.
 *
 * ── AND THE OTHER HALF, WHICH IS WHY THIS IS A PAIR AND NOT ONE CASE ──────────────────────────
 *
 * The NO-CANDIDATE arm asks about the door this engine IS configured for, and that question has
 * to go through that door's own transport — pin included. A fix that simply stopped reading
 * `config.fetchImpl` would answer it over an unpinned connection, which is the opposite mistake
 * and a worse one. Both arms are asserted here so neither can be traded for the other.
 */

const dirs: string[] = [];
const servers: Server[] = [];
let engine: CloudSidecar;

const tmp = (): string => {
  const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-probe-candidate-"));
  dirs.push(d);
  return d;
};

/**
 * A SELF-HOST STACK'S SHAPE, over loopback http — which `normalizeOrigin` admits and which the
 * compose stack itself serves in its CI configuration. Cleartext rather than TLS on purpose: this
 * file is about WHICH TRANSPORT dials, and a self-signed listener would fail for a second reason
 * and hide the one under test.
 */
async function selfHostStack(): Promise<number> {
  const server = createHttpServer((req, res) => {
    /* `/api/hello`, and 404 at the root — a self-host box's Caddy hands the root to the web app,
       which is the whole reason `probeCloudDoor` tries both. */
    if (req.url === "/api/hello") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ product: "ohmail", flavor: "selfhost", needsSetup: false, auth: {} }));
      return;
    }
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<html>not the api</html>");
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

/**
 * A PORT NOTHING IS LISTENING ON — the paired computer that is off. Taken by binding and closing,
 * so it is a port this machine is not using rather than a number somebody guessed.
 */
async function deadPort(): Promise<number> {
  const server = createHttpServer(() => {});
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => { server.close(() => { r(); }); });
  return port;
}

/** The door this install is configured for: a paired desktop, pinned, and not answering. */
let pairedOrigin = "";

beforeAll(async () => {
  pairedOrigin = `https://127.0.0.1:${await deadPort()}`;
  engine = await createCloudSidecar({
    dataDir: tmp(),
    cloudUrl: pairedOrigin,
    address: null,
    /* THE PIN IS WHAT MAKES THE TRANSPORT PINNED, and no `fetchImpl` is passed — so the engine
       composes the real one, which is the condition the row is about. */
    hostPin: "a".repeat(43),
    keks: { 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) },
    pollIntervalMs: 3_600_000,
  });
}, 60_000);

afterAll(async () => {
  await engine?.stop().catch(() => undefined);
  for (const s of servers.splice(0)) await new Promise<void>((r) => { s.close(() => { r(); }); });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const probe = async (body: Record<string, unknown>): Promise<{ status: number; body: any }> => {
  const res = await engine.handle(new Request("http://sidecar/cloud/probe", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${engine.sessionToken}` },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
};

describe("POST /cloud/probe — the candidate is dialled by a transport built for the candidate", () => {
  it("reaches a self-hosted server while the paired door this install is leaving is off", async () => {
    const port = await selfHostStack();

    const out = await probe({ origin: `http://127.0.0.1:${port}` });

    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.ok).toBe(true);
    expect(out.body.flavor).toBe("selfhost");
    // The base the greeting answered at — under `/api`, which is where a self-host box serves it.
    expect(out.body.base).toBe(`http://127.0.0.1:${port}/api`);
  });

  it("never explains a candidate with a sentence about the machine being left", async () => {
    const port = await selfHostStack();

    const out = await probe({ origin: `http://127.0.0.1:${port}` });

    const said = JSON.stringify(out.body);
    expect(said).not.toContain(pairedOrigin);
    expect(said).not.toContain("Could not establish a secure connection");
    expect(said).not.toContain("Check that computer is on");
  });

  /**
   * THE PAIR'S OTHER HALF. No candidate means "tell me about the door I am on", and that answer
   * has to come over that door's own pinned transport — so it refuses, naming the machine, which
   * is the right sentence for that question and the wrong one for the case above.
   */
  it("still answers about the CONFIGURED door over that door's own pinned transport", async () => {
    const out = await probe({});

    expect(out.status).toBe(502);
    expect(String(out.body.error.message)).toContain(pairedOrigin);
    expect(String(out.body.error.message)).toContain("Could not establish a secure connection");
  });
});
