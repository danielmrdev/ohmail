import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PUBLIC CLIENT ID REACHES BOTH SERVICES — asserted, because half of it works
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `MS_DEVICE_CLIENT_ID` arms the device-code sign-in, which is how a self-hosted server connects a
 * Microsoft 365 mailbox without its operator registering an Entra application of their own. Two
 * processes need it and only one of them is obvious:
 *
 *  · The **api** runs the ceremony — it mints the device code and polls for the approval.
 *  · The **organizer** renews the access afterwards, for as long as the mailbox exists.
 *
 * ── WHY THIS IS A TEST AND NOT A COMMENT ─────────────────────────────────────────────────────
 *
 * Set on the api alone, EVERYTHING VISIBLE WORKS. The settings pane offers the door, the code
 * appears, the person approves it at Microsoft, the mailbox is stored, and the first sync runs. It
 * then stops about an hour later — and it stops SILENTLY, in the worst available way:
 *
 * A refresh token is only renewable by the application that obtained it. The organizer, holding no
 * public client id, presents the confidential registration (or nothing at all). Microsoft answers
 * `invalid_client`, and `refreshAccessToken` maps a rejected client to `OAuthClientRefusedError`
 * **deliberately** — a rejected client is not the mailbox's fault, so nothing is quarantined and
 * the sync strip can only say it could not tell why. The true cause is one line missing from one
 * compose service.
 *
 * That is the same shape as the failure `selfhost-vapid-parity.test.ts` exists for, and the same
 * shape `TF_PUSH_ALLOW_PRIVATE` had already drifted into before anything was checking: a variable
 * that must appear in more than one place, whose omission produces no error anywhere.
 *
 * ── AND WHY NOT EXTEND THE EXISTING PARITY FILE ──────────────────────────────────────────────
 *
 * `selfhost-vapid-parity.test.ts`'s own header records the lesson taken last time — *"check the
 * thing in front of you rather than write a scanner general enough to cover the next variable
 * too"*. Its subject is the wake-signing keypair, including a load-bearing ABSENCE (the private key
 * must reach the organizer ONLY) that has nothing to do with this variable. This one's subject is a
 * PRESENCE in two places. Folding them together would put two unrelated invariants behind one
 * file's name, and `selfhost-allowance-parity.test.ts` derives its list from an anchored
 * `TF_\w*ALLOW_PRIVATE` regex that `MS_DEVICE_*` matches none of.
 *
 * The compose parser is duplicated from the VAPID file for that same reason: this file must stay
 * red when that one is deleted or rewritten.
 */

const r = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const COMPOSE = r("../deploy/selfhost/docker-compose.yml");
const ENV_EXAMPLE = r("../deploy/selfhost/.env.example");
const SERVER_CONFIG = r("../apps/server/src/config.ts");
const WORKER_CONFIG = r("../apps/worker/src/config.ts");
const CORE_DEVICE = r("../packages/core/src/oauth/microsoft-device.ts");

/**
 * The environment ASSIGNMENTS of one compose service, as name → value text.
 *
 * Parsed by indentation rather than with a YAML library, deliberately, and for the reason the VAPID
 * parity file gives: the property under test is about the text an operator and a reviewer read, and
 * a boundary found by indentation is what makes a variable MOVED between services visible.
 */
function envAssignments(service: string): Map<string, string> {
  const lines = COMPOSE.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === `  ${service}:`);
  expect(start, `the compose file has no \`${service}\` service`).toBeGreaterThan(-1);

  const out = new Map<string, string>();
  let inEnv = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^ {2}\S/.test(line)) break;
    if (/^ {4}environment:\s*$/.test(line)) { inEnv = true; continue; }
    if (!inEnv) continue;
    if (/^ {4}\S/.test(line)) break;
    const m = /^ {6}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (m) out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

const API = envAssignments("api");
const ORGANIZER = envAssignments("organizer");

describe("the compose parser works at all — otherwise every assertion below is vacuous", () => {
  it("found two distinct, non-empty sets of assignments", () => {
    // The guard on the guard. A parser that over-captured (swallowing the organizer's block into
    // the api's) or returned nothing would make every assertion below pass for the wrong reason.
    expect(API.size).toBeGreaterThan(10);
    expect(ORGANIZER.size).toBeGreaterThan(10);
    // Each set really is the service it claims to be, keyed on variables that are genuinely
    // DISJOINT between the two: the api arms the alert intake, the organizer needs a session-mode
    // connection for LISTEN.
    expect(API.has("TF_ALERT_SECRET"), "the api set is not the api's").toBe(true);
    expect(ORGANIZER.has("DATABASE_URL_SESSION"), "the organizer set is not the organizer's").toBe(true);
    expect(API.has("DATABASE_URL_SESSION"), "the api set ran into the organizer's block").toBe(false);
    expect(ORGANIZER.has("TF_ALERT_SECRET"), "the organizer set ran into the api's block").toBe(false);
  });
});

describe("MS_DEVICE_CLIENT_ID reaches BOTH services", () => {
  it("is passed to the api, which runs the sign-in", () => {
    expect(API.get("MS_DEVICE_CLIENT_ID")).toBe("${MS_DEVICE_CLIENT_ID:-}");
  });

  it("is passed to the organizer, which renews the access for as long as the mailbox exists", () => {
    /*
     * THE ASSERTION THIS FILE EXISTS FOR. Delete this line from the compose file and nothing else
     * in the repository goes red, while every device-connected mailbox on every self-hosted install
     * stops syncing an hour after it is connected, reporting a Microsoft outage.
     */
    expect(ORGANIZER.get("MS_DEVICE_CLIENT_ID")).toBe("${MS_DEVICE_CLIENT_ID:-}");
  });

  it("the optional tenant travels with it — one door cannot be on a different authority", () => {
    // A tenant on the api alone would mint the grant against one authority and renew against
    // another. Both default to `common` in code, so the failure needs a deployment that sets it.
    expect(API.get("MS_DEVICE_TENANT")).toBe("${MS_DEVICE_TENANT:-}");
    expect(ORGANIZER.get("MS_DEVICE_TENANT")).toBe("${MS_DEVICE_TENANT:-}");
  });

  it("carries NO client secret to either service — a public registration has none", () => {
    // The structural half. `clientAuthFields` refuses a secret on the public arm, and there is no
    // field in `MicrosoftDeviceClient` to hold one; this asserts nothing invents a variable for it.
    for (const [name, set] of [["api", API], ["organizer", ORGANIZER]] as const) {
      expect([...set.keys()].filter((k) => /^MS_DEVICE.*SECRET$/.test(k)), `${name} invented a device secret`)
        .toEqual([]);
    }
  });
});

describe("both hosts actually READ it, through the one reader", () => {
  it("the api's and the organizer's configs both call msDeviceEnv", () => {
    /*
     * The compose file passing a variable that nothing reads is a variable that does nothing — the
     * exact trap the device-flow slice was written to avoid. And it must be the SAME reader in both
     * hosts: two hosts accepting different spellings is the split-brain the confidential
     * registration's `msOAuthEnv` rule exists for, arrived at through variable names.
     */
    expect(SERVER_CONFIG).toContain("msDeviceEnv(env)");
    expect(WORKER_CONFIG).toContain("msDeviceEnv(env as Record<string, string | undefined>)");
  });

  it("that reader names MS_DEVICE_CLIENT_ID and never falls back to the confidential id", () => {
    // The seam. A fallback would take a complete BYO registration and turn it into a device door
    // that always fails, because a confidential client id is refused outright on the device grant.
    expect(CORE_DEVICE).toContain("MS_DEVICE_TENANT");
    expect(CORE_DEVICE).not.toContain('pick("MS_OAUTH_CLIENT_ID")');
  });
});

describe("an operator can find out about it without reading the code", () => {
  it(".env.example documents the variable and the both-services requirement", () => {
    expect(ENV_EXAMPLE).toContain("MS_DEVICE_CLIENT_ID");
    expect(ENV_EXAMPLE).toContain("MS_DEVICE_TENANT");
    // The sentence, not just the name: an example that lists the variable without saying it must be
    // on both services documents the setting and not the trap.
    expect(ENV_EXAMPLE.toLowerCase()).toMatch(/both the `?api`? and the `?organizer`?/);
  });

  it("the walkthrough names the two things that fail quietly", () => {
    const vps = r("../docs/self-host/VPS.md");
    expect(vps).toContain("MS_DEVICE_CLIENT_ID");
    // "Allow public client flows" is the single easiest step to miss in the Entra registration, and
    // its failure says only `unauthorized_client`.
    expect(vps).toContain("Allow public client flows");
    expect(vps).toMatch(/organizer/);
  });

  it("no document still claims the device flow is unwired", () => {
    /*
     * The example lied once already, in the other direction: it carried a paragraph saying "A second
     * option is coming and is NOT wired yet, so there is deliberately no variable for it here". That
     * sentence was true when written and became false the moment these routes shipped. This is the
     * guard against the mirror-image mistake — shipping the variable and leaving the denial beside
     * it.
     */
    for (const [name, text] of [
      ["deploy/selfhost/.env.example", ENV_EXAMPLE],
      ["docs/self-host/VPS.md", r("../docs/self-host/VPS.md")],
      ["docs/self-host/UMBREL.md", r("../docs/self-host/UMBREL.md")],
    ] as const) {
      expect(text, `${name} still says the device flow is not wired`)
        .not.toMatch(/NOT wired yet|not wired yet|do not expect it to work/);
    }
  });
});
