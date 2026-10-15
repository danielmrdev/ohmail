import { describe, expect, it } from "vitest";
import { RELAY_ALLOWLIST, type RelaySpec } from "@trafficflow/api/relay-allowlist";
import { READ_ROUTES, matchReadRoute, type ReadRoute } from "../src/cloud-read.js";

/**
 * THE TWO TABLES THE PAIRED DOOR ASKS, AGAINST EACH OTHER. The door asks the mirror's read table
 * first and forwards what it does not claim, so a parameterised read (`/messages/:id`) could
 * capture a static route only the relay names (`/messages/timeline`, History on a paired
 * desktop) and answer it from the wrong handler. Every relayed GET route must resolve to itself
 * in the read table or to the relay; every read route must resolve to itself.
 */

const ID = "0b5e8c4a-2f1d-4c3b-9a7e-6d5f4e3c2b1a";
const concrete = (pattern: string): string =>
  pattern.split("/").map((s) => (s.startsWith(":") ? ID : s)).join("/");

type Matcher = (method: string, path: string) => { route: ReadRoute } | null;

/** Relayed GET routes the matcher hands to a DIFFERENT read pattern: the defect's whole class. */
function captured(relayed: readonly RelaySpec[], match: Matcher): string[] {
  return relayed
    .filter((r) => r.method === "GET")
    .flatMap((r) => {
      const hit = match("GET", concrete(r.pattern));
      return hit && hit.route.pattern !== r.pattern ? [`${r.pattern} -> ${hit.route.pattern}`] : [];
    });
}

const real: Matcher = (m, p) => matchReadRoute(m, p);
/** The base's shape: the read table alone decides, the relay table unconsulted. */
const readFirst = (reads: readonly ReadRoute[]): Matcher => (m, p) => matchReadRoute(m, p, reads, []);

const stub = (pattern: string): ReadRoute => ({
  method: "GET", pattern, handler: async () => new Response("{}"),
});

describe("the census over both tables", () => {
  it("reads a relay table of real size (a zero here would be a census of nothing)", () => {
    const gets = RELAY_ALLOWLIST.filter((r) => r.method === "GET").length;
    expect(gets).toBeGreaterThanOrEqual(60);
    expect(READ_ROUTES.length).toBeGreaterThanOrEqual(10);
  });

  it("POSITIVE CONTROL: the read-first shape captures exactly the timeline, by name", () => {
    expect(captured(RELAY_ALLOWLIST, readFirst(READ_ROUTES))).toEqual([
      "/messages/timeline -> /messages/:id",
    ]);
  });

  it("no relayed GET route resolves to a different read pattern", () => {
    expect(captured(RELAY_ALLOWLIST, real)).toEqual([]);
  });

  it("every read route still resolves to itself", () => {
    const moved = READ_ROUTES.filter((r) => matchReadRoute(r.method, concrete(r.pattern))?.route !== r)
      .map((r) => r.pattern);
    expect(moved).toEqual([]);
  });

  it("the relay's join moves exactly one resolution, the timeline's", () => {
    const paths = [
      ...RELAY_ALLOWLIST.filter((r) => r.method === "GET").map((r) => concrete(r.pattern)),
      ...READ_ROUTES.map((r) => concrete(r.pattern)),
    ];
    const moved = [...new Set(paths)].filter((p) =>
      matchReadRoute("GET", p)?.route.pattern !== readFirst(READ_ROUTES)("GET", p)?.route.pattern);
    expect(moved).toEqual(["/messages/timeline"]);
  });

  it("a colliding fixture row in EITHER table is named by the read-first shape and relayed by the door", () => {
    const relayed = [...RELAY_ALLOWLIST, { method: "GET", pattern: "/rules/archived" }];
    expect(captured(relayed, (m, p) => matchReadRoute(m, p, READ_ROUTES, []))).toContain("/rules/archived -> /rules/:id");
    expect(captured(relayed, (m, p) => matchReadRoute(m, p, READ_ROUTES, relayed))).toEqual([]);

    const reads = [...READ_ROUTES, stub("/screener/:id")];
    expect(captured(RELAY_ALLOWLIST, readFirst(reads))).toContain("/screener/junk -> /screener/:id");
    expect(captured(RELAY_ALLOWLIST, (m, p) => matchReadRoute(m, p, reads))).toEqual([]);
  });
});

describe("matchReadRoute on the paired door", () => {
  it("/messages/timeline is the relay's", () => {
    expect(matchReadRoute("GET", "/messages/timeline")).toBeNull();
  });

  it("/messages/<id> is still the mirror read", () => {
    const hit = matchReadRoute("GET", `/messages/${ID}`);
    expect(hit?.route.pattern).toBe("/messages/:id");
    expect(hit?.params).toEqual({ id: ID });
  });

  it("/search resolves to the mirror's own /search row", () => {
    expect(matchReadRoute("GET", "/search")?.route.pattern).toBe("/search");
  });

  it("a mutation never resolves here", () => {
    expect(matchReadRoute("DELETE", `/messages/${ID}`)).toBeNull();
  });
});
