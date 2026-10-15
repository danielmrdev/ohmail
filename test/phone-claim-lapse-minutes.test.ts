import { describe, expect, it } from "vitest";
import { DEFAULT_STALE_AFTER_MS } from "@trafficflow/core/adapters/organizer-lease";
import { CLAIM_LAPSES_AFTER_MINUTES } from "../apps/mobile/src/engine/standalone-door.js";

/**
 * ═══ THE PHONE TELLS SOMEBODY HOW LONG THEIR MAILBOX STAYS BLOCKED, AND IT HAS TO BE TRUE ═══
 *
 * Forgetting this phone's own mailbox releases its claim from `ohmail/_meta`. When that release
 * cannot reach the mail server the row still goes, and the sentence the person reads names the
 * wait before another machine can take the mailbox (`Copy.forgetClaimStands`). That wait is the
 * LEASE's staleness window, which lives in core — and the app may not import the engine seam, so
 * the number is spelled a second time in `standalone-door.ts`. This is the only thing that keeps
 * the two from drifting: a fleet window changed in core and not here would put a figure in front
 * of a person that nothing in the product honours.
 *
 * Lives at the root because it is the only place both halves can be imported at once, and it is
 * invisible to touched-package selection — run it by exact path.
 */
describe("the minutes the phone promises are the lease's own staleness window", () => {
  it("names the same wait core does", () => {
    expect(
      CLAIM_LAPSES_AFTER_MINUTES * 60_000,
      "the phone's forget sentence names a wait no install honours",
    ).toBe(DEFAULT_STALE_AFTER_MS);
  });

  /* A WHOLE NUMBER OF MINUTES, because the sentence says "about N minutes" and a fractional N
     would render as `12.5`. If the window ever stops dividing, the sentence is what changes. */
  it("divides into whole minutes, which is what the sentence renders", () => {
    expect(DEFAULT_STALE_AFTER_MS % 60_000).toBe(0);
    expect(Number.isInteger(CLAIM_LAPSES_AFTER_MINUTES)).toBe(true);
  });
});
