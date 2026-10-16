import { describe, it, expect } from "vitest";
import { matchRoute, type Route } from "@trafficflow/api";

const noop: Route["handler"] = async () => new Response();

const routes: Route[] = [
  { method: "POST", pattern: "/threads/merge", handler: noop },
  { method: "GET", pattern: "/threads/:id", handler: noop },
  { method: "PATCH", pattern: "/threads/:id", handler: noop },
  { method: "GET", pattern: "/messages/:id", handler: noop },
  { method: "POST", pattern: "/messages/:id/move", handler: noop },
  { method: "POST", pattern: "/mailboxes/:id/resync", handler: noop },
];

describe("matchRoute", () => {
  it("prefers a static segment over a param: /threads/merge", () => {
    const m = matchRoute(routes, "POST", "/threads/merge");
    expect(m.matched).toBe(true);
    if (m.matched) expect(m.route.pattern).toBe("/threads/merge");
  });

  it("falls through to the param route for a real id", () => {
    const m = matchRoute(routes, "GET", "/threads/abc-123");
    expect(m.matched).toBe(true);
    if (m.matched) {
      expect(m.route.pattern).toBe("/threads/:id");
      expect(m.params.id).toBe("abc-123");
    }
  });

  it("resolves nested static-after-param routes: /messages/:id/move", () => {
    const move = matchRoute(routes, "POST", "/messages/m1/move");
    expect(move.matched).toBe(true);
    if (move.matched) {
      expect(move.route.pattern).toBe("/messages/:id/move");
      expect(move.params.id).toBe("m1");
    }
    const get = matchRoute(routes, "GET", "/messages/m1");
    expect(get.matched).toBe(true);
    if (get.matched) expect(get.route.pattern).toBe("/messages/:id");
  });

  it("extracts params for /mailboxes/:id/resync", () => {
    const m = matchRoute(routes, "POST", "/mailboxes/mb-9/resync");
    expect(m.matched).toBe(true);
    if (m.matched) expect(m.params.id).toBe("mb-9");
  });

  it("returns 404 (not matched, method-not-allowed=false) for an unknown path", () => {
    const m = matchRoute(routes, "GET", "/nope/here");
    expect(m.matched).toBe(false);
    if (!m.matched) expect(m.methodNotAllowed).toBe(false);
  });

  it("returns 405 (matched path, wrong method) for a known path", () => {
    const m = matchRoute(routes, "DELETE", "/threads/abc-123");
    expect(m.matched).toBe(false);
    if (!m.matched) expect(m.methodNotAllowed).toBe(true);
  });
});
