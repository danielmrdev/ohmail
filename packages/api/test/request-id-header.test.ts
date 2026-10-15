/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  `X-Request-Id` IS ON THE RESPONSE, AND IT IS THE SAME ID THE LOG LINE CARRIES
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `withRequestId` has minted the id for a long time and bound it to whatever logger the
 * per-request container carries, so where a logger is injected a 500 leaves a line naming the
 * request. What it never did was tell the CLIENT which request: the header was stamped by the
 * two hosted hosts, from the id they mint before `handle`
 * (`apps/api-vercel/src/handler.ts`, `apps/server/src/handler.ts`), and by nothing inside the
 * shared app. Any composition without such a wrapper — the desktop engine's `sidecar.handle`,
 * which is the whole standalone product — answered with nothing in the response, so a person
 * reporting a fault could name the minute and the screen but never the request.
 * `createApp.handle` now stamps it at its single exit.
 *
 * ── WHY THE EQUALITY IS ASSERTED HERE AND NOT ON THE DESKTOP DOOR ────────────────────────────
 *
 * The claim has two halves — the header is present, and its value SELECTS the log line — and
 * only the second needs a logger. The desktop door injects none into its per-request container
 * (`apps/sidecar/src/engine.ts` passes no `logger`, so `withRequestId` binds `silentLogger` and
 * the line goes nowhere), which is a separate defect with its own lane. So the equality is
 * measured here, on `createApp(apiRoutes)` — the same seam both doors compose — with a real
 * `createLogger` reading the emitted BYTES, and the door-level presence is measured through
 * `sidecar.handle` in `apps/sidecar/test/request-id-header.test.ts`.
 *
 * ── THE FAIL-CLOSED ARM IS REACHABLE, WHICH IS WHY IT IS TESTED ──────────────────────────────
 *
 * `stampRequestId` omits the header when `deps.requestId` is empty rather than minting one, and
 * that state is not theoretical: the 404, the 405 and the malformed-parameter 400 are answered
 * ABOVE the pipelines, so on a door that mints no id of its own (the engine passes
 * `requestId: ""`) there is no id to stamp — and no log line either, so an invented id would
 * select nothing. Both arms are below.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createApp, apiRoutes, ACCOUNT_HEADER, REQUEST_ID_HEADER, type ApiDeps } from "@trafficflow/api";
import { createLogger } from "@trafficflow/core";
import { makeDeps, req, seedSession, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);

/** The header as a client reads it. `Headers` is case-insensitive; spelled lowercase on purpose. */
const HEADER = "x-request-id";

/**
 * A `db` whose every statement throws. Driven WITH a real bearer so `withSession`'s lookup runs
 * and raises inside the enveloped section — the unexpected-throw path, which is the one that
 * answers 500. Without a credential `withSession` never queries and the answer is a 401, which
 * is the envelope working as designed and not the case under test.
 */
const exploding = (): ApiDeps["db"] =>
  ({ execute: () => { throw new Error("boom"); } }) as unknown as ApiDeps["db"];

describe("X-Request-Id on the shared pipeline's responses", () => {
  it("an ordinary answer carries the id the request was given", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await app.handle(
      req("GET", "/mailboxes", { bearer: s.token }),
      { ...deps, session: null, requestId: "req-ordinary" } as ApiDeps,
    );

    // Anti-vacuity: a 401 or a 404 would also 'carry a header' and would prove nothing about a
    // response that came out of a handler.
    expect(res.status, "the fixture must reach a real handler").toBe(200);
    expect(res.headers.get(HEADER)).toBe("req-ordinary");
  });

  /**
   * THE CASE THE DEFECT WAS ABOUT. A 500 is the one answer a person is certain to report, and it
   * is the one that was leaving with nothing to quote.
   */
  it("a 500 carries it too, and the value is the id on the logged line", async () => {
    const lines: string[] = [];
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await app.handle(req("GET", "/mailboxes", { bearer: s.token }), {
      ...deps,
      session: null,
      requestId: "req-five-hundred",
      logger: createLogger({ service: "api", sink: (l) => lines.push(l) }),
      db: exploding(),
    } as ApiDeps);

    expect(res.status).toBe(500);
    expect(res.headers.get(HEADER)).toBe("req-five-hundred");

    // The line itself, not a fake logger's calls — and REQUIRED, not consulted if present: a
    // conditional assertion here would pass on a run that logged nothing at all.
    const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const failure = logged.find(
      (l) => l.event === "request_unhandled" || l.event === "request_failed",
    );
    expect(failure, `no failure line was emitted; got ${JSON.stringify(logged.map((l) => l.event))}`)
      .toBeDefined();
    // The whole point: one value selects the response and the line.
    expect(failure!.requestId).toBe(res.headers.get(HEADER));
  });

  /**
   * MINTED WHEN THE HOST SUPPLIES NONE — the desktop engine's case, which passes `requestId: ""`.
   * Two requests, because a constant would satisfy "is a string" and select every line at once.
   */
  it("a door that supplies no id gets a minted one, distinct per request", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const drive = (): Promise<Response> => app.handle(
      req("GET", "/mailboxes", { bearer: s.token }),
      { ...deps, session: null, requestId: "" } as ApiDeps,
    );

    const [a, b] = [await drive(), await drive()];
    expect(a.status).toBe(200);
    const first = a.headers.get(HEADER);
    const second = b.headers.get(HEADER);
    expect(first, "withRequestId mints when the host passes none").toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).not.toBe(second);
  });

  /**
   * THE FAIL-CLOSED ARM. Answered above the pipelines, so nothing minted an id — and nothing
   * logged a line for it to select either. Absence is the honest answer, not a gap.
   */
  it("a 404 answered above the pipelines carries no id when the host minted none", async () => {
    const { deps } = await makeDeps();
    const res = await app.handle(
      req("GET", "/no-such-route-here"), { ...deps, requestId: "" } as ApiDeps,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get(HEADER)).toBeNull();
  });

  it("but the hosted doors' 404 does carry it — they mint before `handle`", async () => {
    const { deps } = await makeDeps();
    const res = await app.handle(
      req("GET", "/no-such-route-here"), { ...deps, requestId: "req-from-the-host" } as ApiDeps,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get(HEADER)).toBe("req-from-the-host");
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  AND THE BODY SURVIVES THE STAMP — on the `Response` a phone actually has
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * This pipeline runs inside the phone app on the standalone door, where `Response` is React
 * Native's `whatwg-fetch` — which has no `body` property at all. `new Response(res.body, …)` was
 * therefore a copy built from `undefined`, which that polyfill takes as "no body" and renders as
 * the empty string. Measured on a release build: every drain answered `JSON Parse error:
 * Unexpected end of input`, the app's mirror stayed at zero rows beside an engine store holding
 * the mail, and the roster read Settings' "This phone" panel draws from answered nothing.
 *
 * The polyfill is REAL here, out of the store rather than modelled: a hand-written stand-in
 * missing `body` would be satisfied by any fix that happened to match the stand-in.
 */
describe("the response body survives the header stamp", () => {
  /** The `Response` a phone has. `require` because the package is CommonJS. */
  function reactNativeResponse(): typeof Response {
    const require_ = createRequire(import.meta.url);
    const wf = require_("whatwg-fetch") as { Response: typeof Response };
    return wf.Response;
  }

  it("the polyfill a phone runs has NO `body` — the premise, measured", () => {
    /* Without this the two cases below could pass on a run where the polyfill had grown a body
       and the copy was harmless, which would make them a test of nothing. */
    expect("body" in reactNativeResponse().prototype,
      "react-native's Response grew a `body` — re-derive the guard, do not delete it").toBe(false);
    expect("body" in Response.prototype, "this runtime's own Response has one").toBe(true);
  });

  it("carries a JSON body on a session-authenticated route — the drain's shape", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const platform = globalThis.Response;
    try {
      /* THE PHONE'S RUNTIME, for the duration of one request. Both wrappers fire here: the route
         is session-authenticated (so the account header is written) and the id is supplied. */
      globalThis.Response = reactNativeResponse();
      const res = await app.handle(
        req("GET", "/mailboxes", { bearer: s.token }),
        { ...deps, session: null, requestId: "req-on-a-phone" } as ApiDeps,
      );
      expect(res.status, "the fixture must reach a real handler").toBe(200);
      /* THE BODY, which is the whole case. `text()` rather than `json()` so an empty answer reads
         as a length rather than as a parser's complaint. */
      const text = await res.text();
      expect(text.length, "the stamped response came back with an EMPTY body").toBeGreaterThan(2);
      expect(JSON.parse(text)).toHaveProperty("items");
      /* AND THE HEADERS ARE STILL THERE. A fix that kept the body by dropping both stamps would
         satisfy the assertion above and lose what the stamps are for. */
      expect(res.headers.get(HEADER)).toBe("req-on-a-phone");
      expect(res.headers.get(ACCOUNT_HEADER)).toBe(s.accountId);
    } finally {
      globalThis.Response = platform;
    }
  });

  it("(control) the platform's own Response is unchanged — body and both headers", async () => {
    /* The arm the servers run. A change that healed the phone by narrowing the server would show
       up here. */
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await app.handle(
      req("GET", "/mailboxes", { bearer: s.token }),
      { ...deps, session: null, requestId: "req-on-a-server" } as ApiDeps,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toHaveProperty("items");
    expect(res.headers.get(HEADER)).toBe("req-on-a-server");
    expect(res.headers.get(ACCOUNT_HEADER)).toBe(s.accountId);
  });
});

/**
 * The SOURCE census, in the shape `account-header-census.test.ts` uses for the header beside this
 * one: one setter, in `app.ts`, so a second spelling cannot appear elsewhere and drift. The
 * envelope must not set it — a per-request id is not a per-response decision, and putting it in
 * `jsonResponse` would leave every raw `Response` (attachments, SSE, the OAuth redirect) without
 * it while making the enveloped ones carry it twice.
 */
describe("X-Request-Id — one setter", () => {
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? sources(`${dir}${e.name}/`) : e.name.endsWith(".ts") ? [`${dir}${e.name}`] : [],
    );
  }

  it("exactly one file in packages/api/src writes the header, and it is app.ts", () => {
    const files = sources(srcDir);
    // Anti-vacuity: the walk must actually have found the package's sources.
    expect(files.length, "the source walk found nothing — re-decide this census").toBeGreaterThan(20);
    /* RE-DERIVED, not relaxed — see `account-header-census.test.ts` for the measurement. The
       write goes through `app.ts`'s `withHeader`, which decides whether this runtime has a body
       to copy; the literal spelling is still forbidden everywhere. */
    const setters = files.filter((f) =>
      /headers\.set\(\s*(REQUEST_ID_HEADER|["'`]X-Request-Id)|withHeader\([^)]*REQUEST_ID_HEADER/i
        .test(readFileSync(f, "utf8")),
    ).map((f) => f.slice(srcDir.length));
    expect(setters).toEqual(["app.ts"]);
  });

  it("app.ts writes it once, through the one place that decides whether to copy", () => {
    const src = readFileSync(`${srcDir}app.ts`, "utf8");
    const writes = (src.match(/headers\.set\(REQUEST_ID_HEADER/g)?.length ?? 0)
      + (src.match(/withHeader\([^)]*REQUEST_ID_HEADER/g)?.length ?? 0);
    expect(writes, "exactly one write of REQUEST_ID_HEADER in app.ts").toBe(1);
    expect(src).toContain("function stampRequestId");
    /**
     * ── THE PREMISE OF THE OLD ASSERTION DIED, AND THIS IS WHAT REPLACES IT ─────────────────
     *
     * It read `expect(src).not.toMatch(/res\.headers\.set\(\s*REQUEST_ID_HEADER/)`, on the
     * argument that a `Response`'s `Headers` may be guarded so the copy is the only safe route.
     * That is true of the SERVER runtimes and false of the one this pipeline also runs in: React
     * Native's `Response` is `whatwg-fetch`, which has no `body` property at all, so
     * `new Response(res.body, …)` builds a copy with an EMPTY body. Measured on a release build —
     * every drain over the phone's own door answered `Unexpected end of input`.
     *
     * So the invariant is re-derived rather than dropped: the copy is made by ONE function, and
     * it makes the copy only where the runtime has a body to hand on. No other site in this file
     * may build a response out of another one's body.
     */
    expect(src, "the write must route through `withHeader`")
      .toMatch(/withHeader\(res,\s*REQUEST_ID_HEADER/);
    /* CODE, not prose: the docblock above `withHeader` quotes the expression it exists to fence,
       and a census that counted the quotation would report two writers of one. */
    const code = src.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/\/\/[^\n]*/gu, " ");
    const copies = code.match(/new Response\(\s*res\.body/g)?.length ?? 0;
    expect(copies, "exactly one site copies a response's body, and it is `withHeader`").toBe(1);
    expect(src, "the copy must be gated on the runtime HAVING a body")
      .toMatch(/if \("body" in Response\.prototype\)/);
  });
});
