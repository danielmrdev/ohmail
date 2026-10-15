import { createServer, type Server } from "node:https";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { ensureLanIdentity, type LanIdentity } from "../src/host-lan-tls.js";

/**
 * `POST /cloud/probe`, THE PAIRED-DESKTOP ARM — driven through the ROUTE.
 *
 * Every refusal here is a `kind` the window turns into a translated sentence, and the whole point
 * of the route is that NOTHING is configured while it runs: a wrong link must cost no mirror,
 * which is the self-hosted door's finding applied to a link somebody pasted.
 *
 * One engine for the whole file. The probe configures nothing and mutates no engine state, so a
 * boot per case would buy nothing but a minute of embedded-database startup.
 */

const dirs: string[] = [];
const servers: Server[] = [];
let engine: CloudSidecar;

const tmp = (): string => {
  const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-probe-door-"));
  dirs.push(d);
  return d;
};

function identity(): LanIdentity {
  const out = ensureLanIdentity(tmp());
  if (out.kind !== "identity") throw new Error("the fixture could not mint a door identity");
  return out.identity;
}

/** A real TLS listener serving the certificate a desktop host actually generates. */
async function door(id: LanIdentity, flavor: string): Promise<number> {
  const server = createServer({ key: id.key, cert: id.cert }, (req, res) => {
    if (req.url === "/hello") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ product: "ohmail", flavor, needsSetup: false, auth: {} }));
      return;
    }
    res.writeHead(404); res.end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

beforeAll(async () => {
  engine = await createCloudSidecar({
    dataDir: tmp(),
    cloudUrl: "https://unused.test",
    address: "me@ohmail.test",
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

describe("POST /cloud/probe — the paired-desktop arm", () => {
  it("ADMITS a desktop host, and reports the base the greeting answered at", async () => {
    const id = identity();
    const port = await door(id, "desktop-host");

    const out = await probe({
      origin: `https://127.0.0.1:${port}`, flavor: "desktop-host", hostPin: id.fingerprint,
    });

    // THE POSITIVE CONTROL. Four of the six cases below are refusals, and a rule whose every case
    // refuses has no evidence it admits the right machine.
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.ok).toBe(true);
    expect(out.body.flavor).toBe("desktop-host");
    // A desktop host serves its API at the ROOT — the base is the origin, with no `/api` on it.
    expect(out.body.base).toBe(`https://127.0.0.1:${port}`);
  });

  it("refuses a key that is not the one the link named", async () => {
    const paired = identity();
    const impostor = identity();
    const port = await door(impostor, "desktop-host");

    const out = await probe({
      origin: `https://127.0.0.1:${port}`, flavor: "desktop-host", hostPin: paired.fingerprint,
    });

    expect(out.status).toBe(502);
    expect(out.body.error.details.kind).toBe("pin_mismatch");
    // The sentence says what to do and offers no way past it: a changed key is either a machine
    // that was reinstalled or somebody else answering, and both end in re-pairing deliberately.
    expect(out.body.error.message).toContain("not the one this link came from");
    expect(out.body.error.message).not.toContain(paired.fingerprint);
  });

  it("refuses an address that cannot be checked when the link carried no fingerprint", async () => {
    const id = identity();
    const port = await door(id, "desktop-host");

    const out = await probe({ origin: `https://192.168.1.20:${port}`, flavor: "desktop-host" });

    expect(out.status).toBe(400);
    expect(out.body.error.details.kind).toBe("no_pin");
    expect(out.body.error.message).toContain("pairing code");
  });

  it("refuses cleartext with its own sentence rather than the general address one", async () => {
    const out = await probe({ origin: "http://192.168.1.20:8080", flavor: "desktop-host" });

    expect(out.status).toBe(400);
    expect(out.body.error.details.kind).toBe("cleartext");
    expect(out.body.error.message).toContain("not encrypted");
  });

  it("refuses a SELF-HOSTED server reached from the pairing door, and names the other door", async () => {
    const id = identity();
    const port = await door(id, "selfhost");

    const out = await probe({
      origin: `https://127.0.0.1:${port}`, flavor: "desktop-host", hostPin: id.fingerprint,
    });

    expect(out.status).toBe(502);
    // The wrong DOOR rather than the wrong address — one screen back, not a re-printed code.
    expect(out.body.error.details.kind).toBe("selfhost");
    expect(out.body.error.message).toContain("A server I run");
  });

  it("refuses a desktop that is not offering itself, and says where to turn that on", async () => {
    const id = identity();
    const port = await door(id, "local");

    const out = await probe({
      origin: `https://127.0.0.1:${port}`, flavor: "desktop-host", hostPin: id.fingerprint,
    });

    expect(out.status).toBe(502);
    expect(out.body.error.details.kind).toBe("local");
    expect(out.body.error.message).toContain("Settings → Devices");
  });

  it("leaves the other doors' behaviour exactly as it was", async () => {
    // No flavor on the body is every caller that predates this arm. `originNeedsPin` is not
    // consulted, no pin is demanded, and the `/api` fallback is still what a self-host stack gets.
    const out = await probe({ origin: "https://192.168.1.20:9" });
    expect(out.status).toBe(502);
    expect(out.body.error.details.kind).not.toBe("no_pin");
    expect(out.body.error.details.kind).not.toBe("cleartext");
  });
});
