/**
 * WHAT THE RELEASED BUILDS WROTE — the exact localStorage value each release's own writer produced.
 *
 * `apps/webapp/app/shell/send-lock.ts` was taken from the public mirror's `v0.14.0` and `v0.14.1`
 * tags (blobs byte-identical to the monorepo commits their `Monorepo-Commit` trailers name), run
 * unmodified under node with a Map-backed `localStorage`, and asked to `claimSendLock` over the
 * messages below (2026-09-22). Not a device: the record shape and the arithmetic are the release's
 * own, and a browser adds only the string it stores. The release's fingerprints matched the
 * goldens in `send-lock-durable.test.tsx` exactly.
 */

/** The message both jars were written over, and the compose session 0.14.1 recorded. */
export const RELEASED_REOPENED = {
  kind: "mail_send", inReplyTo: null, forwardOf: null, draftId: "draft-0140",
  mailboxId: "mb", subject: "Hallo",
  to: [{ name: null, address: "lena@atelier.example" }],
  body: "Donnerstag passt.",
} as const;
export const RELEASED_SESSION_0141 = "sess-0141";
/** Epoch ms of the press, 2026-08-10T12:00:00Z. */
export const RELEASED_AT = 1786363200000;

/** `claimSendLock` at v0.14.0, key. */
export const JAR_0_14_0 = "[{\"v\":1,\"lane\":\"compose\",\"key\":\"KEY-" + "0140\",\"at\":1786363200000,\"draftId\":\"draft-0140\",\"fp\":\"18d9e0n\"}]";
/** `claimSendLock` at v0.14.1, key with that build's subject and session. */
export const JAR_0_14_1 = "[{\"v\":2,\"lane\":\"compose\",\"key\":\"KEY-" + "0141\",\"at\":1786363200000,\"draftId\":\"draft-0140\",\"fp\":\"1rcnf0k\",\"subject\":\"draft:draft-0140\",\"session\":\"sess-0141\"}]";
