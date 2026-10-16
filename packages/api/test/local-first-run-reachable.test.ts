import { describe, it, expect } from "vitest";
import { localRoutes } from "@trafficflow/api/local";

/**
 * CAN THE FIRST-RUN FLOW BE FINISHED ON THE STANDALONE DOOR — asked of the route table, not of a
 * screen.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
 *
 * The flow's last act is `FirstRunHost.complete` → `PATCH /consent/settings
 * { onboardingCompleted: true }`, and it is the ONE call that closes the stage: cancel and finish
 * both make it, which is what lets a single truth-condition end the flow for both. If that route
 * is absent from the local table, or gated behind a step-up, the standalone install can complete
 * every step of onboarding and never leave it — the flow reopens on the next launch, for ever,
 * with nothing on screen explaining why.
 *
 * That is not hypothetical. It is exactly what `POST /mailboxes/:id/organize` did on this door:
 * `stepUp: true` on a tier whose second-factor stamp is written once at boot
 * (`identity.ts#mintLaunchSession`) means `withStepUp` refuses from five minutes after launch for
 * the life of the process — every machine open longer than a coffee — so the consent step could
 * never be completed and the flow could never be closed. The fix there was a launch-bearer local
 * route. The point of this file is that the SAME question has to be asked of every route the flow
 * depends on, once, in a place that fails when somebody adds a gate.
 *
 * ── AND WHY IT ASSERTS THE STEP-UP GATE IN BOTH DIRECTIONS ──────────────────────────────────
 *
 * A test that only says "the flow's routes are ungated" would go green if somebody removed the
 * gate from everything. `POST /consent/reset` is the control: it clears an account's screening
 * state and it is gated deliberately, so it must STAY gated. The pair is what makes the first
 * half evidence rather than a restatement of the current file.
 */

const find = (method: string, pattern: string) =>
  localRoutes.find((r) => r.method === method && r.pattern === pattern);

const gated = (method: string, pattern: string): boolean => {
  const r = find(method, pattern);
  if (!r) throw new Error(`${method} ${pattern} is not on the local table at all`);
  return (r.options as { stepUp?: boolean } | undefined)?.stepUp === true;
};

describe("the standalone door serves the first-run flow's own routes", () => {
  it("THE COMPLETION STAMP IS REACHABLE — `PATCH /consent/settings`, and NOT step-up gated", () => {
    // Present: the flow's last act has somewhere to land.
    expect(find("PATCH", "/consent/settings"), "the flow cannot be closed on this door").toBeDefined();
    // Ungated: a step-up here would strand the flow open on every machine, for the reason in the
    // header — this door's second factor is a boot-time stamp, so the window has always expired.
    expect(gated("PATCH", "/consent/settings")).toBe(false);
  });

  it("the window the consent writes is READABLE and WRITABLE here — the dial has a surface", () => {
    // `GET /consent` is what the stage re-derives its posture from on a resumed run, and the
    // standalone door had neither of these until the screening window was extended to it.
    expect(find("GET", "/consent"), "no consent read on the local table").toBeDefined();
    expect(gated("GET", "/consent")).toBe(false);
  });

  it("THE CONTROL: `POST /consent/reset` IS still step-up gated, and must stay so", () => {
    // Without this, the assertions above would pass on a build that had removed every gate.
    expect(gated("POST", "/consent/reset")).toBe(true);
  });

  it("the shared organize route is on this table and IS step-up gated — which is why the local one exists", () => {
    // This is the route the flow's consent step would otherwise call. It is deliberately left
    // gated: the fix was not to weaken it but to serve the standalone door a launch-bearer path
    // of its own (`POST /local/mailboxes/:id/organize`, ahead of this table in the sidecar).
    // Pinned here so that a future "just remove the stepUp" — which would weaken the HOSTED door
    // too, since this table is shared with the self-host and desktop-host compositions — fails.
    expect(gated("POST", "/mailboxes/:id/organize")).toBe(true);
  });
});
