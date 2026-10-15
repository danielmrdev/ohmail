import { createServer, type Server } from "node:https";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";

import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { ensureLanIdentity, type LanIdentity } from "../src/host-lan-tls.js";

/**
 * ═══ WHAT A CANDIDATE ENGINE PUTS ON THE WIRE BEFORE THE PROBE ADMITS ═══════════════════════
 *
 * The paired door is walked from a fresh install by starting the engine for the CANDIDATE and
 * asking the probe there — safe only if that engine is silent until the probe admits. The only
 * place to ask is the HOST: a real TLS listener serving the certificate a desktop host generates,
 * recording what it accepts and what it decrypts. Two legs, because they fail differently: it must
 * not dial before it is asked, and anything it sends must carry no credential. Header NAMES are
 * recorded, never their contents.
 */

const dirs: string[] = [];
const servers: Server[] = [];
const engines: CloudSidecar[] = [];

const tmp = (): string => {
  const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-candidate-wire-"));
  dirs.push(d);
  return d;
};

function identity(): LanIdentity {
  const out = ensureLanIdentity(tmp());
  if (out.kind !== "identity") throw new Error("the fixture could not mint a door identity");
  return out.identity;
}

interface Seen {
  /** TLS connections accepted — the "did it dial at all" leg. */
  connections: number;
  /** One per decrypted request: what was asked for, and which headers came with it. */
  requests: { method: string; url: string; headerNames: string[]; carriedCredential: boolean }[];
}

/** A desktop host that answers the greeting and writes down everything it was told. */
async function watchfulDoor(id: LanIdentity): Promise<{ origin: string; seen: Seen }> {
  const seen: Seen = { connections: 0, requests: [] };
  const server = createServer({ key: id.key, cert: id.cert }, (req, res) => {
    const headerNames = Object.keys(req.headers).map((h) => h.toLowerCase()).sort();
    seen.requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headerNames,
      /* PRESENCE, never the value. A cookie is a credential here too: the paired door's session
         is a bearer pair, and either shape arriving before the pin was judged is the defect. */
      carriedCredential: headerNames.includes("authorization") || headerNames.includes("cookie"),
    });
    if (req.url === "/hello") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ product: "ohmail", flavor: "desktop-host", needsSetup: false, auth: {} }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on("secureConnection", () => { seen.connections += 1; });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

afterAll(async () => {
  for (const e of engines.splice(0)) await e.stop().catch(() => undefined);
  for (const s of servers.splice(0)) await new Promise<void>((r) => { s.close(() => { r(); }); });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("a candidate engine is silent until the probe admits", () => {
  it("dials nothing at boot, and its probe then asks the greeting with no credential", async () => {
    const id = await identity();
    const { origin, seen } = await watchfulDoor(id);

    // THE CANDIDATE DOOR, exactly as the shell composes it for a link somebody pasted: the
    // origin from the link, the pin from the link, and NO mailbox address — which mailbox this
    // install reads is the host's answer at the redeem. No token pair: there is nothing to seal
    // yet, and this engine is here to answer one question.
    const engine = await createCloudSidecar({
      dataDir: tmp(),
      cloudUrl: origin,
      address: null,
      hostPin: id.fingerprint,
      keks: { 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) },
      pollIntervalMs: 3_600_000,
    });
    engines.push(engine);

    // LEG ONE — it did not dial. The mirror, the write-through proxy and the wake channel all
    // hang off the AUTHED half, which is null with no sealed token pair, so a boot has nothing
    // to pull with. Settled across a macrotask so a dial started and not awaited would land.
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.connections, JSON.stringify(seen.requests)).toBe(0);
    expect(seen.requests).toEqual([]);

    // AND THE PROBE ADMITS — the positive control, so the silence above is a fact about an
    // engine that works rather than about one that could not reach the fixture at all.
    const res = await engine.handle(new Request("http://sidecar/cloud/probe", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${engine.sessionToken}` },
      body: JSON.stringify({ origin, flavor: "desktop-host", hostPin: id.fingerprint }),
    }));
    const body = (await res.json()) as { ok?: boolean; flavor?: string; base?: string };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.flavor).toBe("desktop-host");

    // LEG TWO — everything that DID go out is the greeting, over a connection the pin was judged
    // on first, and none of it carried a credential. The token is spent once, at the redeem; a
    // probe that carried it would spend it on a step the person has not agreed to yet.
    expect(seen.requests.length).toBeGreaterThan(0);
    for (const r of seen.requests) {
      expect(`${r.method} ${r.url}`).toBe("GET /hello");
      expect(r.carriedCredential, r.headerNames.join(",")).toBe(false);
    }
  }, 120_000);

  it("a candidate whose key is not the link's is refused, and the host is told nothing", async () => {
    // THE REFUSAL ARM, and the reason the pin bootstrap writes zero bytes: a machine that fails
    // the pin must learn only that a TLS connection opened. If the greeting went out first and
    // the pin were judged after, an impostor at that address would have received a request from
    // an install that had not agreed to talk to it.
    const link = await identity();
    const impostor = await identity();
    const { origin, seen } = await watchfulDoor(impostor);

    const engine = await createCloudSidecar({
      dataDir: tmp(),
      cloudUrl: origin,
      address: null,
      hostPin: link.fingerprint,
      keks: { 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) },
      pollIntervalMs: 3_600_000,
    });
    engines.push(engine);

    const res = await engine.handle(new Request("http://sidecar/cloud/probe", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${engine.sessionToken}` },
      body: JSON.stringify({ origin, flavor: "desktop-host", hostPin: link.fingerprint }),
    }));
    const body = (await res.json()) as { error?: { details?: { kind?: string } } };
    expect(res.status).toBe(502);
    expect(body.error?.details?.kind).toBe("pin_mismatch");

    // NOT ONE REQUEST. The handshake happened — that is how the certificate was seen — and the
    // socket was destroyed without a byte written to it.
    expect(seen.requests, JSON.stringify(seen.requests)).toEqual([]);
  }, 120_000);
});
