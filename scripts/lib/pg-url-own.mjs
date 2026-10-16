/**
 * ONE PREDICATE FOR "THIS FILE DECIDES WHICH POSTGRES IT REACHES", read by BOTH gates. `PG_TEST_URL` is the
 * single place that decides which database a test opens, and `scripts/lane-db.sh` redirects it to this
 * worktree's own; a file that spells the URL out again reaches the SHARED box while the box selector, seeing
 * only Postgres markers, reports the worktree needs no lock — an unlocked write into another lane's suite,
 * measured (`search-punctuation.pg.test.ts` derived
 * `process.env.DATABASE_URL_SESSION ?? … ?? "postgres://…/trafficflow_test"`, ran lane-db-safe, and only
 * `test/pg-url-one-resolver.test.ts` saw it). The two gates share this module rather than each carrying a
 * copy (two copies of a regex drift silently; "verification shares the assumption"). THE RULE IS A PAIR: a
 * file that OPENS a client may not DERIVE its own URL; one that derives a URL and opens nothing is fixture data and is admitted. */

/** Source with comments removed, so a URL named in prose cannot select a file. Strings stay: a
 *  literal `postgres://…` is exactly the thing being looked for and only ever appears in one. */
export function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** Opens a Postgres client, or hands a URL to something that does. */
export const OPENS_PG = /\b(?:postgres|makeDb|makeOwnedDb|makePooledDb|runMigrations|prepareIsolatedDb)\s*\(/;

/**
 * Spells a test database out for itself instead of importing the resolver.
 *
 * The env pattern excludes an ASSIGNMENT (`process.env.DATABASE_URL_SESSION = PG_TEST_URL`), which
 * is how a test configures the host under test and is a USE of the resolver rather than a second
 * one; `=== ` still reads as a read, since the lookahead wants a single `=`.
 */
export const DERIVES_URL = [
  /\btrafficflow_test\b/,
  /\bprocess\.env\.DATABASE_URL(?:_SESSION|_PG_TEST)?(?![A-Z_])(?!\s*=[^=])/,
];

/** The two files that own the fallback URL by design — the resolver and the lane-db script. */
export const URL_OWNERS = new Set(["packages/db/src/testing.ts", "scripts/lane-db.mjs"]);

export function opensPgClient(src) { return OPENS_PG.test(code(src)); }
export function derivesOwnUrl(src) { const c = code(src); return DERIVES_URL.some((re) => re.test(c)); }

/**
 * Does this file decide its own Postgres URL — so that no lane database can vouch for it?
 *
 * @param {string} src  the file's source
 * @param {string} [rel] its repo-relative path, for the two owners above
 */
export function ownsItsPgUrl(src, rel = "") {
  if (URL_OWNERS.has(rel)) return false;
  return opensPgClient(src) && derivesOwnUrl(src);
}
