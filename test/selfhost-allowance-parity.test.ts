import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  EVERY PRIVATE-NETWORK ALLOWANCE THE SERVER READS MUST BE REACHABLE BY AN OPERATOR
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A `TF_*_ALLOW_PRIVATE` switch is only real if a self-hoster can set it, and setting it means
 * four separate files agreeing: the server reads it, the compose file passes it through to every
 * service that needs it, the `.env` template names it, and a guide explains when to use it. A
 * switch the code reads and the compose file drops is a feature that cannot be turned on; one the
 * compose file passes and no document mentions is a feature nobody knows exists.
 *
 * ── WHY THIS EXISTS: IT HAD ALREADY DRIFTED ───────────────────────────────────────────────────
 *
 * `TF_PUSH_ALLOW_PRIVATE` shipped in `apps/server/src/config.ts` and in the compose file and was
 * absent from `.env.example`, from `UMBREL.md` and from the start9 package notes — three of the
 * four places an operator would look. Nothing was red, because nothing was checking. The probe's
 * own switch was fully documented, which is exactly what makes the gap invisible: the pattern
 * looks maintained.
 *
 * ── AND THE BOTH-SERVICES RULE, WHICH IS THE ONE WITH TEETH ───────────────────────────────────
 *
 * The push allowance has to reach the API **and** the organizer: the first validates a
 * registration and the second dials it. Set on one only, the API accepts an endpoint the organizer
 * then refuses — a phone showing a working registration that never rings, and the only trace is a
 * `push_wake_endpoint_refused` line in a log nobody is reading. So the count in the compose file
 * is asserted, not merely its presence.
 */

const r = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const CONFIG = r("../apps/server/src/config.ts");
const COMPOSE = r("../deploy/selfhost/docker-compose.yml");
const ENV_EXAMPLE = r("../deploy/selfhost/.env.example");
const DOCS = [
  ["docs/self-host/VPS.md", r("../docs/self-host/VPS.md")],
  ["docs/self-host/UMBREL.md", r("../docs/self-host/UMBREL.md")],
  ["deploy/start9/README.md", r("../deploy/start9/README.md")],
] as const;

/** Every allowance the standalone server's config actually reads, derived rather than listed. */
const ALLOWANCES = [...new Set(
  [...CONFIG.matchAll(/trimmed\(env,\s*"(TF_\w*ALLOW_PRIVATE)"\)/g)].map((m) => m[1]!),
)].sort();

describe("private-network allowances are reachable by the operator", () => {
  it("the server reads at least the two known switches — otherwise this file is vacuous", () => {
    // The guard on the guard: if the regex stops matching, every assertion below passes over an
    // empty list. Naming the floor is what stops that being silent.
    expect(ALLOWANCES).toEqual(["TF_PROBE_ALLOW_PRIVATE", "TF_PUSH_ALLOW_PRIVATE"]);
  });

  for (const name of ALLOWANCES) {
    it(`${name} is passed through by the compose file`, () => {
      expect(COMPOSE, `${name} is read by the server and never reaches it from compose`)
        .toContain(`${name}: \${${name}:-}`);
    });

    it(`${name} is named in .env.example, so an operator can find it`, () => {
      expect(ENV_EXAMPLE, `${name} exists but the .env template never mentions it`)
        .toContain(name);
    });

    it(`${name} is explained in at least one self-host guide`, () => {
      const where = DOCS.filter(([, body]) => body.includes(name)).map(([p]) => p);
      expect(where, `${name} is documented nowhere an operator reads`).not.toEqual([]);
    });
  }

  /**
   * BOTH ALLOWANCES REACH BOTH SERVICES. One occurrence is the silent half-configuration, and each
   * switch has its own version of it: the push one accepts a LAN endpoint the organizer then
   * refuses on every wake (a phone showing a registration that never rings), and the probe one
   * accepts a LAN MAILBOX the organizer then refuses on every cycle (a mailbox that connects when
   * you add it and never syncs). The probe half shipped set on the api alone and was invisible for
   * as long as the organizer did no checking — which is what made it the same defect this file was
   * written about, arrived at from the other direction.
   */
  for (const name of ALLOWANCES) {
    it(`${name} reaches BOTH services — the api validates, the organizer dials`, () => {
      const occurrences = COMPOSE.split(`${name}: \${${name}:-}`).length - 1;
      expect(occurrences, `${name} must be set on the api AND the organizer`).toBe(2);
    });
  }

  it("the two switches are documented as INDEPENDENT wherever both appear", () => {
    // The substantive claim, not a spelling check: an operator who reads only one guide must not
    // come away thinking the probe switch also licenses the unattended sender.
    const both = DOCS.filter(([, b]) =>
      b.includes("TF_PUSH_ALLOW_PRIVATE") && b.includes("TF_PROBE_ALLOW_PRIVATE"));
    expect(both.length, "no guide mentions both, so the distinction is stated nowhere")
      .toBeGreaterThan(0);
    for (const [path, body] of both) {
      expect(body.toLowerCase(), `${path} mentions both switches without distinguishing them`)
        .toMatch(/separate/);
    }
  });
});
