import {
  createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify,
} from "node:crypto";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE SUBSCRIBER SIDE — a device, for the guards. NOT SHIPPED.
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `packages/core/src/net/webpush.ts` only ever encrypts: the server is one end of RFC 8291 and
 * there is no production code path that decrypts a wake, because the thing that decrypts one is a
 * phone. So the inverse lives here, in a test file, rather than being exported from `core` as a
 * function nothing calls — a decryptor in the shipped module would be dead code with a security
 * surface, and "it is there for the tests" is how a module grows an arm nobody maintains.
 *
 * It is a SEPARATE IMPLEMENTATION on purpose, written from the specification rather than by calling
 * back into the module under test, which is what makes a round-trip assertion worth anything. On
 * its own that would only prove the two halves agree with each other — so the anchor is
 * `webpush.test.ts`'s first assertion: RFC 8291 §5's published example, byte for byte, through the
 * shipped encryptor. The vector fixes the forward direction against the specification; this file
 * then makes every other test able to read a real payload back.
 *
 * Used by `packages/core/test/webpush.test.ts` and by `apps/worker/test/push-wake-*.test.ts`,
 * which is the reason it is a module and not a helper pasted into each.
 */

/** A synthetic device: what a UnifiedPush connector would hand the app, plus the secret it keeps. */
export interface FakeSubscriber {
  /** Base64url uncompressed P-256 point — the `p256dh` a registration carries. */
  p256dh: string;
  /** Base64url 16-byte authentication secret — the `auth` a registration carries. */
  auth: string;
  /** The private half. A real device never discloses this; a test needs it to read the payload. */
  privateKey: Buffer;
  authSecret: Buffer;
}

/** Left-pad a scalar to the curve's 32 bytes. See {@link makeSubscriber}. */
function pad32(b: Buffer): Buffer {
  if (b.length === 32) return b;
  const out = Buffer.alloc(32);
  b.copy(out, 32 - b.length);
  return out;
}

/** Mint one. Fresh keys per call, so no test can depend on another's material. */
export function makeSubscriber(): FakeSubscriber {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const authSecret = randomBytes(16);
  return {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: authSecret.toString("base64url"),
    // PADDED to 32 bytes. `getPrivateKey()` strips leading zero bytes, so about one key in 256
    // comes back at 31 — see `padScalar` in the module under test. `setPrivateKey` tolerates the
    // short form, but a test fixture that is sometimes 31 bytes is a fixture that sometimes tests
    // something else, and this helper's value also reaches callers that assert lengths.
    privateKey: pad32(ecdh.getPrivateKey()),
    authSecret,
  };
}

/**
 * Open an `aes128gcm` record the way a device does: read the header for the salt and the sender's
 * ephemeral public key, run ECDH with the device's own private key, derive, decrypt, strip padding.
 *
 * Throws on a record that does not authenticate, which is the assertion that matters most in the
 * negative tests — a body encrypted to the WRONG device must not merely decode to something else,
 * it must fail the GCM tag.
 */
export function openAes128Gcm(record: Buffer, sub: FakeSubscriber): Buffer {
  if (record.length < 22) throw new Error("record is too short to hold a header");
  const salt = record.subarray(0, 16);
  const recordSize = record.readUInt32BE(16);
  const idLen = record[20]!;
  const asPublic = record.subarray(21, 21 + idLen);
  const ciphertext = record.subarray(21 + idLen);
  if (idLen !== 65) throw new Error(`keyid is ${idLen} bytes, expected an uncompressed point (65)`);
  if (recordSize < 18) throw new Error(`record size ${recordSize} is below RFC 8188's floor`);

  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(sub.privateKey);
  const uaPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(asPublic);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, sub.authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync(
    "sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16,
  ));
  const nonce = Buffer.from(hkdfSync(
    "sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12,
  ));

  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);

  // RFC 8188 §2: the plaintext ends with a delimiter (0x02 on the last record, 0x01 otherwise)
  // followed by zero padding. Walk back over the zeros and require the delimiter — a record whose
  // last non-zero byte is neither is malformed, and silently trimming it would hide that.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0x00) end -= 1;
  if (end < 0) throw new Error("plaintext is all padding");
  if (padded[end] !== 0x02 && padded[end] !== 0x01) {
    throw new Error(`no padding delimiter (last non-zero byte is 0x${padded[end]!.toString(16)})`);
  }
  return padded.subarray(0, end);
}

/**
 * ── THE VAPID SIDE: verify a `vapid t=…, k=…` header the way a push service does ───────────────
 *
 * Deliberately parses the header rather than being handed the parts, because the header's SHAPE is
 * part of the contract: RFC 8292 §3 defines `Authorization: vapid t=<JWT>, k=<base64url key>`, and
 * a token that verifies inside a malformed header is not a header any push service accepts.
 */
export interface ParsedVapid {
  jwt: string;
  /** The `k=` field: the public key the signature must verify against. */
  k: string;
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  /** Does the signature verify against the key in `k`? Computed, not assumed. */
  verified: boolean;
}

export function parseVapidAuthorization(value: string): ParsedVapid {
  const m = /^vapid t=([A-Za-z0-9_.-]+), k=([A-Za-z0-9_-]+)$/.exec(value);
  if (!m) throw new Error(`not an RFC 8292 vapid header: ${JSON.stringify(value)}`);
  const [, jwt, k] = m as unknown as [string, string, string];
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error(`the token has ${parts.length} parts, expected 3`);
  const [h, c, s] = parts as [string, string, string];

  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as Record<string, unknown>;
  const claims = JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as Record<string, unknown>;

  // Verified from the `k=` field alone — the same position a push service is in. Built as a JWK
  // from the raw point, so nothing here depends on how the signer happened to hold its key.
  const raw = Buffer.from(k, "base64url");
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error(`k= is ${raw.length} bytes, expected a 65-byte uncompressed point`);
  }
  const key = createPublicKey({
    key: {
      kty: "EC", crv: "P-256",
      x: raw.subarray(1, 33).toString("base64url"),
      y: raw.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
  const verified = verify(
    "sha256", Buffer.from(`${h}.${c}`, "utf8"),
    // RAW r‖s, which is what JOSE ES256 is. Verifying with the default (DER) would reject a
    // correct token, so this test would be red on working code — the shape that gets a guard
    // weakened until it is green.
    { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"),
  );
  return { jwt, k, header, claims, verified };
}
