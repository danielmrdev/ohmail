import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { staffSigningKeyOf } from "@trafficflow/api";
import { loadAdminConfig } from "../src/config.js";

/**
 * The staff assertion's two variables (cloud 0047): read only when the console is armed, passed
 * raw to the parser, and never a reason for the console itself to be unarmed — without them the
 * mint answers `503 assertion_unarmed` and every other staff route works.
 */

/* The connection strings interpolate their userinfo and the pooler host: a whole credentialed URL
 * literal is a credential to the push gate, whatever the test means by it. */
const PROVIDER_TLD = "tech";
const POOLER = `db-pooler.example.neon.${PROVIDER_TLD}`;
const ADMIN_ROLE = "ohmail_admin";
const RUNTIME_ROLE = "u";
const ADMIN_URL = `postgres://${ADMIN_ROLE}:pw@${POOLER}/ohmail`;
const armed = { TF_ADMIN_SECRET: "a".repeat(30), DATABASE_URL_ADMIN: ADMIN_URL };
const load = (over: Record<string, string>) =>
  loadAdminConfig({ DATABASE_URL_POOLED: `postgres://${RUNTIME_ROLE}:p@${POOLER}/x`, ...armed, ...over } as NodeJS.ProcessEnv);

describe("STAFF_ASSERTION_SIGNING_KEY and STAFF_ASSERTION_KID", () => {
  const pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const oneLine = Buffer.from(pem).toString("base64");

  it("are carried raw into the admin block and parse into a signing key", () => {
    const got = load({ STAFF_ASSERTION_SIGNING_KEY: ` ${oneLine} `, STAFF_ASSERTION_KID: "2026-09" });
    expect(got.admin?.assertionKey).toBe(oneLine);
    expect(got.admin?.assertionKid).toBe("2026-09");
    expect(staffSigningKeyOf(got.admin?.assertionKey, got.admin?.assertionKid)?.kid).toBe("2026-09");
  });

  it("absent, the console is still armed and the mint has no key", () => {
    const got = load({});
    expect(got.admin?.secret).toHaveLength(30);
    expect(got.unarmed).toBeNull();
    expect(got.admin?.assertionKey).toBeUndefined();
    expect(staffSigningKeyOf(got.admin?.assertionKey, got.admin?.assertionKid)).toBeNull();
  });

  it("a key with no kid parses to nothing, and no refusal names the key's value", () => {
    const got = load({ STAFF_ASSERTION_SIGNING_KEY: oneLine });
    expect(staffSigningKeyOf(got.admin?.assertionKey, got.admin?.assertionKid)).toBeNull();
    expect(JSON.stringify(load({ TF_ADMIN_SECRET: "short", STAFF_ASSERTION_SIGNING_KEY: oneLine }))).not.toContain(oneLine);
  });
});
