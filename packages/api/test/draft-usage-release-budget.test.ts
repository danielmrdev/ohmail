import { describe, it, expect } from "vitest";
import { DRAFT_USAGE_RELEASE } from "@trafficflow/services";
import { API_FAULT_RECORD_BUDGET_MS } from "../src/index.js";

/* The draft's usage release leaves room for the fault record a timed-out call writes. The drafting
 * service cannot import this package, so it restates the budget; this pins the two. */
describe("the draft's usage release budget", () => {
  it("restates the API's fault-record budget exactly", () => {
    expect(DRAFT_USAGE_RELEASE.faultRecordMs).toBe(API_FAULT_RECORD_BUDGET_MS);
  });
});
