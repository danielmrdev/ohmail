import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isoCBOR, cose } from "@simplewebauthn/server/helpers";
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from "@simplewebauthn/server";

const sha256 = (b: Uint8Array | string): Buffer => createHash("sha256").update(b).digest();
const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

/**
 * A deterministic in-test software WebAuthn authenticator (fixed EC P-256 keypair
 * per instance). It produces the exact `RegistrationResponseJSON` /
 * `AuthenticationResponseJSON` shapes the real browser emits, so the server's full
 * `@simplewebauthn/server` verification path (origin/RP-ID, attestation, ES256
 * signature, signature counter) runs unmodified — the ceremony is simulated, the
 * verification is real. No network, fully hermetic.
 */
export class SoftwareAuthenticator {
  private readonly privateKey: KeyObject;
  private readonly coseKey: Uint8Array;
  readonly credentialId: Buffer;
  private readonly aaguid = Buffer.alloc(16, 0);
  counter = 0;

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    this.credentialId = randomBytes(16);
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const m = new Map<number, number | Uint8Array>();
    m.set(cose.COSEKEYS.kty, cose.COSEKTY.EC2);
    m.set(cose.COSEKEYS.alg, cose.COSEALG.ES256);
    m.set(cose.COSEKEYS.crv, cose.COSECRV.P256);
    m.set(cose.COSEKEYS.x, new Uint8Array(Buffer.from(jwk.x, "base64url")));
    m.set(cose.COSEKEYS.y, new Uint8Array(Buffer.from(jwk.y, "base64url")));
    this.coseKey = isoCBOR.encode(m as never);
  }

  private authData(rpID: string, flags: number, counter: number, attested: boolean): Buffer {
    const rpIdHash = sha256(rpID);
    const flagsB = Buffer.from([flags]);
    const countB = Buffer.alloc(4);
    countB.writeUInt32BE(counter >>> 0, 0);
    const head = [rpIdHash, flagsB, countB];
    if (attested) {
      const credIdLen = Buffer.alloc(2);
      credIdLen.writeUInt16BE(this.credentialId.length, 0);
      head.push(this.aaguid, credIdLen, this.credentialId, Buffer.from(this.coseKey));
    }
    return Buffer.concat(head);
  }

  /** Produce a registration attestation (fmt "none"). */
  register(opts: { rpID: string; challenge: string; origin: string }): RegistrationResponseJSON {
    const clientData = JSON.stringify({
      type: "webauthn.create", challenge: opts.challenge, origin: opts.origin, crossOrigin: false,
    });
    const authData = this.authData(opts.rpID, FLAG_UP | FLAG_UV | FLAG_AT, this.counter, true);
    const attObj = new Map<string, unknown>();
    attObj.set("fmt", "none");
    attObj.set("attStmt", new Map());
    attObj.set("authData", new Uint8Array(authData));
    const attestationObject = isoCBOR.encode(attObj as never);

    const id = b64u(this.credentialId);
    return {
      id, rawId: id, type: "public-key",
      response: {
        clientDataJSON: b64u(Buffer.from(clientData, "utf8")),
        attestationObject: b64u(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    } as RegistrationResponseJSON;
  }

  /**
   * Produce an assertion. Increments the internal counter unless `counter` is
   * given — pass a stale/lower value to simulate a cloned authenticator (drives
   * the signature-counter-regression test).
   */
  assert(opts: { rpID: string; challenge: string; origin: string; counter?: number }): AuthenticationResponseJSON {
    const useCounter = opts.counter ?? ++this.counter;
    const clientData = JSON.stringify({
      type: "webauthn.get", challenge: opts.challenge, origin: opts.origin, crossOrigin: false,
    });
    const authData = this.authData(opts.rpID, FLAG_UP | FLAG_UV, useCounter, false);
    const clientDataHash = sha256(Buffer.from(clientData, "utf8"));
    const sigBase = Buffer.concat([authData, clientDataHash]);
    const signature = sign("sha256", sigBase, this.privateKey); // DER-encoded ES256

    const id = b64u(this.credentialId);
    return {
      id, rawId: id, type: "public-key",
      response: {
        clientDataJSON: b64u(Buffer.from(clientData, "utf8")),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: undefined,
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    } as AuthenticationResponseJSON;
  }
}
