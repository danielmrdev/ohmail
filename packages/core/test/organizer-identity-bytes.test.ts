import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveCloudInstallId, organizerEnvironment, headerSafeIdentity } from "../src/organizer-install.js";
import { formatClaim } from "../src/adapters/organizer-lease.js";

/**
 * ═══ ONE IDENTITY, ONE SPELLING, ALL THE WAY THROUGH ══════════════════════════════════════════
 *
 * The install id is compared EXACTLY — a release matches on it, a claim removal matches on it, and
 * the row records it. So every place that produces it has to produce the same bytes, and the
 * mailbox is the master: the bytes the claim carries are the bytes that count.
 *
 * `formatClaim` writes the id through `headerSafe`, which collapses CR/LF to a space and trims,
 * because a claim is an IMAP message and a newline in a header would be a header injection. That
 * transformation was applied at SERIALIZATION only, so an identity resolved with surrounding or
 * interior whitespace went into the folder in one form and stayed in config in another. Two
 * rounds of this were fixed one case at a time — first a blank override, then a padded one — and
 * both were the same defect: a value normalised in one place and compared in another.
 *
 * It is normalised at the source now. This file is what keeps the two normalizations identical:
 * `organizer-lease` imports from `organizer-install`, not the reverse, so `headerSafeIdentity` is
 * deliberately a copy of `headerSafe`'s rule rather than a shared import — and a copy needs a test
 * that fails when the copies diverge.
 */

const ROOT = [resolve(__dirname, "..", "..", ".."), resolve(__dirname, "..", "..")]
  .find((r) => existsSync(resolve(r, "packages/core/src/organizer-install.ts")))!;

/** The awkward values, each of which broke a comparison at some point. */
const AWKWARD = [
  " cloud-a ",
  "\tcloud-a\t",
  "cloud\r\na",
  "cloud\na",
  "  ",
  "\r\n",
];

describe("the resolved identity is the identity the claim carries", () => {
  for (const raw of AWKWARD) {
    it(`survives serialization unchanged: ${JSON.stringify(raw)}`, () => {
      const id = resolveCloudInstallId({ TF_ORGANIZER_INSTALL_ID: raw, TF_ENV: "production" });
      const claim = formatClaim({
        authorizedAt: null, capabilities: [], installId: id, kind: "cloud",
        displayName: "Cloud", heartbeat: new Date(), claimedAt: new Date(), nonce: "n1",
      });
      const line = claim.split(/\r?\n/).find((l) => l.toLowerCase().startsWith("x-ohmail-install"));
      expect(line, "the claim carries no install-id header — this test cannot see the bytes")
        .toBeTruthy();
      const written = line!.slice(line!.indexOf(":") + 1).trim();
      expect(written,
        `the identity resolved to ${JSON.stringify(id)} and the mailbox will hold `
          + `${JSON.stringify(written)} — a comparison between them is exact and would fail`)
        .toBe(id);
    });
  }

  it("an environment name with whitespace cannot smuggle it into the identity", () => {
    expect(organizerEnvironment({ TF_ENV: " staging " })).toBe("staging");
    expect(organizerEnvironment({ TF_ENV: "stag\ning" })).toBe("stag ing");
    expect(resolveCloudInstallId({ TF_ENV: " staging " })).toBe("ohmail-cloud:staging");
  });

  it("an override that is only whitespace is no override at all", () => {
    expect(resolveCloudInstallId({ TF_ORGANIZER_INSTALL_ID: "  ", TF_ENV: "production" }))
      .toBe("ohmail-cloud:production");
    expect(resolveCloudInstallId({ TF_ORGANIZER_INSTALL_ID: "\r\n", TF_ENV: "production" }))
      .toBe("ohmail-cloud:production");
  });

  /**
   * THE TWO COPIES OF THE RULE, COMPARED AS TEXT.
   *
   * If `headerSafe` grows a case — another control character, a length cap — and
   * `headerSafeIdentity` does not, identities start differing from their claims again and every
   * test above still passes, because they exercise the values we thought of. This reads both
   * bodies and fails when they stop saying the same thing.
   */
  it("headerSafeIdentity still matches headerSafe's rule", () => {
    const lease = readFileSync(resolve(ROOT, "packages/core/src/adapters/organizer-lease.ts"), "utf8");
    const install = readFileSync(resolve(ROOT, "packages/core/src/organizer-install.ts"), "utf8");
    const bodyOf = (src: string, name: string): string => {
      const at = src.indexOf(`function ${name}(`);
      expect(at, `${name} is gone — this guard cannot see the rule any more`).toBeGreaterThan(-1);
      const open = src.indexOf("{", at);
      const close = src.indexOf("}", open);
      return src.slice(open + 1, close).replace(/\s+/g, " ").trim();
    };
    expect(bodyOf(install, "headerSafeIdentity").replace(/^return /, ""),
      "the two normalizations have diverged, so a resolved identity no longer matches its claim")
      .toBe(bodyOf(lease, "headerSafe").replace(/^return /, ""));
  });
});
