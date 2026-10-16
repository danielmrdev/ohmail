/**
 * A SOCKET FAILURE LEAVES THE BRIDGE AS AN ERROR WITH ITS ERRNO (PHONE-NATIVE-SOCKET-ERROR-IS-A-STRING).
 *
 * Both natives emit the failure as a bare string: Android `putString("error", e.getMessage())`,
 * iOS `@"error" : msg`. The double below emits exactly that, in each platform's own words, and
 * the verdicts are the send route's own classifier and imapflow's strict-mode `_connId` stamp.
 */
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { mailServerUnreachable } from "../../../packages/services/src/send-service.js";

const require_ = createRequire(import.meta.url);
const SHIM = "../src/engine/shims/net.js";
const TLS_SHIM = "../src/engine/shims/tls.js";

/** The platform socket, reduced to what the bridge reads; `fail` emits what the native emits. */
class FakeNative extends EventEmitter {
  destroyed = false;
  fail(what: unknown): void { this.emit("error", what); }
  getPeerCertificate(): Promise<Record<string, unknown>> { return new Promise(() => undefined); }
  destroy(): void { this.destroyed = true; }
  end(): void { /* nothing */ }
  pause(): void { /* nothing */ }
  resume(): void { /* nothing */ }
  write(): boolean { return true; }
}

interface Bridge extends EventEmitter { native: FakeNative }
interface Shim { connect(options: unknown): Bridge }

const restore: Array<() => void> = [];
afterEach(() => { while (restore.length > 0) restore.pop()!(); });

/** The shim over the double — `socket-bridge-write-after-close.test.ts`'s `Module._load` seam. */
function loadShims(): { net: Shim; tls: Shim } {
  const Module = require_("node:module") as { _load(req: string, parent: unknown, isMain: boolean): unknown };
  const original = Module._load;
  Module._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === "react-native-tcp-socket") {
      return {
        createConnection: () => new FakeNative(), connectTLS: () => new FakeNative(),
        TLSSocket: class { constructor() { return new FakeNative(); } },
        isIP: () => 0, isIPv4: () => false, isIPv6: () => false,
      };
    }
    return original.call(this, request, parent, isMain);
  };
  restore.push(() => { Module._load = original; });
  const cache = (require_ as unknown as { cache: Record<string, unknown> }).cache;
  for (const key of Object.keys(cache)) if (key.includes("/engine/shims/")) delete cache[key];
  return { net: require_(SHIM) as Shim, tls: require_(TLS_SHIM) as Shim };
}

/** What the bridge emitted when its native failed with `raw`. */
function emitted(shim: Shim, raw: unknown): unknown {
  const bridge = shim.connect({ host: "mail.example.invalid", port: 587 });
  let seen: unknown = "nothing emitted";
  bridge.on("error", (e: unknown) => { seen = e; });
  bridge.native.fail(raw);
  return seen;
}

/* Each platform's words for the failures the send route reads as "could not be reached". */
const PLATFORM_WORDS: Array<[string, string, string]> = [
  ["android refused", "failed to connect to mail.example.invalid/192.0.2.7 (port 587) from /10.0.2.16 (port 41230) after 10000ms: isConnected failed: ECONNREFUSED (Connection refused)", "ECONNREFUSED"],
  ["android no name", "Unable to resolve host \"mail.example.invalid\": No address associated with hostname", "ENOTFOUND"],
  ["android connect timeout", "failed to connect to mail.example.invalid/192.0.2.7 (port 587) from /10.0.2.16 (port 41230) after 10000ms", "ETIMEDOUT"],
  ["android reset", "recvfrom failed: ECONNRESET (Connection reset by peer)", "ECONNRESET"],
  ["ios refused", "Connection refused", "ECONNREFUSED"],
  ["ios no name", "nodename nor servname provided, or not known", "ENOTFOUND"],
  ["ios timeout", "Operation timed out", "ETIMEDOUT"],
  ["ios no route", "No route to host", "EHOSTUNREACH"],
];

describe("a socket failure the platform reports as a string", () => {
  it.each(PLATFORM_WORDS)("%s: an Error carrying the errno, which the send route reads as unreachable", (_what, words, code) => {
    const { net } = loadShims();
    const err = emitted(net, words) as Error & { code?: string; _connId?: string };
    expect(err, "the bridge forwarded the platform's string").toBeInstanceOf(Error);
    expect(err.message).toBe(words);
    expect(err.code).toBe(code);
    expect(mailServerUnreachable(err)).toBe(true);
    // imapflow stamps its connection id on the error in strict mode; a primitive throws there.
    expect(() => { "use strict"; err._connId = "c1"; }).not.toThrow();
  });

  it("a sentence that names no errno is an Error with no guessed code", () => {
    const { net } = loadShims();
    const err = emitted(net, "Socket closed by remote peer") as Error & { code?: string };
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBeUndefined();
    expect(mailServerUnreachable(err)).toBe(false);
  });

  it("an empty report still becomes an Error that says so", () => {
    const { net } = loadShims();
    const err = emitted(net, "") as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message.length).toBeGreaterThan(0);
  });

  it("an Error the platform already built passes through as itself", () => {
    const { net } = loadShims();
    const given = Object.assign(new Error("boom"), { code: "EPIPE" });
    expect(emitted(net, given)).toBe(given);
  });

  it("the TLS shim's certificate refusal still names itself over the normalised error", () => {
    const { tls } = loadShims();
    const err = emitted(tls, "java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.") as Error & {
      tlsFailed?: boolean; certificateRefused?: boolean;
    };
    expect(err).toBeInstanceOf(Error);
    expect(err.certificateRefused).toBe(true);
    expect(err.tlsFailed).toBe(true);
  });
});
