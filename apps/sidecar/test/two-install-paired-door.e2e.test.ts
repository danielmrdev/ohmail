import { createServer, type Server } from "node:https";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { pairLink, parsePairLink } from "@trafficflow/core/pair-link";

import { createSidecar, type Sidecar } from "../src/engine.js";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { cloudConfigFromEnv } from "../src/main.js";
import { ensureLanIdentity, type LanIdentity } from "../src/host-lan-tls.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 3 });

/**
 * ═══ TWO INSTALLS, ONE PAIRING LINK, THE DOOR END TO END ════════════════════════════════════
 *
 * A SERVING desktop with host mode armed and a FRESH install with nothing, walking "Another
 * computer" from the link the first one printed: mint, compose, parse, probe, redeem. Both are
 * real — real stores, real routes, the host's own TLS key, and the one pin derivation.
 *
 * WHAT THIS CELL DOES NOT CARRY is the Tauri process: the shell's half (which engine answers,
 * the candidate's own directory, the budget) is `engine::tests`', and the packaged two-install
 * walk is its own cell. What it settles is that the two ENGINES complete the ceremony.
 */

const dirs: string[] = [];
const servers: Server[] = [];
const hosts: Sidecar[] = [];
const clients: CloudSidecar[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop().catch(() => undefined);
  for (const h of hosts.splice(0)) await h.stop().catch(() => undefined);
  for (const s of servers.splice(0)) await new Promise<void>((r) => { s.close(() => { r(); }); });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const scratch = async (prefix: string): Promise<string> => {
  const d = await freshDataDir(prefix);
  dirs.push(d);
  return d;
};

/**
 * INSTALL TWO, THROUGH THE ENVIRONMENT THE SHELL COMPOSES — not a config object written here.
 *
 * The first version of this cell handed `createCloudSidecar` a literal `{ address: null }`, and a
 * mutation that took the paired door's admission out of `cloudConfigFromEnv` left it GREEN: it was
 * measuring the engine's API rather than the seam the shell actually drives. These are the exact
 * names `config::env_for` writes for a desktop-host door, read by the function that reads them in
 * production, so an admission removed there reddens this cell.
 */
async function freshInstallFor(link: { origin: string; pin: string | null }): Promise<CloudSidecar> {
  const env: NodeJS.ProcessEnv = {
    OHMAIL_MODE: "cloud",
    OHMAIL_DATA_DIR: await scratch("ohmail-two-install-fresh-"),
    OHMAIL_CLOUD_URL: link.origin,
    OHMAIL_HOST_PIN: link.pin ?? "",
    OHMAIL_KEK: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
    /* AND NO OHMAIL_MAILBOX_ADDRESS, which is the whole point: a pairing link names a computer. */
  };
  const client = await createCloudSidecar({ ...cloudConfigFromEnv(env), pollIntervalMs: 3_600_000 });
  clients.push(client);
  return client;
}

/** INSTALL ONE: a desktop with host mode armed, serving its own door over its own key. */
async function servingDesktop(): Promise<{ origin: string; host: Sidecar; identity: LanIdentity }> {
  const dir = await scratch("ohmail-two-install-host-");
  const host = await createSidecar({
    dataDir: dir,
    /* No mail server is dialled: the adapter is a stand-in, because this cell is about the
       PAIRING ceremony and not about a mailbox. The settings are shaped as the engine expects. */
    imap: {
      host: "imap.invalid",
      port: 993,
      secure: true,
      auth: { user: "someone@example.test", pass: process.env.OHMAIL_FIXTURE_PASS ?? "fixture-not-a-credential" },
    },
    adapterFactory: () => ({ close: async () => undefined }) as unknown as MailboxAdapter,
    hostMode: true,
  });
  hosts.push(host);

  const out = ensureLanIdentity(dir);
  if (out.kind !== "identity") throw new Error("the serving desktop could not establish its key");
  const identity = out.identity;

  /* ITS OWN KEY ON THE WIRE, which is what makes the pin mean anything. Bound on loopback rather
     than through `startLanListener`, whose rules are about which INTERFACE may be published and
     are not what this cell is measuring; what is served is `handleHost`, the real door. */
  const server = createServer({ key: identity.key, cert: identity.cert }, (req, res) => {
    const url = `http://inside${req.url ?? "/"}`;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        const answer = await host.handleHost!(new Request(url, {
          method: req.method ?? "GET",
          headers: Object.entries(req.headers).flatMap(([k, v]) =>
            typeof v === "string" ? [[k, v] as [string, string]] : []),
          ...(body.byteLength > 0 ? { body } : {}),
        }));
        res.writeHead(answer.status, Object.fromEntries(answer.headers));
        res.end(Buffer.from(await answer.arrayBuffer()));
      })();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, host, identity };
}

/** The Devices pane's own act: mint one device-pair token on the serving desktop. */
async function mintLink(host: Sidecar, origin: string, pin: string): Promise<string> {
  const res = await host.handle(new Request("http://window/pair", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${host.sessionToken}` },
    body: JSON.stringify({ grant: "device-pair", label: "a second computer" }),
  }));
  const minted = (await res.json()) as { token?: string };
  if (res.status !== 200 || typeof minted.token !== "string") {
    throw new Error(`the serving desktop refused to mint a pairing code (${res.status})`);
  }
  /* THE COMPOSER THE PANE CALLS, not a string built here — a link this cell wrote by hand would
     be a cell about its own idea of the grammar. */
  return pairLink(origin, minted.token, pin);
}

/** How many devices the serving desktop lists. Read, never assumed — it lists its own. */
async function deviceCount(host: Sidecar): Promise<number> {
  const res = await host.handle(new Request("http://window/devices", {
    headers: { authorization: `Bearer ${host.sessionToken}` },
  }));
  if (res.status !== 200) throw new Error(`the serving desktop refused its own device list (${res.status})`);
  return ((await res.json()) as { items?: unknown[] }).items?.length ?? 0;
}

describe("a fresh install walks the paired door with a link the serving one printed", () => {
  it("mints, parses, probes and redeems — and the fresh install ends up holding a session", async () => {
    const { origin, host, identity } = await servingDesktop();
    const text = await mintLink(host, origin, identity.fingerprint);

    // ── THE LINK, through the door's own parser ─────────────────────────────────────────────
    const link = parsePairLink(text);
    expect(link, "the pane composed a link the door cannot read").not.toBeNull();
    expect(link!.origin).toBe(origin);
    expect(link!.pin).toBe(identity.fingerprint);
    /* AND IT NAMES NO MAILBOX. Which one this install ends up reading is the host's answer at the
       redeem below — that is the whole reason the paired door launches without an address. */
    expect(text).not.toContain("@");

    // ── INSTALL TWO: nothing configured, and the door composed exactly as the shell composes it
    //    for a candidate — the origin and the pin from the link, and NO address.
    const client = await freshInstallFor(link!);
    const ask = async (path: string, body: unknown): Promise<{ status: number; body: any }> => {
      const res = await client.handle(new Request(`http://sidecar${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${client.sessionToken}` },
        body: JSON.stringify(body),
      }));
      return { status: res.status, body: await res.json() };
    };

    // ── STEP ONE: is a computer running ohmail there, and is its key the one the link names? ──
    const proved = await ask("/cloud/probe", {
      origin: link!.origin, flavor: "desktop-host", hostPin: link!.pin,
    });
    expect(proved.status, JSON.stringify(proved.body)).toBe(200);
    expect(proved.body.flavor).toBe("desktop-host");
    expect(proved.body.base).toBe(origin);

    // ── STEP TWO: spend the token. The credential is sent HERE and nowhere earlier. ──────────
    const redeemed = await ask("/cloud/pair-redeem", { token: link!.token });
    expect(
      [200, 204].includes(redeemed.status),
      `the redeem was refused: ${JSON.stringify(redeemed.body)}`,
    ).toBe(true);

    // ── AND THE SERVING DESKTOP NOW KNOWS ABOUT IT: the pairing produced a device over there,
    //    which is the only end of this that proves the token was spent against the real host.
    expect(await deviceCount(host)).toBeGreaterThan(0);
  });

  it("a link from a DIFFERENT computer's key is refused before the token is spent", async () => {
    // THE ARM THAT MAKES THE ONE ABOVE MEAN SOMETHING. A walk that admits everything proves only
    // that two engines can talk; what the pin is for is refusing the machine that is not the one
    // the link came from — and refusing it BEFORE the single-use token goes anywhere.
    const { origin, host, identity } = await servingDesktop();
    const elsewhere = await scratch("ohmail-two-install-other-");
    const other = ensureLanIdentity(elsewhere);
    if (other.kind !== "identity") throw new Error("the fixture could not mint a second key");
    expect(other.identity.fingerprint).not.toBe(identity.fingerprint);

    const text = await mintLink(host, origin, other.identity.fingerprint);
    const link = parsePairLink(text)!;
    /* THE BASELINE, READ RATHER THAN ASSUMED. A serving desktop lists its own row here, so "no
       device was paired" is a count that did not MOVE, not a count of zero — and the first
       version of this arm asserted zero and failed against the host's own entry. */
    const before = await deviceCount(host);

    const client = await freshInstallFor(link);

    const res = await client.handle(new Request("http://sidecar/cloud/probe", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${client.sessionToken}` },
      body: JSON.stringify({ origin: link.origin, flavor: "desktop-host", hostPin: link.pin }),
    }));
    const body = (await res.json()) as { error?: { details?: { kind?: string } } };
    expect(res.status).toBe(502);
    expect(body.error?.details?.kind).toBe("pin_mismatch");

    // …and the token is still unspent on the serving desktop: nothing was paired.
    expect(await deviceCount(host)).toBe(before);
  });
});
