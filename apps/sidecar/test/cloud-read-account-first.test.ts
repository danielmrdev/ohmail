import { describe, expect, it } from "vitest";
import { relayVerdict } from "@trafficflow/api/relay-allowlist";
import { READ_ROUTES, matchReadRoute, type ReadRoute } from "../src/cloud-read.js";

/**
 * WHICH MIRROR READS THE ACCOUNT ANSWERS FIRST. A row marked `accountFirst` relays to the account
 * and is served from the mirror only while the account cannot be reached, so moving a row there
 * changes whose answer a paired desktop shows. Each move is pinned here with its reason; a row
 * moved without one, or not pinned, reddens this file.
 */

const PINNED: Record<string, string> = {
  "/search": "a search's whole-mailbox verdict and count are the account's; the mirror holds a window of it",
};

const accountFirst = (reads: readonly ReadRoute[]): Record<string, string> =>
  Object.fromEntries(reads.filter((r) => r.accountFirst !== undefined).map((r) => [r.pattern, r.accountFirst!.reason]));

describe("the account-first read rows", () => {
  it("are exactly the pinned ones, each with its reason", () => {
    expect(accountFirst(READ_ROUTES)).toEqual(PINNED);
    for (const reason of Object.values(accountFirst(READ_ROUTES))) expect(reason.trim().length).toBeGreaterThan(20);
  });

  it("POSITIVE CONTROL: a second row moved without a reason is named", () => {
    const moved = READ_ROUTES.map((r) => (r.pattern === "/tags" ? { ...r, accountFirst: { reason: "" } } : r));
    expect(accountFirst(moved)).not.toEqual(PINNED);
    expect(accountFirst(moved)).toMatchObject({ "/tags": "" });
  });

  it("each one is a route the relay forwards, or the account could never answer it", () => {
    for (const pattern of Object.keys(PINNED)) expect(relayVerdict("GET", pattern)).toBe("forward");
  });

  it("the door resolves /search to the account-first row, and every other read to the mirror", () => {
    expect(matchReadRoute("GET", "/search")?.route.accountFirst?.reason).toBe(PINNED["/search"]);
    const mirrorOnly = READ_ROUTES.filter((r) => !(r.pattern in PINNED)).filter((r) => r.accountFirst);
    expect(mirrorOnly).toEqual([]);
  });
});
