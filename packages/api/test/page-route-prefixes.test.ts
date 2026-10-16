import { describe, it, expect } from "vitest";
import { PAGE_ROUTE_PREFIXES } from "@trafficflow/db/cloud";
import { apiRoutes } from "@trafficflow/api";

/**
 * The mail policy pages on faults under these prefixes (`alert-mail-policy.ts`), so each must
 * name routes this API registers: a prefix matching nothing is a claim that outlived the code.
 */
describe("PAGE_ROUTE_PREFIXES name registered routes", () => {
  const patterns = apiRoutes.map((r) => r.pattern);

  it("the control: the route table is read", () => {
    expect(patterns.length).toBeGreaterThan(50);
  });

  for (const prefix of PAGE_ROUTE_PREFIXES) {
    it(`${prefix} matches at least one route pattern`, () => {
      expect(patterns.filter((p) => p === prefix || p.startsWith(`${prefix}/`)).length).toBeGreaterThan(0);
    });
  }
});
