/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A SCANNED CODE CHANGES NOTHING UNTIL SOMEBODY PRESSES — the pinned half
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The confirmation itself is held from three directions already (`pairing.test.ts` for the seam,
 * `doors.test.ts` for the source). What none of them could reach is the ONE thing a probe has to
 * change before anybody has decided anything: the TLS registry's entry for that (host, port).
 *
 * The install cannot wait for the press — `/hello` is already a request, and a self-signed door
 * fails the platform trust store — so the key a code carries is installed to dial and is a LEASE.
 * Before this suite it was permanent: scanning a stranger's code for your own computer's address
 * left that stranger's key enforced for that (host, port) after a dismiss, after a refusal, after
 * a rejected redeem. Nothing on any screen said so and nothing took it back.
 *
 * These arms run the REAL seam (`src/net/pairing.ts`) against a fake registry — the shape the
 * native half implements — over an IP-literal origin, which is the only class `originNeedsPin`
 * asks a key for. Loopback is exempt, which is why the other pairing suites never reach this code
 * at all. The phone's own rendering of the confirmation is the device cell, named in the report.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Copy, DECKS } from "../src/copy";
import { sayRefusal } from "../src/refusal";
import type { MobileEngineDeps } from "../src/engine/boot";
import type { FetchLike } from "../src/net/bearer";
import {
  hostPortOf, installPinning, pinnedCount, type PinningNative,
} from "../src/net/host-pinning";
import {
  discardAdmission, pairWithServer, probePairing, type PairingEnv,
} from "../src/net/pairing";
import { ServerProfileStore, type SecureKV } from "../src/state/servers";
import { sqlWorld } from "./helpers/pair-server";

/** A same-network address: an IP literal, which is the class that needs a key. */
const ORIGIN = "https://192.168.1.20:6245";
const AT = "192.168.1.20:6245";
/** Two fingerprints of the shape the desktop composes into a code (43 base64url characters). */
const KEY = "k5PGuAY8E5LFpWM0zgqW20AuzK_KKxn8dKZsV6QmpWg";
const OTHER = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCDE";

/** The registry the native half implements, recording what it would have been told. */
function fakeNative(): PinningNative & { pins: Map<string, string> } {
  const pins = new Map<string, string>();
  return {
    pins,
    isInstalled: () => true,
    factoryUses: () => 1,
    setPin: (host, port, spki) => { pins.set(`${host}:${port}`, spki); return pins.size; },
    clearPin: (host, port) => { pins.delete(`${host}:${port}`); return pins.size; },
    clearAllPins: () => { pins.clear(); return 0; },
    pinnedCount: () => pins.size,
  };
}

function memoryKV(): SecureKV {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
  };
}

/**
 * The door at {@link ORIGIN}, as a transport. `mode` is what the socket does: `ok` answers the
 * ceremony, `handshake` throws the platform's OWN words for a certificate the pin does not
 * accept — the class `isPinFailure` recognises, so the mismatch arms read a real shape rather
 * than a flag — and `not-ohmail` answers something that is not one of our servers.
 */
function door(token: string) {
  const state = { seen: [] as string[], mode: "ok" as "ok" | "handshake" | "not-ohmail", spent: false };
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetchImpl: FetchLike = async (url, init) => {
    const path = String(url).slice(ORIGIN.length);
    state.seen.push(path);
    if (state.mode === "handshake") {
      throw new Error("javax.net.ssl.SSLHandshakeException: Chain validation failed");
    }
    const i = (init ?? {}) as { headers?: Record<string, string>; body?: string };
    const auth = String(i.headers?.authorization ?? "");
    if (path === "/hello") {
      if (state.mode === "not-ohmail") return json(200, { hello: "world" });
      return json(200, {
        product: "ohmail", flavor: "desktop-host", apiVersion: "3", needsSetup: false,
        features: { sse: false, staging: false, ai: false, pairing: true },
      });
    }
    if (path === "/pair/redeem") {
      const sent = (JSON.parse(i.body ?? "{}") as { token?: string }).token;
      if (state.spent || sent !== token) return json(400, { error: { code: "pairing_invalid" } });
      state.spent = true;
      return json(200, { tokens: { accessToken: "acc-1", refreshToken: "ref-1" } });
    }
    if (path === "/auth/session") {
      if (!auth.startsWith("Bearer ")) return json(401, { error: { code: "unauthorized" } });
      return json(200, { user: { accountId: "acct-pinned" } });
    }
    if (path.startsWith("/sync")) {
      /* 401 JSON without a credential is the exact answer `resolveApiBase` reads to find where a
         server's mail API lives — a fixture answering 200 makes the whole pairing refuse. */
      if (!auth.startsWith("Bearer ")) return json(401, { error: { code: "unauthorized" } });
      return json(200, {
        changes: { creates: [], updates: [], moves: [], deletes: [] }, asOfSeq: 0, nextCursor: null,
      });
    }
    return json(404, { error: { code: "not_found" } });
  };
  return { state, fetchImpl, redeems: (): number => state.seen.filter((p) => p === "/pair/redeem").length };
}

let native: ReturnType<typeof fakeNative>;

function testEnv(fetchImpl: FetchLike): PairingEnv {
  const world = sqlWorld();
  const deps: MobileEngineDeps = {
    openExecutor: world.open,
    deleteDatabase: world.drop,
    uuid: () => "00000000-0000-4000-8000-000000000000",
  };
  return { profiles: new ServerProfileStore(memoryKV()), engineDeps: deps, fetchImpl };
}

beforeEach(() => {
  native = fakeNative();
  installPinning(native);
});
afterEach(() => installPinning(null));

describe("the key a pairing code carries is a lease until the press", () => {
  it("the probe names the origin it enforces the key for, and stores NOTHING else", async () => {
    const d = door("tok-1");
    const env = testEnv(d.fetchImpl);

    const probed = await probePairing(env, { origin: ORIGIN, pin: KEY });
    expect(probed.kind).toBe("offers");
    if (probed.kind !== "offers") return;

    // ANTI-VACUITY: it really dialled. An arm that made no request would satisfy every
    // "nothing was spent" assertion below and prove nothing at all.
    expect(d.state.seen).toContain("/hello");

    // WHAT THE CONFIRMATION IS ASKED ABOUT — the address verbatim, which IS the (host, port) the
    // TLS stack now enforces this key for. A screen naming one pair while the socket checks
    // another is a confirmation of the wrong thing.
    expect(probed.admission.origin).toBe(ORIGIN);
    expect(hostPortOf(probed.admission.origin)).toEqual({ host: "192.168.1.20", port: 6245 });
    // AND THE TLS IDENTITY THE PHONE ACTUALLY SAW: `/hello` and the API probe both completed over
    // a socket enforcing this key, so it is what answered rather than what the link claimed.
    expect(probed.admission.pin).toBe(KEY);
    expect(native.pins.get(AT)).toBe(KEY);

    // A LEASE, not a decision. Nobody has agreed to it yet, and it says so.
    expect(probed.admission.provisionalPin).toBe(true);

    // NOTHING ELSE HAPPENED BEFORE THE PRESS: no redeem, no profile, no credential.
    expect(d.redeems()).toBe(0);
    expect(await env.profiles.list()).toHaveLength(0);
  });

  it("a DISMISS gives the key back — nothing pinned, nothing stored, nothing spent", async () => {
    const d = door("tok-1");
    const env = testEnv(d.fetchImpl);
    const probed = await probePairing(env, { origin: ORIGIN, pin: KEY });
    expect(probed.kind).toBe("offers");
    if (probed.kind !== "offers") return;
    // The state the dismiss has to undo — without this the next line proves nothing.
    expect(native.pins.get(AT)).toBe(KEY);

    discardAdmission(probed.admission);

    expect(pinnedCount(), "a declined code left its key enforced for that address").toBe(0);
    expect(await env.profiles.list()).toHaveLength(0);
    expect(d.redeems()).toBe(0);
  });

  it("THE PRESS is the positive control: it pairs, and the profile then owns the key", async () => {
    const d = door("tok-1");
    const env = testEnv(d.fetchImpl);
    const probed = await probePairing(env, { origin: ORIGIN, pin: KEY });
    expect(probed.kind).toBe("offers");
    if (probed.kind !== "offers") return;

    const paired = await pairWithServer(env, { admission: probed.admission, token: "tok-1" });
    expect(paired.kind, "the ordinary confirmed pairing must still complete").toBe("paired");
    if (paired.kind !== "paired") return;
    try {
      expect(d.redeems()).toBe(1);
      expect(paired.session.profile.origin).toBe(ORIGIN);
      // PERSISTED, so the next cold start re-installs it before the first request — and from
      // here the row owns the key, which is why no later refusal may drop it.
      expect(paired.session.profile.pin).toBe(KEY);
      expect(native.pins.get(AT)).toBe(KEY);
    } finally {
      paired.session.store.close();
    }
  });

  it("a REFUSED PROBE leaves no trust behind either", async () => {
    const d = door("tok-1");
    d.state.mode = "not-ohmail";
    const env = testEnv(d.fetchImpl);

    const refused = await probePairing(env, { origin: ORIGIN, pin: KEY });
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") return;
    expect(sayRefusal(refused.reason)).toBe(Copy.pairNotOhmail);
    // The gate installed the key to dial; the refusal is where it ends. This line was the defect.
    expect(pinnedCount(), "a refused probe left the code's key enforced").toBe(0);
    expect(await env.profiles.list()).toHaveLength(0);
  });

  it("a REFUSED REDEEM gives the key back — a spent-code sentence stores nothing", async () => {
    const d = door("tok-real");
    const env = testEnv(d.fetchImpl);
    const probed = await probePairing(env, { origin: ORIGIN, pin: KEY });
    expect(probed.kind).toBe("offers");
    if (probed.kind !== "offers") return;
    expect(native.pins.get(AT)).toBe(KEY);

    // The code was already spent on another phone, or minted by somebody else: the door says no.
    const refused = await pairWithServer(env, { admission: probed.admission, token: "tok-wrong" });
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") return;
    expect(sayRefusal(refused.reason)).toBe(Copy.pairCodeRejected);
    expect(pinnedCount(), "a refused redeem left the code's key enforced").toBe(0);
    expect(await env.profiles.list()).toHaveLength(0);
  });

  it("a LIVE PAIRING's key is never dropped by looking at a second code", async () => {
    /**
     * The narrowness, and it is the half a broad discard would break: after pairing, a second
     * scan of the same code re-probes the same origin. Its admission is NOT provisional — the
     * stored row owns that key — so a dismiss must leave the pairing trusting its computer.
     * An unconditional un-pin here would silently un-trust a working pairing.
     */
    const d = door("tok-1");
    const env = testEnv(d.fetchImpl);
    const first = await probePairing(env, { origin: ORIGIN, pin: KEY });
    expect(first.kind).toBe("offers");
    if (first.kind !== "offers") return;
    const paired = await pairWithServer(env, { admission: first.admission, token: "tok-1" });
    expect(paired.kind).toBe("paired");
    if (paired.kind !== "paired") return;
    paired.session.store.close();

    const again = await probePairing(env, { origin: ORIGIN, pin: KEY });
    expect(again.kind).toBe("offers");
    if (again.kind !== "offers") return;
    expect(again.admission.provisionalPin).toBe(false);

    discardAdmission(again.admission);
    expect(native.pins.get(AT), "a dismissed second look un-pinned a live pairing").toBe(KEY);
    expect(await env.profiles.list()).toHaveLength(1);
  });
});

describe("a code whose key that address does not present refuses BY NAME", () => {
  it("FIRST CONTACT is a claimed-origin mismatch, not a changed key", async () => {
    /**
     * The sequence: a code names `https://192.168.1.20:6245` — the victim's own desktop address —
     * and carries somebody else's key; or the address is right and a machine on that network is
     * answering for it. Either way the handshake fails, and the phone had agreed to NOTHING for
     * that address, so nothing changed. The single sentence told them their own computer had been
     * re-keyed and to mint a fresh code and pair again: the instruction that walks them into it a
     * second time.
     */
    const d = door("tok-1");
    d.state.mode = "handshake";
    const env = testEnv(d.fetchImpl);

    const refused = await probePairing(env, { origin: ORIGIN, pin: OTHER });
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") return;

    expect(sayRefusal(refused.reason)).toBe(Copy.pairKeyMismatch);
    expect(sayRefusal(refused.reason)).not.toBe(Copy.pinChanged);
    // The claim it must not make: this phone has never paired with anything at that address.
    expect(sayRefusal(refused.reason)).not.toContain("since you paired with it");
    // BEFORE THE SCREEN, and with nothing left behind.
    expect(d.redeems()).toBe(0);
    expect(pinnedCount()).toBe(0);
    expect(await env.profiles.list()).toHaveLength(0);
  });

  it("A PAIRED computer presenting another key IS the changed key — the twin sentence", async () => {
    const d = door("tok-1");
    const env = testEnv(d.fetchImpl);
    const probed = await probePairing(env, { origin: ORIGIN, pin: KEY });
    expect(probed.kind).toBe("offers");
    if (probed.kind !== "offers") return;
    const paired = await pairWithServer(env, { admission: probed.admission, token: "tok-1" });
    expect(paired.kind).toBe("paired");
    if (paired.kind !== "paired") return;
    paired.session.store.close();

    // The same computer, re-keyed: restored from a backup, or its data directory moved.
    d.state.mode = "handshake";
    const refused = await probePairing(env, { origin: ORIGIN, pin: KEY });
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") return;

    expect(sayRefusal(refused.reason)).toBe(Copy.pinChanged);
    expect(sayRefusal(refused.reason)).not.toBe(Copy.pairKeyMismatch);
    // AND THE STORED KEY SURVIVES IT: the refusal is not this probe's to un-pin.
    expect(native.pins.get(AT)).toBe(KEY);
  });

  it("the two sentences are distinct in every language — anti-vacuity for the split", () => {
    // A split whose halves render the same string is a split nobody can read. Both decks, because
    // a translation that reused one sentence for both would restore the collapse in German only.
    for (const [tag, deck] of Object.entries(DECKS)) {
      expect(deck.pairKeyMismatch.length, `${tag}: an empty sentence`).toBeGreaterThan(40);
      expect(deck.pairKeyMismatch, `${tag}: the two refusals say the same thing`)
        .not.toBe(deck.pinChanged);
    }
  });
});
