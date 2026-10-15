/**
 * What "a valid Sparkle update-signing public key" means, in one place. The EdDSA key committed in
 * `public/ohmail/Resources/Info.plist` (`SUPublicEDKey`) is the trust anchor of the macOS HANDOVER: an
 * already-installed Swift client installs the archive the appcast offers only if its detached signature
 * verifies against that key. The apps are unsigned, so this key is the whole of what stands between an
 * update feed and remote code execution — a missing or malformed one would mean trusting an unverified
 * download. The packaging script that used to refuse a bundle on this went out with the SwiftUI client;
 * what remains is the committed key and the guard over it in `test/macos-update-signing.test.ts`, the only
 * caller. `SUPublicEDKey` is base64 of the 32-byte Ed25519 public key (Sparkle's `generate_keys` encoding,
 * accepted by CryptoKit's `Curve25519.Signing.PublicKey(rawRepresentation:)`). */
export function isValidSparklePublicKey(value) {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (!s) return false;
  // base64 alphabet only, with 0–2 trailing '='.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  let buf;
  try {
    buf = Buffer.from(s, "base64");
  } catch {
    return false;
  }
  // Exactly 32 bytes — an Ed25519 public key. Buffer.from is lenient about junk, so re-encode and
  // require the canonical form to round-trip: that rejects both the wrong length and non-canonical
  // base64 that decoded to something plausible.
  if (buf.length !== 32) return false;
  return buf.toString("base64") === s;
}
