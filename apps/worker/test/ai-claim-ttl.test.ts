import { describe, it, expect } from "vitest";
import { AI_CLAIM_TTL_MS } from "@trafficflow/db";
import { callCeilingMs } from "@trafficflow/core";
import { AI_CLASSIFY_TIMEOUT_MS_DEFAULT, classifyCallCeilingMs } from "../src/config.js";

/**
 * THE LEASE MUST OUTLIVE THE CALL IT COVERS.
 *
 * `AI_CLAIM_TTL_MS` is the exclusive AI work claim's TTL, and it was 60 s against a comment
 * asserting that *"the worker's model timeout is 30 s"*. The worker passes `timeoutMs: 30_000`
 * and no `maxRetries`, so the client's default of two retries applied and the real ceiling was
 * ~130 s. A live worker's claim therefore expired mid-call; the next arrival took the claim over,
 * found the worker's debit, read it as an open duplicate — `permitted, charged: false` — and made
 * a SECOND provider call against a credit that had bought one. The "No API cost without revenue behind it" invariant.
 *
 * Nothing checked the prose. This file is that check, and it is deliberately arithmetic on the
 * worker's OWN configuration rather than on a copy of the numbers: raising `TF_AI_TIMEOUT_MS`, or
 * passing a `maxRetries` the claim was not sized for, must fail here rather than in production
 * billing.
 *
 * Watched red while writing it, each restored:
 *  · `AI_CLAIM_TTL_MS` back to 60_000 → the default-configuration case fails, naming 130 s;
 *  · `callCeilingMs` returning `timeoutMs` alone → the retry-arithmetic case fails;
 *  · dropping the `maxRetries × MAX_RETRY_AFTER_MS` term → the retry-after case fails.
 */
describe("the AI claim TTL covers the worker's whole model call", () => {
  it("holds at the shipped default configuration", () => {
    const ceiling = classifyCallCeilingMs({} as NodeJS.ProcessEnv);
    expect(ceiling, "three 30 s attempts plus two honoured 20 s retry-afters").toBe(130_000);
    expect(AI_CLAIM_TTL_MS,
      "a claim that expires inside its own model call hands the work to a second paid caller")
      .toBeGreaterThanOrEqual(ceiling);
  });

  it("holds at every timeout this deployment can be configured with", () => {
    for (const timeoutMs of [5_000, 10_000, 30_000, 36_000]) {
      const ceiling = classifyCallCeilingMs({ TF_AI_TIMEOUT_MS: String(timeoutMs) } as NodeJS.ProcessEnv);
      expect(ceiling, `timeout ${timeoutMs}`).toBe(timeoutMs * 3 + 40_000);
      expect(AI_CLAIM_TTL_MS, `timeout ${timeoutMs} must still fit inside the claim`)
        .toBeGreaterThanOrEqual(ceiling);
    }
  });

  it("counts the retries and the honoured retry-after, not just the attempt deadline", () => {
    // The two terms are separable, and both were missing from the reasoning that set 60 s.
    expect(callCeilingMs({ timeoutMs: 1_000, maxRetries: 0 }), "one attempt, no backoff").toBe(1_000);
    expect(callCeilingMs({ timeoutMs: 1_000, maxRetries: 1 }), "two attempts + one retry-after")
      .toBe(2_000 + 20_000);
    expect(callCeilingMs({ timeoutMs: 1_000, maxRetries: 2 }), "three attempts + two retry-afters")
      .toBe(3_000 + 40_000);
  });

  it("names the timeout default in one place, so the ceiling and the client cannot drift", () => {
    expect(AI_CLASSIFY_TIMEOUT_MS_DEFAULT).toBe(30_000);
    expect(classifyCallCeilingMs({} as NodeJS.ProcessEnv))
      .toBe(callCeilingMs({ timeoutMs: AI_CLASSIFY_TIMEOUT_MS_DEFAULT }));
  });
});
