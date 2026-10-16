import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { mailboxProfileMirror, mailboxes } from "@trafficflow/db";
import { eq, sql } from "drizzle-orm";
import { makeDeps, seedSession, seedMailbox, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  `GET /mailboxes/:id/profile` — the settings actually in force, for a mailbox we only read
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The panes for the responder, the rules, the window and the signature used to render THIS
 * install's own rows on a mailbox another install organizes. Those rows are inert there: the
 * settings in force are the ones in the organizing install's published document. That is ruling
 * 6's Critical seen from the read side, and this route is what a pane reads instead.
 *
 * ── THE FOUR STATES ARE THE WHOLE POINT, SO EACH HAS ITS OWN CASE ──────────────────────────
 *
 * A `null` document meaning both "we have not read one yet" and "this install owns the settings"
 * is the collapse this repository has already shipped once, where an optional prop's null made
 * every door refuse with a sentence about another install. So `organizing` is explicit, `from`
 * carries the holder or a null KIND, and a missing document is a MISSING ROW rather than a row of
 * nulls.
 */

const DOC = {
  v: 1,
  updatedAt: "2026-09-06T10:00:00.000Z",
  producer: { kind: "cloud", version: "0.15.0" },
  screener: [], rules: [], notifyRules: [], tagNames: [],
  awayResponder: { enabled: true, body: "Back Monday.", startsAt: null, endsAt: null, audience: "everyone", throttle: "per_day" },
  signature: "— Mila",
};

async function readerMailbox(db: Awaited<ReturnType<typeof makeDeps>>["db"]) {
  const s = await seedSession(db, { now: FIXED_NOW });
  const mailboxId = await seedMailbox(db, { accountId: s.accountId });
  await db.update(mailboxes).set({
    organizerRole: "reader", organizerState: "held",
    organizedByKind: "cloud", organizedByName: "ohmail Cloud",
    organizedSince: new Date("2026-08-20T08:30:00.000Z"),
  }).where(eq(mailboxes.id, mailboxId));
  return { s, mailboxId };
}

describe("GET /mailboxes/:id/profile", () => {
  it("a mirrored document is served with WHO it came from and WHEN it was read", async () => {
    const { db, deps } = await makeDeps();
    const { s, mailboxId } = await readerMailbox(db);
    await db.insert(mailboxProfileMirror).values({
      mailboxId, accountId: s.accountId,
      uidvalidity: 1757000000n, uid: 42,
      doc: DOC, readAt: new Date("2026-09-06T10:05:00.000Z"),
    });

    const res = await H(req("GET", `/mailboxes/${mailboxId}/profile`, { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.organizing).toBe(false);
    expect(body.profile).toEqual(DOC);
    expect(body.from).toEqual({
      kind: "cloud", name: "ohmail Cloud", since: "2026-08-20T08:30:00.000Z",
    });
    /* `asOf` is not decoration. A reader that has been offline for a day has to be able to say so
       rather than present a day-old document as current. */
    expect(body.asOf).toBe("2026-09-06T10:05:00.000Z");
  });

  it("NO document yet is a missing row, and the holder is still named", async () => {
    // "No settings from <machine> yet" is a sentence; a row of nulls could not carry it, and would
    // be indistinguishable from a document that happens to say nothing.
    const { db, deps } = await makeDeps();
    const { s, mailboxId } = await readerMailbox(db);

    const body = await (await H(req("GET", `/mailboxes/${mailboxId}/profile`, { bearer: s.token }), deps)).json();
    expect(body.profile).toBeNull();
    expect(body.asOf).toBeNull();
    expect(body.organizing).toBe(false);
    expect(body.from).toMatchObject({ kind: "cloud", name: "ohmail Cloud" });
  });

  it("nobody known to hold it is a DIFFERENT state — `from.kind` is null", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    await db.update(mailboxes).set({ organizerRole: "reader" }).where(eq(mailboxes.id, mailboxId));

    const body = await (await H(req("GET", `/mailboxes/${mailboxId}/profile`, { bearer: s.token }), deps)).json();
    expect(body.profile).toBeNull();
    expect(body.from).toEqual({ kind: null, name: null, since: null });
    expect(body.organizing).toBe(false);
  });

  it("on a mailbox THIS install organizes it says so, and serves no mirror", async () => {
    /* THE STATE THAT MUST NOT COLLAPSE INTO "no document yet". The local rows ARE the settings
     * here, so the pane reads them directly — and a stale mirror row left from before this install
     * took the mailbox over must NOT be served, because it describes what somebody else last
     * published. Seeded deliberately to prove it is not read. */
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });   // default: organizer
    await db.insert(mailboxProfileMirror).values({
      mailboxId, accountId: s.accountId, uidvalidity: 1n, uid: 7,
      doc: { ...DOC, signature: "— from whoever used to organize this" },
      readAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    const body = await (await H(req("GET", `/mailboxes/${mailboxId}/profile`, { bearer: s.token }), deps)).json();
    expect(body.organizing).toBe(true);
    expect(body.profile).toBeNull();
    expect(body.asOf).toBeNull();
  });

  it("another account's mailbox is 404, and its document never leaks", async () => {
    const { db, deps } = await makeDeps();
    const owner = await readerMailbox(db);
    await db.insert(mailboxProfileMirror).values({
      mailboxId: owner.mailboxId, accountId: owner.s.accountId,
      uidvalidity: 5n, uid: 9, doc: DOC, readAt: FIXED_NOW,
    });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });

    const res = await H(req("GET", `/mailboxes/${owner.mailboxId}/profile`, { bearer: other.token }), deps);
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("Mila");
  });

  it("a mirror row whose account_id disagrees with the mailbox is REFUSED, and unserved if planted anyway", async () => {
    /* THE CASE THAT MAKES THE ACCOUNT PREDICATE WATCHABLE, and it exists because dropping that
     * predicate left every other case in this file GREEN: the cross-account request above is
     * already refused by the `mailboxes` lookup, so it measures that guard and says nothing about
     * this one. A mutation covered by a second mechanism measures the pair, not the part.
     *
     * RETIRED PREMISE, named rather than deleted: this case used to argue the state was
     * representable because the mirror's key was `mailbox_id` ALONE. Mail 0118 keys the PAIR, so
     * the invariant is the DATABASE's now and is asserted there first. The predicate is then still
     * driven, against a row planted with that one key dropped, so removing it from the query
     * reddens here rather than passing for nothing. */
    const { db, deps } = await makeDeps();
    const { s, mailboxId } = await readerMailbox(db);
    const stranger = await seedSession(db, { now: FIXED_NOW, token: "stranger-tok" });
    const row = {
      mailboxId, accountId: stranger.accountId,        // OUR mailbox, THEIR account id
      uidvalidity: 77n, uid: 3,
      doc: { ...DOC, signature: "— a stranger's sign-off" }, readAt: FIXED_NOW,
    };

    // A ONE-WORD VERDICT rather than `.rejects`, which on a live handle takes the worker with it.
    const verdict = await db.insert(mailboxProfileMirror).values(row).then(
      () => "admitted",
      (e: unknown) => (/mailbox_profile_mirror_mailbox_id_account_fk/.test(String(e))
        ? "refused-by-the-key" : `refused-otherwise:${String(e)}`),
    );
    expect(verdict, "the disagreeing row is representable again").toBe("refused-by-the-key");

    // With that ONE key dropped the row plants, so the query's account predicate is what decides.
    await db.execute(sql`alter table mailbox_profile_mirror
      drop constraint mailbox_profile_mirror_mailbox_id_account_fk`);
    await db.insert(mailboxProfileMirror).values(row);

    const res = await H(req("GET", `/mailboxes/${mailboxId}/profile`, { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile).toBeNull();
    expect(JSON.stringify(body)).not.toContain("stranger");
  });

  it("a REMOVED mailbox is 404, not a mailbox with no settings", async () => {
    const { db, deps } = await makeDeps();
    const { s, mailboxId } = await readerMailbox(db);
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mailboxId));

    const res = await H(req("GET", `/mailboxes/${mailboxId}/profile`, { bearer: s.token }), deps);
    expect(res.status).toBe(404);
  });

  it("it dials nothing — a mailbox with no stored credential still answers", async () => {
    /* THE COST CLASS IS A CLAIM. This route is `read`, and the Import press next door dials IMAP
     * and spends a slot from the per-mailbox connection cap. If this one dialled, the class would
     * be a lie and opening a settings pane would compete with syncing. A mailbox with no
     * credential row cannot be dialled at all, so answering 200 is the proof. */
    const { db, deps } = await makeDeps();
    const { s, mailboxId } = await readerMailbox(db);

    const res = await H(req("GET", `/mailboxes/${mailboxId}/profile`, { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).profile).toBeNull();
  });
});
