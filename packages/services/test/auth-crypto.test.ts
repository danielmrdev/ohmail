import { describe, it, expect } from "vitest";
import { scryptHasher, StaticKeyProvider } from "../src/index.js";

describe("scrypt password hashing", () => {
  it("hashes and verifies; rejects the wrong password; salts are unique", async () => {
    const h1 = await scryptHasher.hash("correct horse battery");
    const h2 = await scryptHasher.hash("correct horse battery");
    expect(h1).not.toEqual(h2);                        // random salt per hash
    expect(h1.startsWith("scrypt$")).toBe(true);
    expect(await scryptHasher.verify("correct horse battery", h1)).toBe(true);
    expect(await scryptHasher.verify("wrong", h1)).toBe(false);
  });

  it("verify returns false (does not throw) on a malformed stored hash", async () => {
    expect(await scryptHasher.verify("x", "not-a-scrypt-hash")).toBe(false);
  });
});

describe("KeyProvider envelope encryption", () => {
  it("round-trips through a wrapped DEK and carries the key version", async () => {
    const kp = StaticKeyProvider.fromSecret(Buffer.alloc(32, 9), 1);
    const { ciphertext, keyVersion } = await kp.encrypt("JBSWY3DPEHPK3PXP");
    expect(keyVersion).toBe(1);
    expect(ciphertext).not.toContain("JBSWY3DPEHPK3PXP");           // not stored in the clear
    expect(await kp.decrypt(ciphertext, keyVersion)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("two encryptions of the same plaintext differ (random per-secret DEK)", async () => {
    const kp = StaticKeyProvider.fromSecret(Buffer.alloc(32, 9), 1);
    const a = await kp.encrypt("secret");
    const b = await kp.encrypt("secret");
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it("AES-GCM authentication rejects tampered ciphertext", async () => {
    const kp = StaticKeyProvider.fromSecret(Buffer.alloc(32, 9), 1);
    const { ciphertext, keyVersion } = await kp.encrypt("secret");
    const env = JSON.parse(Buffer.from(ciphertext, "base64url").toString("utf8"));
    const ct = Buffer.from(env.ct, "base64url");
    ct[0] ^= 0xff;                                                  // flip a byte
    env.ct = ct.toString("base64url");
    const tampered = Buffer.from(JSON.stringify(env), "utf8").toString("base64url");
    await expect(kp.decrypt(tampered, keyVersion)).rejects.toThrow();
  });

  it("supports key rotation: v2 is current, v1 still decrypts old data", async () => {
    const v1 = StaticKeyProvider.fromSecret(Buffer.alloc(32, 1), 1);
    const old = await v1.encrypt("legacy");
    const rotated = new StaticKeyProvider({ 1: Buffer.alloc(32, 1), 2: Buffer.alloc(32, 2) });
    expect(rotated.currentKeyVersion()).toBe(2);
    expect(await rotated.decrypt(old.ciphertext, old.keyVersion)).toBe("legacy");   // old KEK still available
    const fresh = await rotated.encrypt("new");
    expect(fresh.keyVersion).toBe(2);
  });
});
