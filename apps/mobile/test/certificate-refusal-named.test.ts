import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A CERTIFICATE THE PLATFORM REFUSED IS SAID AS ONE — the shim's half, on the shapes both native
 * halves produce. The platform socket reports a failed handshake as a bare message; before this the
 * implicit-TLS dial rejected with no flag and the engine read it as an outage. The door's half runs
 * over the artifact in `standalone-dial-refusal.test.ts`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const TLS_SHIM = join(here, "../src/engine/shims/tls.js");

type Refusal = Error & { tlsFailed?: boolean; certificateRefused?: boolean };
type Shim = {
  connect: (o: Record<string, unknown>) => EventEmitter;
  handshakeRefusal: (e: unknown) => unknown;
};

/** The shim with the native package answered by one emitter this file drives. */
function loadShim(): { tls: Shim; native: () => EventEmitter } {
  let last: EventEmitter | null = null;
  const fake = (): EventEmitter => {
    const e = new EventEmitter() as EventEmitter & Record<string, unknown>;
    Object.assign(e, { write: () => true, destroy: () => undefined, pause: () => undefined, resume: () => undefined });
    last = e;
    return e;
  };
  const Module = req("node:module") as { _load(r: string, p: unknown, m: boolean): unknown };
  const original = Module._load;
  Module._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === "react-native-tcp-socket") {
      return { createConnection: fake, connectTLS: fake, TLSSocket: class {}, isIP: () => 0, isIPv4: () => false, isIPv6: () => false };
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    const cache = (req as unknown as { cache: Record<string, unknown> }).cache;
    for (const key of Object.keys(cache)) {
      if (key.includes("engine/shims/net.js") || key.includes("engine/shims/tls.js")) delete cache[key];
    }
    return { tls: req(TLS_SHIM) as Shim, native: () => last! };
  } finally { Module._load = original; }
}

/** What the bridge emitted for one native error, before or after the handshake completed. */
function emitted(err: unknown, afterHandshake: boolean): unknown {
  const { tls, native } = loadShim();
  const bridge = tls.connect({ host: "mail.example.test", port: 993 });
  const got: unknown[] = [];
  bridge.on("error", (e) => got.push(e));
  if (afterHandshake) native().emit("secureConnect");
  native().emit("error", err);
  return got[0];
}

describe("the TLS shim names a refused certificate", () => {
  const cases: Array<[string, string]> = [
    ["Android, no trust anchor", "java.security.cert.CertPathValidatorException: Trust anchor for certification path not found."],
    ["Android, a name the certificate does not carry", "Hostname mail.example.test not verified:\n    certificate: sha256/AAAA"],
    ["iOS, an invalid chain", "The operation couldn’t be completed. (kCFStreamErrorDomainSSL error -9807.)"],
    ["iOS, an expired certificate", "The operation couldn’t be completed. (kCFStreamErrorDomainSSL error -9814.)"],
  ];
  for (const [what, message] of cases) {
    it(`before the handshake: ${what}`, () => {
      const e = emitted(message, false) as Refusal;
      expect(e).toBeInstanceOf(Error);
      expect(e.message).toBe(message);
      expect(e.tlsFailed).toBe(true);
      expect(e.certificateRefused).toBe(true);
    });
  }

  it("node's own refusal (the suite's stand-in) keeps its object and gains the two flags", () => {
    const err = Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    const e = emitted(err, false) as Refusal;
    expect(e).toBe(err);
    expect(e.certificateRefused).toBe(true);
  });

  /* The platform's string arrives as an Error carrying its message and errno (`net.js#nativeError`,
     PHONE-NATIVE-SOCKET-ERROR-IS-A-STRING); what these controls hold is that no certificate is read into it. */
  it("CONTROL — a refused connect or a closed handshake is an outage, never a certificate", () => {
    for (const [message, code] of [
      ["failed to connect to /10.0.2.2 (port 993) from /:: (port 0): connect failed: ECONNREFUSED (Connection refused)", "ECONNREFUSED"],
      ["connect timed out", "ETIMEDOUT"],
      ["The operation couldn’t be completed. (kCFStreamErrorDomainSSL error -9806.)", undefined],
    ] as const) {
      const e = emitted(message, false) as Refusal & { code?: string };
      expect(e, message).toBeInstanceOf(Error);
      expect(e.message).toBe(message);
      expect(e.code).toBe(code);
      expect(e.certificateRefused, message).toBeUndefined();
      expect(e.tlsFailed, message).toBeUndefined();
    }
  });

  it("CONTROL — after the handshake nothing is re-read as a certificate", () => {
    const message = "java.security.cert.CertificateException: a late error naming a certificate";
    const e = emitted(message, true) as Refusal;
    expect(e.message).toBe(message);
    expect(e.certificateRefused).toBeUndefined();
    expect(e.tlsFailed).toBeUndefined();
  });
});
