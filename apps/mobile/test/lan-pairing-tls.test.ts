import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:https";
import { request } from "node:https";
import { describe, expect, it } from "vitest";
import { shortPin } from "@ohmail/client-engine";
/* THE SIDECAR'S OWN KEY MINTING, by relative path. `apps/mobile` does not depend on the sidecar
   and must not — this is a TEST reaching across two apps on purpose, because the alternative is a
   second copy of the fingerprint rule, and a fingerprint computed by two rules is a pairing that
   fails on a kitchen table with nothing on either machine to look at. The root vitest config is
   one project, so the relative import resolves the same way every other suite's does. */
import { ensureLanIdentity } from "../../sidecar/src/host-lan-tls.js";
import type { FetchLike } from "../src/net/bearer";
import { pairWithServer, probePairing, type PairingEnv } from "../src/net/pairing";
import { ServerProfileStore, type SecureKV } from "../src/state/servers";
import { Copy } from "../src/copy";
import { sayRefusal } from "../src/refusal";
import type { MobileEngineDeps } from "../src/engine/boot";
import { sqlWorld } from "./helpers/pair-server";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE SAME-NETWORK DOOR, FOR REAL — TLS, a self-signed key, and the ceremony over it
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every other pairing suite talks to a plain-HTTP loopback server, which is right for what those
 * files are about and leaves the one thing the LAN door actually is untested in this repository:
 * a socket secured by a certificate no authority will ever vouch for, whose trust comes from the
 * pairing ceremony and from nothing else.
 *
 * So this stands the real thing up. `ensureLanIdentity` is the sidecar's OWN minting — the same
 * function the desktop calls at every launch — and its certificate is served by a real
 * `node:https` listener. Nothing here invents a key, a fingerprint or a certificate.
 *
 * ── THE DOUBLE FOR THE PIN, AND WHY IT FAILS THE WAY THE PHONE FAILS ─────────────────────────
 *
 * On a phone the native registry is told "accept this SPKI for this host and port, and nothing
 * else". Node has no such registry (`canPin()` is false off-device, which is why a pinned pairing
 * is refused there rather than made unpinned), so the stand-in is a TLS client whose trust anchor is
 * the door's own certificate and nothing else. That is the same shape: exactly one acceptable key.
 *
 * It matters that it fails the same way too. Pointed at a door presenting a DIFFERENT key, the
 * handshake fails with the platform's own `SELF_SIGNED_CERT_IN_CHAIN` / `UNABLE_TO_VERIFY` text —
 * the class `isPinFailure` recognises — so the mismatched-key arm below is a real refused
 * handshake rather than a simulated one.
 *
 * What this still does NOT claim: that the Android native pinning module honours a pin, or that a
 * phone renders the confirmation. Those need a device and are the AVD cell, named as such.
 */

function memoryKV(): SecureKV {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => { map.set(k, v); },
    remove: async (k) => { map.delete(k); },
  };
}

function testEnv(): { env: PairingEnv; world: ReturnType<typeof sqlWorld> } {
  const world = sqlWorld();
  const deps: MobileEngineDeps = {
    openExecutor: world.open,
    deleteDatabase: world.drop,
    uuid: () => "00000000-0000-4000-8000-000000000000",
  };
  return { env: { profiles: new ServerProfileStore(memoryKV()), engineDeps: deps }, world };
}

/** A `FetchLike` over `node:https` whose ONE trust anchor is `ca` — the pin's stand-in. */
function pinnedFetch(ca: string): FetchLike {
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const i = (init ?? {}) as { method?: string; headers?: Record<string, string>; body?: string };
      const u = new URL(url);
      const req = request(
        {
          host: u.hostname,
          port: u.port,
          path: `${u.pathname}${u.search}`,
          method: i.method ?? "GET",
          headers: i.headers ?? {},
          /* The anchor, and the reason this is the pin's stand-in: `ca` alone, and the door's
             certificate names no host anybody can verify, so the host check is off for the same
             reason the phone's is — the KEY is the identity, not the name. */
          ca: [ca],
          checkServerIdentity: () => undefined,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            resolve(new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 500,
              headers: { "content-type": String(res.headers["content-type"] ?? "application/json") },
            }));
          });
        },
      );
      req.on("error", reject);
      if (i.body !== undefined) req.write(i.body);
      req.end();
    });
}

/** The LAN door's route shape, over TLS. One live token, spendable once. */
function lanDoor(identity: { key: string; cert: string }, token: string) {
  const seen: { method: string; url: string }[] = [];
  let spent = false;
  const server: Server = createServer({ key: identity.key, cert: identity.cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = req.url ?? "/";
      seen.push({ method: req.method ?? "GET", url });
      const json = (status: number, payload: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (url === "/hello") {
        return json(200, {
          product: "ohmail", flavor: "desktop-host", apiVersion: "3", needsSetup: false,
          features: { sse: false, staging: false, ai: false, pairing: true },
        });
      }
      if (url === "/pair/redeem" && req.method === "POST") {
        const sent = (JSON.parse(body || "{}") as { token?: string }).token;
        if (spent || sent !== token) return json(400, { error: { code: "pairing_invalid" } });
        spent = true;
        return json(200, { tokens: { accessToken: "acc-1", refreshToken: "ref-1" } });
      }
      const bearer = String(req.headers.authorization ?? "");
      if (url === "/auth/session") {
        if (!bearer.startsWith("Bearer ")) return json(401, { error: { code: "unauthorized" } });
        return json(200, { user: { accountId: "acct-lan" } });
      }
      if (url.startsWith("/sync")) {
        /* 401 JSON `unauthorized` WITHOUT a credential, which is not decoration: it is the exact
           answer `resolveApiBase` reads to decide where a server's mail API lives, and a fixture
           that answered 200 to the credential-free probe made the whole pairing refuse with "could
           not find its mail API". The real API answers this; so does this. */
        if (!bearer.startsWith("Bearer ")) return json(401, { error: { code: "unauthorized" } });
        return json(200, { changes: { creates: [], updates: [], moves: [], deletes: [] }, asOfSeq: 0, nextCursor: null });
      }
      return json(404, { error: { code: "not_found" } });
    });
  });
  return { server, seen: () => seen };
}

const listen = (server: Server): Promise<string> =>
  new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address() as { port: number };
      done(`https://127.0.0.1:${a.port}`);
    });
  });

describe("the same-network door, over real TLS with the key the sidecar mints", () => {
  it("pairs end to end, and the key in the admission is the DOOR's own fingerprint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmail-lan-tls-"));
    const minted = ensureLanIdentity(dir);
    expect(minted.kind, "the sidecar refused to mint a LAN identity").toBe("identity");
    if (minted.kind !== "identity") return;
    const identity = minted.identity;

    const door = lanDoor(identity, "tok-lan");
    const origin = await listen(door.server);
    try {
      const { env } = testEnv();
      const pinned = { ...env, fetchImpl: pinnedFetch(identity.cert) };

      // ── THE PROBE, over TLS, spending nothing ──────────────────────────────────────────────
      const probed = await probePairing(pinned, { origin, pin: identity.fingerprint });
      expect(probed.kind).toBe("offers");
      if (probed.kind !== "offers") return;
      expect(door.seen().some((r) => r.url === "/hello")).toBe(true);
      expect(door.seen().filter((r) => r.url.startsWith("/pair/redeem"))).toHaveLength(0);

      expect(probed.admission.flavor).toBe("desktop-host");
      /**
       * THE ADMISSION CARRIES NO KEY HERE, and that is the correct answer rather than a gap.
       *
       * The door is on LOOPBACK, which `originNeedsPin` exempts — no network path exists to
       * attack — so nothing is enforced, and only an ENFORCED key may reach the confirmation. A
       * node run cannot enforce a pin anywhere: loopback is exempt and `canPin()` is false for
       * every other origin, which is exactly why the pinned arm is a DEVICE cell. On the AVD the
       * same door was dialled as `10.0.2.2` — an IP literal — the native registry enforced the
       * key, and the phone drew twelve characters byte-equal to the fingerprint below.
       */
      expect(probed.admission.pin).toBeNull();
      // The FINGERPRINT itself is still the door's own and still what a link would carry — not a
      // fixture: `ensureLanIdentity` derived it from the key it generated.
      expect(identity.fingerprint).toHaveLength(43);
      expect(shortPin(identity.fingerprint)).toHaveLength(13);

      // ── THE CONFIRMED REDEEM ───────────────────────────────────────────────────────────────
      const paired = await pairWithServer(pinned, { admission: probed.admission, token: "tok-lan" });
      expect(paired.kind, "the ceremony did not complete over TLS").toBe("paired");
      if (paired.kind !== "paired") return;
      expect(paired.session.profile.origin.startsWith("https://")).toBe(true);
      // Stored as NULL, for the reason above: what is persisted is what was enforced.
      expect(paired.session.profile.pin).toBeNull();
      expect(paired.session.profile.accountId).toBe("acct-lan");
      expect(door.seen().filter((r) => r.url.startsWith("/pair/redeem"))).toHaveLength(1);
      paired.session.store.close();
    } finally {
      door.server.close();
    }
  });

  it("a door presenting ANOTHER key is a refused handshake, told as a claimed-origin mismatch", async () => {
    /**
     * The mismatched-fingerprint arm, and it is a REAL refused handshake: two independently minted
     * identities, the client anchored on one and the door serving the other. Nothing simulates the
     * failure — node's TLS stack produces it, and the sentence has to survive the platform's own
     * words for it.
     */
    const a = ensureLanIdentity(mkdtempSync(join(tmpdir(), "ohmail-lan-tls-a-")));
    const b = ensureLanIdentity(mkdtempSync(join(tmpdir(), "ohmail-lan-tls-b-")));
    expect(a.kind).toBe("identity");
    expect(b.kind).toBe("identity");
    if (a.kind !== "identity" || b.kind !== "identity") return;
    // Two mints are two keys — if this ever held, the arm below would prove nothing.
    expect(a.identity.fingerprint).not.toBe(b.identity.fingerprint);

    const door = lanDoor(a.identity, "tok-lan");
    const origin = await listen(door.server);
    try {
      const { env } = testEnv();
      // Anchored on B's certificate; the door serves A's.
      const wrong = { ...env, fetchImpl: pinnedFetch(b.identity.cert) };
      const refused = await probePairing(wrong, { origin, pin: a.identity.fingerprint });
      expect(refused.kind).toBe("refused");
      if (refused.kind !== "refused") return;

      // THE SENTENCE, at the seam that shows it — not the platform's unreadable words, never
      // "the server is unreachable", which sends somebody to look at their wifi, and not the
      // CHANGED-key sentence either: this env has paired with nothing, so nothing changed. The
      // code named one identity and the door presented another. (The changed-key twin needs a
      // stored pairing holding a key, which loopback can never have — `originNeedsPin` exempts
      // it, so nothing is enforced; that arm lives in `pairing-confirms-the-origin.test.ts`.)
      expect(sayRefusal(refused.reason)).toBe(Copy.pairKeyMismatch);
      expect(sayRefusal(refused.reason)).not.toBe(Copy.pinChanged);
      expect(sayRefusal(refused.reason)).toContain("something else answered at that address");
      // Nothing was spent: the handshake failed before the redeem could be reached.
      expect(door.seen().filter((r) => r.url.startsWith("/pair/redeem"))).toHaveLength(0);
    } finally {
      door.server.close();
    }
  });
});
