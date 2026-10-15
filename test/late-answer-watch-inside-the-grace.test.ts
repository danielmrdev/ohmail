import { describe, expect, it } from "vitest";
import { DEFAULT_AUTH_CONFIG } from "@trafficflow/services";
import {
  LATE_ANSWER_TRANSIT_MS, LATE_ANSWER_WATCH_MS, REFRESH_GRACE_MS,
} from "../apps/webapp/app/session-refresh.js";

/**
 * THE WEB'S LATE-ANSWER WATCH ENDS INSIDE THE SERVER'S GRACE. A live tab repairs a dead page's
 * renewal answer by presenting it once more, and the server converges that presentation only within
 * `refreshReuseGraceMs` of the row's kill. The client states that grace once and takes the watch
 * from it, less a transit budget for the answer's way back and the repair's way out; both sides are
 * imported here, never read as text.
 */
describe("the late-answer watch", () => {
  it("states the server's grace, and ends before it closes", () => {
    expect(REFRESH_GRACE_MS, "the client's grace is not the server's").toBe(DEFAULT_AUTH_CONFIG.refreshReuseGraceMs);
    expect(LATE_ANSWER_TRANSIT_MS, "no transit budget").toBeGreaterThan(0);
    expect(LATE_ANSWER_WATCH_MS, "a repair could present a row the server no longer converges")
      .toBeLessThan(DEFAULT_AUTH_CONFIG.refreshReuseGraceMs);
  });
});
