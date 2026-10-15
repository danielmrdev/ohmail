/**
 * ONE PREDICATE FOR "THIS FILE DECIDES WHICH IMAP SERVER IT REACHES", the mail box's sibling to
 * `pg-url-own.mjs`. `greenmailConfig()` in `packages/core/test/adapters/_imapenv.ts` is the single
 * place that decides the host and port a test dials; a file that spells them out again reaches the
 * shared GreenMail while the box selector, seeing none of the marker identifiers, can report it
 * needs no lock. THE RULE IS THE SAME PAIR: a file that OPENS an IMAP client may not derive its own
 * host or port; one that derives them and opens nothing is fixture data and is admitted.
 */
import { code } from "./pg-url-own.mjs";

export { code };

/** Opens an IMAP or SMTP client against something. */
export const OPENS_IMAP = /\bnew\s+ImapFlow\s*\(|\bcreateTransport\s*\(|\bImapAdapter\s*\(/;

/**
 * Spells the box's host or port out for itself instead of taking it from the resolver. Measured
 * over the suite BEFORE this rule was built: reading `process.env.IMAP_HOST` is 20 of the 22 hits
 * and it is a USE of the resolver, not a second one — the sidecar's and the worker's test dirs
 * cannot import core's test helper and read the same variable it reads. So the offence is a
 * LITERAL box port, which is the only spelling nothing can redirect.
 */
export const DERIVES_IMAP_HOST = [
  /(?:localhost|127\.0\.0\.1)["'\s:]*(?:3143|3025|4643|4625)\b/,
  /\b(?:port|smtpPort|imapPort)\s*:\s*(?:3143|3025)\b/,
];

/** The one file that owns the host and port by design. */
export const HOST_OWNERS = new Set(["packages/core/test/adapters/_imapenv.ts"]);

/** The module specifiers whose EDGE alone makes a file GreenMail class, whatever words it uses. */
export const GREENMAIL_EDGES = [/(^|\/)_imapenv(\.[cm]?[jt]s)?$/];

export function opensImapClient(src) { return OPENS_IMAP.test(code(src)); }
export function derivesOwnHost(src) { const c = code(src); return DERIVES_IMAP_HOST.some((re) => re.test(c)); }

/** Does this file decide its own IMAP host — so that nothing else can vouch for which server it dials? */
export function ownsItsImapHost(rel, src) {
  if (HOST_OWNERS.has(String(rel).replace(/\\/g, "/"))) return false;
  return opensImapClient(src) && derivesOwnHost(src);
}

/** Does this specifier reach the GreenMail resolver? The EDGE, not a word the file happens to spell. */
export function isGreenmailEdge(spec) { return GREENMAIL_EDGES.some((re) => re.test(String(spec).replace(/\.[cm]?js$/, ""))); }
