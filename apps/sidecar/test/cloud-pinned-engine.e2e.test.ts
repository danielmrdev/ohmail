import { createServer, type Server } from "node:https";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { ensureLanIdentity, type LanIdentity } from "../src/host-lan-tls.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE PINNED SEAM, WITH NOTHING INJECTED — the engine as the shell actually spawns it.
 *
 * Every other test of this door hands `createCloudSidecar` a `fetchImpl`, which is the seam that
 * makes the rest of the suite possible and is also the seam that would hide this: an injected
 * transport bypasses the pinned one entirely, so a build where `hostPin` was read and then never
 * used would pass every one of those tests. Here NOTHING is injected. The engine composes its own
 * connection from the pin, and the only way a request reaches the door below is through it.
 *
 * The door is a real `node:https` listener serving the certificate a desktop host actually
 * generates — the same `ensureLanIdentity` the host calls, whose certificate carries a critical
 * `basicConstraints` saying it is NOT a certificate authority. That matters: the pinned client
 * trusts that leaf as its own anchor, and a fixture with a friendlier certificate could satisfy
 * the claim with something the host will never serve.
 */

const dirs: string[] = [];
const servers: Server[] = [];
const sidecars: CloudSidecar[] = [];

afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const s of servers.splice(0)) await new Promise<void>((r) => { s.close(() => { r(); }); });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A throwaway directory. NOT templated: `identity()` below wants an empty one. */
const tmp = (): string => {
  const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-pinned-"));
  dirs.push(d);
  return d;
};

/** …and the engine's own data directory, which does want the initialised store. */
const engineDataDir = async (): Promise<string> => {
  const d = await freshDataDir("ohmail-pinned-engine-");
  dirs.push(d);
  return d;
};

function identity(): LanIdentity {
  const out = ensureLanIdentity(tmp());
  if (out.kind !== "identity") throw new Error("the fixture could not mint a door identity");
  return out.identity;
}

interface Door {
  origin: string;
  /** HTTP requests that got through the TLS layer. The measure of "did anything reach it". */
  requests: string[];
}

async function door(id: LanIdentity): Promise<Door> {
  const requests: string[] = [];
  const server = createServer({ key: id.key, cert: id.cert }, (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === "/pair/redeem") {
      res.writeHead(200, { "content-type": "application/json", "x-ohmail-account": "acct-1" });
      res.end(JSON.stringify({ grant: "device-pair", tokens: { accessToken: "a", refreshToken: "r" } }));
      return;
    }
    if (req.url === "/mailboxes") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(mailboxList([hostedMailbox("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "me@ohmail.test")])));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "c1", hasMore: false, serverTime: new Date().toISOString(),
    }));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

/** The engine as the shell spawns it for a paired door: a pin, no address, NO injected transport. */
async function pairedEngine(origin: string, pin: string): Promise<CloudSidecar> {
  const s = await createCloudSidecar({
    dataDir: await engineDataDir(),
    cloudUrl: origin,
    address: null,
    hostPin: pin,
    keks: { 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) },
    pollIntervalMs: 3_600_000,
  });
  sidecars.push(s);
  return s;
}

const redeem = (s: CloudSidecar): Promise<Response> =>
  s.handle(new Request("http://sidecar/cloud/pair-redeem", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${s.sessionToken}` },
    body: JSON.stringify({ token: "tok-abc" }),
  }));

describe("a paired engine with nothing injected", () => {
  it("BOOTS with no mailbox address and redeems over its own pinned connection", async () => {
    const id = identity();
    const d = await door(id);

    // THE BOOT IS HALF THE CONTROL. Before the address became optional by door kind this line
    // threw: the engine required OHMAIL_MAILBOX_ADDRESS, and a paired door has none to give.
    const engine = await pairedEngine(d.origin, id.fingerprint);
    expect(engine.signedIn()).toBe(false);

    const res = await redeem(engine);

    expect(res.status, await res.clone().text()).toBe(200);
    expect((await res.json()).status).toBe("paired");
    expect(engine.signedIn()).toBe(true);
    // THE REQUEST ARRIVED, over TLS the engine verified against the pin and nothing else.
    expect(d.requests).toContain("POST /pair/redeem");
  }, 90_000);

  it("refuses an impostor key with ZERO requests reaching the door", async () => {
    const paired = identity();
    const impostor = identity();
    const d = await door(impostor);

    const engine = await pairedEngine(d.origin, paired.fingerprint);
    const res = await redeem(engine);

    expect(res.status).toBe(502);
    expect(engine.signedIn(), "an impostor door established a session").toBe(false);
    /* ZERO. Not "the response was refused" — the pairing token never left this machine. The
       identity is judged before any application byte is written, so a peer that fails the pin
       learns only that something opened a TLS connection, which it would learn from a port scan.
       This is the assertion that a "verify afterwards" implementation would fail while still
       returning the right status. */
    expect(d.requests, "the pairing code reached a door that failed the pin").toEqual([]);
  }, 90_000);
});
