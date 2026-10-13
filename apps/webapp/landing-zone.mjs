/**
 * THE LANDING ZONE — the separate deployment that serves the website's paths on this origin.
 * `middleware.ts` rewrites those paths to it, and the request it hands over is REBUILT from an
 * allow-list of headers: the session cookie is host-only and this origin's alone, so the cookie
 * jar, `Authorization` and everything else not named below never leave. Pure like `routes.mjs` —
 * nothing here reads the environment, so the build (`next.config.mjs`) and the runtime
 * (`middleware.ts`) decide from one compiled list.
 */

/** The variable naming the zone, and the one carrying its deployment-protection bypass. */
export const ZONE_VAR = "LANDING_ZONE_ORIGIN";
export const ZONE_BYPASS_VAR = "LANDING_ZONE_BYPASS";

/** The only origins the website may be fetched from. Compiled: the variable selects, never defines. */
export const ALLOWED_LANDING_ZONES = Object.freeze(["https://site.ohmail.app"]);

/** Loopback is exempt, as in `app/api-origin.ts`: development and the e2e harness run against it. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The zone's origin, or null. `app/api-origin.ts`'s checks in its order: no path, query, fragment
 * or credentials; loopback on either scheme; otherwise https and listed. It never throws — a throw
 * in middleware is a 500 on the front door — and null serves the website from this deployment.
 *
 * @param {string | undefined | null} raw
 * @returns {string | null}
 */
export function resolveLandingZone(raw) {
  const value = (raw ?? "").trim();
  if (value === "") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (LOOPBACK.has(url.hostname.toLowerCase())) {
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  }
  if (url.protocol !== "https:") return null;
  if (!ALLOWED_LANDING_ZONES.includes(url.origin)) return null;
  return url.origin;
}

/**
 * The zone to route to, or null: a resolved zone AND a bypass, the one predicate the middleware
 * (per request) and the header rules (at build) both arm on. Without the bypass the zone answers
 * every request with its protection page, so the website is served from this deployment instead.
 *
 * @param {string | null} zone a value `resolveLandingZone` returned
 * @param {string} bypass the trimmed bypass, or ""
 * @returns {string | null}
 */
export function armedZone(zone, bypass) {
  return zone !== null && bypass !== "" ? zone : null;
}

/** The request headers the zone is handed — an allow-list; anything not named here stays behind. */
export const ZONE_FORWARDED_HEADERS = Object.freeze([
  "accept", "accept-encoding", "accept-language", "user-agent", "content-type", "content-length",
  "rsc", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch", "next-url",
  "if-none-match", "if-modified-since", "range",
]);

/**
 * A NEW header set holding only the allow-listed headers present, plus the bypass. Never a copy of
 * the request with names deleted: a deny-list misses the header nobody thought of. The bypass is
 * always set, so the override list Next sends is never empty — an empty one replaces nothing.
 *
 * @param {Headers} requestHeaders
 * @param {string} bypass
 * @returns {Headers}
 */
export function zoneRequestHeaders(requestHeaders, bypass) {
  const out = new Headers();
  for (const name of ZONE_FORWARDED_HEADERS) {
    const value = requestHeaders.get(name);
    if (value !== null) out.set(name, value);
  }
  out.set("x-vercel-protection-bypass", bypass);
  return out;
}

/**
 * Where a request for `pathname` + `search` goes on the zone. Set onto the zone's own URL rather
 * than resolved against it, so no path can name a host: `//elsewhere/x` stays on the zone.
 *
 * @param {string} zone
 * @param {string} pathname
 * @param {string} search
 * @returns {URL}
 */
export function zoneTarget(zone, pathname, search) {
  const url = new URL(zone);
  url.pathname = pathname;
  url.search = search;
  return url;
}
