import { describe, it, expect } from "vitest";
import { randomBytes, scrypt, scryptSync } from "node:crypto";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { CURRENT_COST, SCRYPT_MAXMEM, makeScryptHasher, scryptHasher, type ScryptCost } from "../src/auth/crypto.js";

/**
 * THE PASSWORD HASH COST (audit row scrypt-default-cost): new hashes at N = 2^17 with the cost in
 * the stored string, the original N = 2^14 form still verifying, and EVERY verify paying one
 * derivation at each cost so a not-yet-rehashed account is no faster than the decoy.
 */
const legacyHash = async (password: string): Promise<string> => {
  const salt = randomBytes(16);
  const derived = (await promisify(scrypt)(password, salt, 64)) as Buffer;
  return `scrypt$64$${salt.toString("base64url")}$${derived.toString("base64url")}`;
};

describe("scrypt cost", () => {
  it("stamps new hashes n17r8p1, still verifies the original form, and says which to rehash", async () => {
    const fresh = await scryptHasher.hash("pw");
    expect(fresh.split("$")[4]).toBe("n17r8p1");
    expect(await scryptHasher.verify("pw", fresh)).toBe(true);
    expect(await scryptHasher.verify("nope", fresh)).toBe(false);
    expect(scryptHasher.needsRehash!(fresh)).toBe(false);
    const old = await legacyHash("pw");
    expect(await scryptHasher.verify("pw", old)).toBe(true);
    expect(scryptHasher.needsRehash!(old)).toBe(true);
  });

  it("refuses a stored cost above the current one, whatever the password", async () => {
    const fresh = await scryptHasher.hash("pw");
    for (const tag of ["n18r8p1", "n17r9p1", "n17r8p2", "n99r8p1", "garbage"]) {
      expect(await scryptHasher.verify("pw", fresh.replace(/n17r8p1$/, tag)), tag).toBe(false);
    }
  });

  it("every verify costs one derivation at each cost — current hash, original hash, decoy, garbage", async () => {
    const seen: ScryptCost[][] = [];
    let current: ScryptCost[] = [];
    const real = promisify(scrypt) as (p: string, s: Buffer | string, k: number, o: object) => Promise<Buffer>;
    const counting = makeScryptHasher({ derive: async (p, s, k, c) => {
      current.push(c);
      return real(p, s, k, { N: 2 ** c.ln, r: c.r, p: c.p, maxmem: SCRYPT_MAXMEM });
    } });
    const inputs = [await scryptHasher.hash("pw"), await legacyHash("pw"), "scrypt$64$x$y$n30r8p1", "not a hash"];
    for (const stored of inputs) {
      current = [];
      await counting.verify("wrong", stored);
      seen.push(current);
    }
    for (const costs of seen) {
      expect(costs.map((c) => c.ln).sort((a, b) => a - b), JSON.stringify(seen)).toEqual([14, 17]);
    }
  });

  it("the maxmem option is load-bearing: Node's default refuses the current cost", () => {
    expect(() => scryptSync("pw", "salt", 64, { N: 2 ** CURRENT_COST.ln, r: CURRENT_COST.r, p: CURRENT_COST.p }))
      .toThrow(/memory/i);
    expect(scryptSync("pw", "salt", 64, { N: 2 ** CURRENT_COST.ln, r: 8, p: 1, maxmem: SCRYPT_MAXMEM }).length).toBe(64);
  });

  it("the API function's memory covers the threadpool's concurrent derivations with room to spare", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const vercel = JSON.parse(readFileSync(join(here, "..", "..", "..", "apps", "api-vercel", "vercel.json"), "utf8")) as {
      functions?: Record<string, { memory?: number }>;
    };
    const memory = Object.values(vercel.functions ?? {}).map((f) => f.memory ?? 0);
    expect(memory.length, "no pinned function memory").toBeGreaterThan(0);
    // UV_THREADPOOL_SIZE (default 4) x 128 MiB per derivation, doubled for the rest of the process.
    const perDerivationMiB = (128 * CURRENT_COST.r * 2 ** CURRENT_COST.ln) / (1024 * 1024);
    for (const mb of memory) expect(mb).toBeGreaterThanOrEqual(4 * perDerivationMiB * 2);
  });
});
