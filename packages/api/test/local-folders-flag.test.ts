import { describe, expect, it } from "vitest";
import { localRoutes, withoutFoldersFlag } from "../src/routes/local.js";
import { matchRoute } from "../src/router.js";
import type { Route } from "../src/router.js";

/**
 * ═══ THE STANDALONE DOOR CANNOT RAISE THE FOLDERS FLAG ══════════════════════════════════════
 *
 * ── WHAT mail 0083 BROKE ON ITS WAY PAST ────────────────────────────────────────────────────
 *
 * Mounting `consentRoutes` on the standalone table gave that install a screening window, which it
 * badly needed. It also gave it `foldersEnabled` — and this table serves NO folder route at all,
 * not even the summary. `apps/desktop/src/local-consent.ts` composes
 * `PATCH /consent/settings { foldersEnabled }`, so a standalone user could switch folders on, the
 * rail would mount, and all four verbs would answer 404. That is the state
 * `apps/sidecar/test/client-route-coverage.test.ts` had been red on.
 *
 * ── WHY THE FLAG AND NOT THE VERBS ──────────────────────────────────────────────────────────
 *
 * Serving the verbs is a FEATURE: the standalone engine owns the IMAP connection, so folder
 * create/rename/delete there is real work with real failure modes, and mounting the routes without
 * it would be a larger lie than the one being closed. The rule this codebase keeps is the smaller
 * one — a control wired to nothing is worse than an absent one.
 *
 * ── AND WHY AT THE ROUTE ────────────────────────────────────────────────────────────────────
 *
 * Gating the desktop's toggle works today and is a check somebody can forget. Here no client can
 * raise it — not this one, not a future one, not a hand-made request with the launch bearer.
 * BOTH directions, because either alone is a half-truth: a GET reporting `on` over a PATCH that
 * refused would draw a rail the server had just declined to enable.
 *
 * These are the ROUTES this table is composed from; the census in `client-route-coverage.test.ts`
 * holds the other half (that no folder verb is served here at all).
 */

describe("the standalone table's consent group", () => {
  it("the HOSTED table is untouched — it is the one that actually serves the verbs", async () => {
    /* The blast radius, checked rather than assumed: `selfHostRoutes` spreads `localRoutes` whole,
       so the stripper reaches the self-host door too — correctly, since `foldersRoutes` is spread
       at `routes/index.ts` and nowhere else, meaning neither door built from this table can serve
       a folder verb. The hosted table spreads `consentRoutes` DIRECTLY and keeps the flag. */
    const src = require("node:fs").readFileSync(
      new URL("../src/routes/index.ts", import.meta.url), "utf8") as string;
    expect(src, "the hosted table lost the raw consent group").toMatch(/^\s*\.\.\.consentRoutes,\s*$/m);
    expect(src, "the hosted table is where the folder verbs live").toMatch(/^\s*\.\.\.foldersRoutes,\s*$/m);
  });

  it("still serves the consent READ — the screening window depends on it", () => {
    // The link that must NOT be closed again: 0083 mounted this on purpose, and taking it away to
    // fix the flag would put the standalone install back to screening a decade of mail.
    expect(matchRoute(localRoutes, "GET", "/consent").matched).toBe(true);
    expect(matchRoute(localRoutes, "PATCH", "/consent/settings").matched).toBe(true);
  });

  it("serves NO folder verb at all, which is what makes the flag a dead end here", () => {
    for (const [method, pattern] of [
      ["POST", "/folders"], ["PATCH", "/folders/x"], ["DELETE", "/folders/x"],
      ["DELETE", "/folders/x/op"], ["GET", "/folders/x/summary"],
    ] as const) {
      expect(matchRoute(localRoutes, method, pattern).matched,
        `${method} ${pattern} is served on the standalone table`).toBe(false);
    }
  });

  it("routes the consent group through the stripper, which is the structural half", () => {
    // Asserted over the composition rather than by driving a handler, because what is being
    // claimed is that NOTHING reaching this table can carry the field — a property of how the
    // table is built, not of one request. `client-route-coverage.test.ts` measures the same line
    // as link four of its exemption chain, so the two cannot disagree.
    const src = new URL("../src/routes/local.ts", import.meta.url);
    const text = require("node:fs").readFileSync(src, "utf8") as string;
    expect(text).toContain("...withoutFoldersFlag(consentRoutes)");
    expect(text, "the raw group is mounted again beside the wrapped one")
      .not.toMatch(/^\s*\.\.\.consentRoutes,\s*$/m);
  });

  /**
   * ── THE STRIPPER, DRIVEN ──────────────────────────────────────────────────────────────────
   *
   * Over a synthetic consent group rather than the real one, and behaviour rather than source
   * text: the claim is what a client RECEIVES, and a needle in this file's own source is not
   * that — it goes green for a wrapper somebody rewrote and red for a comment somebody reworded.
   * The inner handlers below answer exactly what `consentRoutes` answers in the shapes that
   * matter, and the assertions are on the wrapped answer.
   */
  const echo = (): Route[] => [
    {
      method: "GET", pattern: "/consent", relay: true, cost: "read",
      handler: async () => new Response(
        JSON.stringify({ foldersEnabledAt: "2026-02-03T04:05:06.000Z", dormancyDays: 45 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    } as unknown as Route,
    {
      method: "PATCH", pattern: "/consent/settings", relay: true, cost: "work",
      // The body AS THE HANDLER RECEIVED IT — the only way to see what the wrapper let through.
      handler: async (req: Request) => new Response(await req.text(), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    } as unknown as Route,
    {
      method: "POST", pattern: "/consent/reset", relay: true, cost: "work",
      handler: async () => new Response(JSON.stringify({ foldersEnabledAt: null }), { status: 200 }),
    } as unknown as Route,
  ];
  const wrapped = (method: string, pattern: string): Route =>
    withoutFoldersFlag(echo()).find((r) => r.method === method && r.pattern === pattern)!;
  const deps = {} as never;
  const params = {} as never;

  it("the READ loses the folders axis ENTIRELY — absent, not null", async () => {
    const res = await wrapped("GET", "/consent").handler(
      new Request("https://x/consent"), deps, params,
    );
    const wire = (await res.json()) as Record<string, unknown>;
    /* ABSENT is the assertion, and `null` would pass a `foldersEnabledAt != null` check just as
       well. The difference is the second fact a client reads off the same body: `null` is an axis
       this door CARRIES and could store an instant on, absent is a door with no folders axis at
       all. Under `null` a paired phone drew "Use folders", wrote, got a 200 whose echo omitted
       the field, and read that as "off" — a switch that flips and snaps back in silence. */
    expect("foldersEnabledAt" in wire, "the door still claims a folders axis it cannot store")
      .toBe(false);
    // And nothing else on the row is disturbed: this wrapper removes one field, not a section.
    expect(wire.dormancyDays).toBe(45);
  });

  it("the WRITE never reaches the handler carrying the flag", async () => {
    const res = await wrapped("PATCH", "/consent/settings").handler(
      new Request("https://x/consent/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ foldersEnabled: true, dormancyDays: 30 }),
      }),
      deps, params,
    );
    const seen = (await res.json()) as Record<string, unknown>;
    expect("foldersEnabled" in seen, "the flag reached the writer").toBe(false);
    // The other axes of the same request are untouched — one field is dropped, not the body.
    expect(seen.dormancyDays).toBe(30);
  });

  it("a route that is neither is handed back unchanged", async () => {
    // The positive control the two refusals need: the wrapper must not be a filter over the whole
    // group. `/consent/reset` keeps its own answer, folders field and all.
    const res = await wrapped("POST", "/consent/reset").handler(
      new Request("https://x/consent/reset", { method: "POST" }), deps, params,
    );
    expect("foldersEnabledAt" in ((await res.json()) as Record<string, unknown>)).toBe(true);
  });

  it("a refusal passes through untouched — only a 200 body is rewritten", async () => {
    const refusing: Route[] = withoutFoldersFlag([
      {
        method: "GET", pattern: "/consent", relay: true, cost: "read",
        handler: async () => new Response(JSON.stringify({ error: { message: "no" } }), { status: 503 }),
      } as unknown as Route,
    ]);
    const res = await refusing[0]!.handler(new Request("https://x/consent"), deps, params);
    expect(res.status).toBe(503);
    expect((await res.json()) as Record<string, unknown>).toEqual({ error: { message: "no" } });
  });
});
