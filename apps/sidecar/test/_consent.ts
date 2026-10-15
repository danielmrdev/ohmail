import { isNull } from "drizzle-orm";
import { mailboxes } from "@trafficflow/db";
import type { Sidecar } from "../src/engine.js";

/**
 * ── THIS INSTALL HAS AGREED TO ORGANIZE THE MAILBOX ─────────────────────────────────────────
 *
 * A fresh local row is a consent-less READER. (2026-09-02) put the check for that
 * ahead of the lease read in `engine.ts`, and deliberately so: asking `runLeaseGate` at all is
 * already TAKING the mailbox, because on an empty `ohmail/_meta` it appends this install's claim.
 * So a launch with no consent stamp returns before the lease, before `ensureFolders`, and before
 * anything is filed — `organizerState()` stays `{ organizing: false, reason: null, heldBy: null }`
 * and the server never grows an `ohmail/*` tree.
 *
 * That is the product working. It is also the wrong PREMISE for the e2e files that call this,
 * every one of which is about what an install that DOES organize goes on to do — and while
 * GreenMail was unreachable, none of them could say so. What they said instead was
 * `NO SELECT failed. No such mailbox` for `ohmail.Screener`, which reads like an IMAP fault.
 *
 * Written on the columns rather than through the consent route because the route is a hosted
 * HTTP door these tests do not stand up; the pair below is exactly what it commits (see
 * `organize-here.ts`, and `reader-drain.test.ts`, which already does this inline).
 *
 * GUARDED ON A NULL STAMP so a store with history keeps its own — a blanket write would move a
 * baseline the test had deliberately set and the case would pass for the wrong reason.
 */
export async function grantOrganizeConsent(sidecar: Sidecar): Promise<void> {
  await sidecar.db.update(mailboxes)
    .set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
    .where(isNull(mailboxes.organizeConsentedAt));
}
