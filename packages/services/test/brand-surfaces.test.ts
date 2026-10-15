import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_AUTH_CONFIG, makeAuthConfig } from "../src/auth/config.js";

/**
 * THE BRAND, ON THE SURFACES NOBODY LOOKS AT.
 *
 * The project's design notes: the product is **ohmail**, never anything else, "including title tags". The two
 * worst offenders were invisible in the app and permanent everywhere else:
 *
 *  · `totpIssuer` is baked into the `otpauth://` URI at enrollment and becomes the name in
 *    somebody's authenticator app FOR EVER. It said "TrafficFlow Mail" — the pre-rename
 *    product name, which appears nowhere in the product a person actually uses.
 *  · `rpName` is what the OS passkey sheet shows: "Save a passkey for …".
 *
 * Both were safe to change and neither was: `rpName` is display-only (WebAuthn binds `rp.id`
 * via `rpIdHash`, never `rp.name` — `schema.ts` persists no rp name at all), and the issuer is
 * only read when a NEW enrollment mints its URI. Existing authenticator entries keep the label
 * they were created with, which is the most that can be done without asking people to re-enrol.
 *
 * The company is TrafficFlow GmbH and that is correct in legal copy. It is not the name of the
 * thing being signed into.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));

describe("the brand on auth surfaces", () => {
  it("the authenticator app says ohmail", () => {
    expect(DEFAULT_AUTH_CONFIG.totpIssuer).toBe("ohmail");
  });

  it("the OS passkey prompt says ohmail — and rpID is NOT touched", () => {
    const cfg = makeAuthConfig({ rpID: "ohmail.app", origin: "https://ohmail.app" });
    expect(cfg.rpName).toBe("ohmail");
    // The one that MUST NOT move: rpIdHash is baked into every stored credential, so a change
    // here silently invalidates every passkey ever enrolled, with no migration possible.
    expect(cfg.rpID).toBe("ohmail.app");
  });

  it("no shipped source names the product after the company, in ANY spelling", () => {
    // This guard used to look for the literal `"TrafficFlow Mail"`, with a space. Two live
    // surfaces were named after the company in spellings that do not contain it, and both
    // passed for months:
    //
    //   · `TrafficFlowMail-ImageProxy/1.0` — the `User-Agent` on every proxied remote image.
    //     It leaves our network. A sender's analytics logs it.
    //   · `TrafficFlow.app` — the macOS entry in a person's own device list, written into
    //     `devices.label` at sign-in.
    //
    // So the rule is now the SHAPE of the mistake and not one instance of it: the token
    // `TrafficFlow` may only appear as `TrafficFlow GmbH`, the legal name of the company, which
    // is correct in imprint, privacy and email footers. Anything else is the product wearing
    // the company's name.
    const roots = [
      join(HERE, "..", "src"),
      join(HERE, "..", "..", "core", "src"),
      join(HERE, "..", "..", "api", "src"),
    ];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(e)) continue;
        const src = readFileSync(full, "utf8");
        for (const [i, line] of src.split("\n").entries()) {
          // Prose ABOUT the rename is allowed — a comment explaining why the name changed is
          // exactly the documentation that stops someone changing it back. Code is not.
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
          // `@trafficflow/*` package specifiers are lower-case and are not a brand surface.
          if (!/TrafficFlow(?! GmbH)/.test(line)) continue;
          offenders.push(`${full.replace(HERE, "")}:${i + 1}`);
        }
      }
    };
    for (const r of roots) walk(r);
    expect(offenders, "the product is ohmail; TrafficFlow GmbH is the company").toEqual([]);
  });

  it("the device list and the image proxy say ohmail", () => {
    // The two the shape-rule above was written for, pinned by VALUE as well — a grep proves the
    // old name is gone, not that the new one is right. The device label moved with `establish`
    // into the carved session-lifecycle module (Phase 3), and since the platform-qualified
    // kinds it is a MAP (`AUTO_MINT_DEVICE_LABELS`) — the desktop family's labels are the only
    // auto-minted ones (a plain web sign-in owns no device row; a phone's label is the pairing
    // mint's own), so the pin follows each label the map can write.
    const authSrc = readFileSync(join(HERE, "..", "src", "auth", "session-lifecycle.ts"), "utf8");
    expect(authSrc).toMatch(/"ohmail for Mac"/);
    expect(authSrc).toMatch(/"ohmail for Linux"/);
    expect(authSrc).toMatch(/"ohmail for Windows"/);

    const privacySrc = readFileSync(join(HERE, "..", "src", "privacy-service.ts"), "utf8");
    expect(privacySrc).toMatch(/"user-agent": "ohmail-ImageProxy\/1\.0"/);
  });
});
