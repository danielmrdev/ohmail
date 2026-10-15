import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createApp, apiRoutes, csrfTokenFor, type ApiDeps } from "@trafficflow/api";
import { refreshTokens } from "@trafficflow/db";
import { generateToken, hashToken } from "@trafficflow/services";
import * as scan from "../../../scripts/lib/source-scan.mjs";
import {
  makeDeps, seedSession, seedSessionFor, seedMessage, seedBody, req, setCookieMap, cookieMaxAge, FIXED_NOW,
} from "./helpers.js";
import { PNG_2X3 } from "../../core/test/fixtures/images.js";

/* @reads: packages/api/src/
   The census walks the package's source by a path built at runtime. */

/**
 * A RESPONSE THAT ENDS A BROWSER SESSION EMPTIES THAT BROWSER'S HTTP CACHE. A proxied picture is
 * kept a day in it (`routes/privacy.ts`), where the web client's own wipe cannot reach, so every
 * response that expires `tf_session` carries `Clear-Site-Data: "cache"`: the sign-out, the erase,
 * and the refused refresh a browser signed out elsewhere meets next. Driven over the real route
 * table; the census below holds every jar-emptying call to the one helper.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
const CLEARS = "clear-site-data";

/** The cookie jar a signed-in browser presents, CSRF header included. */
function browser(token: string): { cookie: string; headers: Record<string, string> } {
  return { cookie: `tf_session=${token}; tf_csrf=${csrfTokenFor(token)}`, headers: { "x-csrf-token": csrfTokenFor(token) } };
}

async function seedRefresh(
  db: Awaited<ReturnType<typeof makeDeps>>["db"],
  s: { accountId: string; userId: string; sessionId: string },
): Promise<string> {
  const refresh = generateToken();
  await db.insert(refreshTokens).values({
    accountId: s.accountId, userId: s.userId, sessionId: s.sessionId, familyId: randomUUID(),
    tokenHash: hashToken(refresh), expiresAt: new Date(FIXED_NOW.getTime() + 2 * 60 * 60 * 1000),
  });
  return refresh;
}

function expectSessionEnded(res: Response, what: string): void {
  expect(cookieMaxAge(res, "tf_session"), `${what}: the jar is emptied`).toBe(0);
  expect(res.headers.get(CLEARS), `${what}: the browser's cache goes with it`).toBe('"cache"');
}

describe("every response that ends a browser session clears the browser's cache", () => {
  it("the sign-out", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("POST", "/auth/logout", browser(s.token)), deps);
    expect(res.status).toBe(204);
    expectSessionEnded(res, "POST /auth/logout");
  });

  it("the web's sign-out door, its 204 and its own 401 alike", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const refresh = await seedRefresh(db, s);
    const jar = browser(s.token);
    const ended = await H(req("POST", "/auth/refresh/logout", { ...jar, cookie: `${jar.cookie}; tf_refresh=${refresh}` }), deps);
    expect(ended.status).toBe(204);
    expectSessionEnded(ended, "the door's 204");
    const named = await H(req("POST", "/auth/refresh/logout"), deps);
    expect(named.status).toBe(401);
    expectSessionEnded(named, "the door's 401");
  });

  it("the erase", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await H(req("DELETE", "/account", browser(s.token)), deps);
    expect(res.status).toBe(200);
    expectSessionEnded(res, "DELETE /account");
  });

  /**
   * SIGNED OUT ELSEWHERE. Another session signs every device out; this browser's next request
   * answers 401 with the cache kept — that 401 also answers a live session whose access token
   * another tab just rotated — and its refresh, refused, is where the session is found gone.
   */
  it("a session revoked from another device is told at its refused refresh", async () => {
    const { db, deps } = await makeDeps();
    const here = await seedSession(db, { now: FIXED_NOW });
    const refresh = await seedRefresh(db, here);
    const elsewhere = await seedSessionFor(db, {
      accountId: here.accountId, userId: here.userId, now: FIXED_NOW, lastTwofaAt: FIXED_NOW,
    });
    const all = await H(req("POST", "/auth/logout", { bearer: elsewhere.token, body: JSON.stringify({ allDevices: true }) }), deps);
    expect(all.status).toBe(204);
    expectSessionEnded(all, "the device that signed everybody out, its own session included");

    const next = await H(req("GET", "/auth/session", { cookie: `tf_session=${here.token}` }), deps);
    expect(next.status).toBe(401);
    expect(next.headers.get(CLEARS), "a 401 the client may still recover from keeps the cache").toBeNull();

    const refused = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${refresh}`, body: "{}" }), deps);
    expect(refused.status).toBe(401);
    expectSessionEnded(refused, "the refused refresh");
  });

  it("a response that keeps the session keeps the cache (positive controls)", async () => {
    const { db, deps } = await makeDeps();
    const rotating = await seedSession(db, { now: FIXED_NOW });
    const refresh = await seedRefresh(db, rotating);
    const rotated = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${refresh}`, body: "{}" }), deps);
    expect(rotated.status).toBe(204);
    expect(setCookieMap(rotated).tf_session, "the rotation sets a session").toBeTruthy();
    expect(rotated.headers.get(CLEARS)).toBeNull();
    const s = await seedSession(db, { now: FIXED_NOW });
    const session = await H(req("GET", "/auth/session", { cookie: `tf_session=${s.token}` }), deps);
    expect(session.status).toBe(200);
    expect(session.headers.get(CLEARS)).toBeNull();
    // A host that takes no cookies ends a bearer's session with nothing to clear.
    const bearerOnly = { ...deps, allowCookieAuth: false };
    const out = await H(req("POST", "/auth/logout", { bearer: s.token }), bearerOnly);
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie()).toEqual([]);
    expect(out.headers.get(CLEARS)).toBeNull();
  });

  it("a proxied picture carries no validator a stale copy could be revalidated by", async () => {
    const remote = { async fetch() { return { status: 200, contentType: "image/png", body: PNG_2X3 }; } };
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { remote });
    const s = await seedSession(db, { now: FIXED_NOW });
    const { id } = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
    await seedBody(db, { messageId: id, html: "<img>", loadedRemoteContent: true });
    const u = encodeURIComponent("https://images.acme-cdn.com/hero.png");
    const res = await H(req("GET", `/img?mid=${id}&u=${u}`, { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(res.headers.get("etag")).toBeNull();
    expect(res.headers.get("last-modified")).toBeNull();
    // `Vary: Cookie`, by ruling (IMG-CACHE-KEPT-WHERE-CLEAR-SITE-DATA-IS-IGNORED): the jar changes at
    // every refresh, so the day becomes fifteen minutes, and a browser that ignores Clear-Site-Data
    // can no longer hand the next session a picture it was shown in this one.
    expect(res.headers.get("vary")).toBe("Cookie");
    expect(res.headers.get(CLEARS)).toBeNull();
  });
});

describe("the helper decides by the response's own cookies", () => {
  it("only an expired tf_session line counts", async () => {
    const { sessionEnded } = await import("../src/session-end.js");
    const with_ = (...cookies: string[]): Response => {
      const h = new Headers();
      for (const c of cookies) h.append("Set-Cookie", c);
      return new Response(null, { status: 204, headers: h });
    };
    const stamped = (r: Response) => sessionEnded(r).headers.get(CLEARS);
    expect(stamped(with_("tf_session=; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=0"))).toBe('"cache"');
    expect(stamped(with_("tf_session=abc; HttpOnly; Path=/; Max-Age=900"))).toBeNull();
    expect(stamped(with_("tf_session_other=; Path=/; Max-Age=0"))).toBeNull();
    expect(stamped(with_("tf_csrf=; Path=/; Max-Age=0"))).toBeNull();
    expect(stamped(with_("tf_session=; Path=/; Max-Age=00"))).toBe('"cache"');
    expect(stamped(with_())).toBeNull();
    const kept = sessionEnded(with_("tf_session=; Path=/; Max-Age=0", "tf_csrf=; Path=/; Max-Age=0"));
    expect(kept.status).toBe(204);
    expect(kept.headers.getSetCookie(), "the cookies ride through unchanged").toHaveLength(2);
  });
});

/* ── THE CENSUS: the jar is emptied only inside `sessionEnded(` ─────────────────────────────── */

const SRC = join(import.meta.dirname, "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Every `clearSessionCookies(` call outside its definition, and whether a `sessionEnded(` encloses it. */
function clearingCalls(files: Array<{ path: string; text: string }>): Array<{ at: string; wrapped: boolean }> {
  const out: Array<{ at: string; wrapped: boolean }> = [];
  for (const f of files) {
    const code = scan.withoutCommentsAndLiterals(f.text);
    const spans = [...code.matchAll(/\bsessionEnded\s*\(/g)]
      .map((m) => scan.bracketSpan(code, m.index! + m[0].length - 1))
      .filter((s) => s.closed);
    for (const m of code.matchAll(/\bclearSessionCookies\s*\(/g)) {
      if (/function\s+$/.test(code.slice(Math.max(0, m.index! - 16), m.index!))) continue;
      out.push({
        at: `${relative(SRC, f.path)}:${scan.lineOf(code, m.index!)}`,
        wrapped: spans.some((s) => s.start <= m.index! && m.index! < s.end),
      });
    }
  }
  return out;
}

describe("census — every response that empties the jar goes through the helper", () => {
  const files = sources(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

  it("the six jar-emptying calls are all inside `sessionEnded(`", () => {
    const calls = clearingCalls(files);
    // Sign-out, the erase, the refused refresh, the erased account's refresh (its 410), and the
    // web's sign-out door (its 204 and its own 401).
    expect(calls.map((c) => c.at.replace(/:\d+$/, "")).sort()).toEqual([
      "routes/account.ts", "routes/session-lifecycle.ts", "routes/session-lifecycle.ts",
      "routes/session-lifecycle.ts", "routes/session-lifecycle.ts", "routes/session-lifecycle.ts",
    ]);
    expect(calls.filter((c) => !c.wrapped).map((c) => c.at), "a session-ending response without the header").toEqual([]);
  });

  it("…and a planted route that empties the jar without it reads red (control)", () => {
    const bare = { path: join(SRC, "routes", "planted.ts"), text: "export const h = () => noContent(clearSessionCookies());\n" };
    const wrapped = { path: join(SRC, "routes", "planted2.ts"), text: "export const h = () => sessionEnded(noContent(clearSessionCookies()));\n" };
    const calls = clearingCalls([bare, wrapped]);
    expect(calls.filter((c) => !c.wrapped).map((c) => c.at)).toEqual(["routes/planted.ts:1"]);
    expect(calls.find((c) => c.at === "routes/planted2.ts:1")?.wrapped).toBe(true);
  });
});
