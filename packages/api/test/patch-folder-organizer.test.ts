import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { folderState, mailboxes, messages, organizerRequests } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { makeDeps, seedSession, seedMailbox, seedMessage, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  `PATCH /messages/:id { folder }` ASKS WHO ORGANIZES THE MAILBOX — through the ROUTE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `POST /messages/:id/move` and this route write the SAME row the SAME way —
 * `folder_state.desired_folder` with `last_set_by: 'us'`, plus a `move` change — and the reconciler
 * turns either into a physical IMAP move. Mail 0083 gated `move` and `delete`; it did not gate this
 * third spelling, and nothing else did either. A reader could therefore re-file mail by naming a
 * folder in a PATCH: the row was written, the DTO and the mirror both reported the message moved,
 * and the mail server was never told — with the intent left behind to fire on any later promotion.
 *
 * ── WHAT THE ANSWER IS NOW, AND WHY IT IS TWO ANSWERS ──────────────────────────────────────
 *
 * The `folder` half is decided by what the install holding the mailbox can actually carry out,
 * not by the fact that this install only reads:
 *
 *   holder advertises `moves`  ⇒  202, and the press becomes a `message.move` request that install
 *                                 performs on its next pass. Nothing moves here, deliberately.
 *   holder advertises less     ⇒  409 `organized_elsewhere`, `details.reason: organizer_outdated`,
 *                                 and nothing is written or queued.
 *   no holder at all           ⇒  409, `details.reason: no_organizer`.
 *
 * BOTH ARMS ARE DRIVEN HERE, and the 202 arm is why this file changed. The route reads
 * `if (pending) … status: 202` — one branch, on one line, that no test reached through the door:
 * the service-level file `packages/services/test/reader-patch-folder.test.ts` proves the branch
 * inside `MessageService.patch` and says nothing about whether the route returns 202 for it, which
 * is this file's own standing argument turned on the new behaviour.
 *
 * ── DRIVEN THROUGH THE ROUTE AND NOT THE SERVICE, DELIBERATELY ─────────────────────────────
 *
 * A refusal is only as real as the pipeline the route actually runs. `/pair/redeem` carried a
 * correct-looking cross-account rule for two rounds while its pipeline omitted the stage that
 * supplied one of the operands, so the rule compared an always-empty value and refused nothing.
 * The lesson generalises: the operands here are the caller's account (from the bearer, resolved by
 * the route's session stage) and the message's mailbox (from the row). Exercising the service
 * function directly would prove the branch and say nothing about whether the door runs it.
 *
 * No IMAP anywhere in this file: this route only ever writes desired state.
 */

/** A mailbox this install READS — demoted exactly as the worker's lease gate demotes it.
 *
 * `capabilities` is the operand the two arms differ on, and it is a PARAMETER rather than a second
 * fixture because the difference between them is one column. Left unset it is NULL, which is a
 * holder that advertises nothing — the state every case in this file asserted before the request
 * arm existed, and the reason those cases still read 409. */
async function readerWorld(
  db: Awaited<ReturnType<typeof makeDeps>>["db"],
  capabilities: string | null = null,
) {
  const s = await seedSession(db, { now: FIXED_NOW });
  const mailboxId = await seedMailbox(db, { accountId: s.accountId });
  await db.update(mailboxes).set({
    organizerRole: "reader",
    organizerState: "held",
    organizedByCapabilities: capabilities,
    organizedByKind: "cloud",
    organizedByName: "ohmail Cloud",
    organizedSince: new Date("2026-08-20T08:30:00.000Z"),
  }).where(eq(mailboxes.id, mailboxId));
  const m = await seedMessage(db, {
    accountId: s.accountId, mailboxId, folder: "INBOX", observedFolder: "INBOX",
    lastSetBy: "external", unread: true,
  });
  return { s, mailboxId, id: m.id };
}

describe("PATCH /messages/:id { folder } on a mailbox another install organizes", () => {
  it("a holder that cannot move is 409 organizer_outdated, and the mirror row is untouched", async () => {
    const { db, deps } = await makeDeps();
    const { s, id } = await readerWorld(db);

    const res = await H(req("PATCH", `/messages/${id}`, {
      bearer: s.token, body: JSON.stringify({ folder: "ohmail/News" }),
    }), deps);

    expect(res.status).toBe(409);
    // `{ error: { code, message, details } }` — the envelope `errorResponse` writes.
    const body = await res.json();
    expect(body.error.code).toBe("organized_elsewhere");
    // WHICH refusal, not merely that there was one. Without this the case cannot be told apart
    // from the arm below it, and a rule that routed nothing would satisfy both.
    expect(body.error.details.reason).toBe("organizer_outdated");
    // The three fields a sentence needs — without them the client has to compose a guess.
    expect(body.error.details.by).toEqual({
      kind: "cloud", name: "ohmail Cloud", since: "2026-08-20T08:30:00.000Z",
    });

    // NOTHING WAS WRITTEN. A refusal that had already written `desired` would leave a move queued
    // to fire on the next promotion, which is the half that outlives the request.
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs).toMatchObject({
      desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "external",
    });
  });

  it("POSITIVE CONTROL — the same PATCH on an ORGANIZER mailbox still files the message", async () => {
    // Without this the case above proves only that the route is broken. `seedMailbox` leaves the
    // schema default, `organizer_role = 'organizer'`.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const { id } = await seedMessage(db, {
      accountId: s.accountId, mailboxId, folder: "INBOX", observedFolder: "INBOX",
    });

    const res = await H(req("PATCH", `/messages/${id}`, {
      bearer: s.token, body: JSON.stringify({ folder: "ohmail/News" }),
    }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).folder).toBe("ohmail/News");
    expect(res.headers.get("x-sync-seq")).toBeTruthy();

    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs).toMatchObject({
      desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us",
      reconcileStatus: "pending",
    });
  });

  it("POSITIVE CONTROL — a reader can still mark its own mail read", async () => {
    /* THE HALF A CARELESS FIX TAKES AWAY. `\Seen` is the reader's ONE legitimate IMAP write and
     * `reconcileFlags` runs on a reader cycle on purpose. Gating the whole PATCH door instead of
     * its `folder` branch would remove this — and every refusal assertion above would still be
     * green, so nothing in the suite would say so. */
    const { db, deps } = await makeDeps();
    const { s, id } = await readerWorld(db);

    const res = await H(req("PATCH", `/messages/${id}`, {
      bearer: s.token, body: JSON.stringify({ unread: false }),
    }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).unread).toBe(false);

    const [m] = await db.select().from(messages).where(eq(messages.id, id));
    expect(m!.unread).toBe(false);
  });

  it("a capable holder's PATCH { folder } is 202, the request is queued, and nothing moves here", async () => {
    /* THE ARM THE ROUTE GAINED. 200 is a move made and 202 is a move asked for; the DTO still
     * describes what this store did, and `pending` names the install being waited on. */
    const { db, deps } = await makeDeps();
    const { s, mailboxId, id } = await readerWorld(db, "requests,moves");

    const res = await H(req("PATCH", `/messages/${id}`, {
      bearer: s.token, body: JSON.stringify({ folder: "ohmail/News" }),
    }), deps);

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.pending).toBe(true);
    expect(body.holder).toMatchObject({ kind: "cloud", name: "ohmail Cloud" });
    expect(typeof body.requestId).toBe("string");
    // AND NO SYNC SEQUENCE. Nothing in this store changed, so there is nothing for a client to
    // catch up to; a header announcing a new sequence here would be the false state in miniature.
    // The case below, whose `unread` half does land, carries one — that is the discriminator
    // between "asked for" and "partly done", and asserting only the 202 would not see it.
    expect(res.headers.get("x-sync-seq")).toBeNull();

    const rows = await db.select().from(organizerRequests)
      .where(eq(organizerRequests.mailboxId, mailboxId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "message.move", state: "pending" });
    expect(rows[0]!.payload).toMatchObject({ destination: "reads" });

    // NOTHING MOVED HERE — the half a wrong fix loses. The install holding the mailbox is the one
    // connected to the mail server, so a row written here would either do nothing or fire later.
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs).toMatchObject({
      desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "external",
    });
  });

  it("a capable holder's PATCH { unread, folder } lands the read HERE and routes only the move", async () => {
    /* The two halves are separately permitted, so they are separately decided: marking read is the
     * reader's one legitimate IMAP write and it happens locally, while the folder half travels.
     * The 409 case below is the same request shape against a holder that cannot move, where the
     * whole patch is refused instead — the difference is the holder, not the payload. */
    const { db, deps } = await makeDeps();
    const { s, mailboxId, id } = await readerWorld(db, "requests,moves");

    const res = await H(req("PATCH", `/messages/${id}`, {
      bearer: s.token, body: JSON.stringify({ unread: false, folder: "ohmail/News" }),
    }), deps);

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.pending).toBe(true);
    expect(body.dto.unread).toBe(false);
    // A sequence, unlike the folder-only case above: the read really did land here.
    expect(res.headers.get("x-sync-seq")).toBeTruthy();

    const [m] = await db.select().from(messages).where(eq(messages.id, id));
    expect(m!.unread).toBe(false);

    const rows = await db.select().from(organizerRequests)
      .where(eq(organizerRequests.mailboxId, mailboxId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "message.move" });
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs!.desiredFolder).toBe("INBOX");
  });

  it("a PATCH carrying BOTH is refused whole when the holder cannot move — the read does not land", async () => {
    /* One transaction, so the refusal in the `folder` half rolls the `unread` half back with it.
     * Stated as a case rather than left to be inferred: the alternative reading — "apply what is
     * permitted, refuse the rest" — is what the arm ABOVE does, and it does it because that
     * holder can carry the move out. Here nothing can, so a person told `409` whose message had
     * quietly become read would have no way to know. */
    const { db, deps } = await makeDeps();
    const { s, id } = await readerWorld(db);

    const res = await H(req("PATCH", `/messages/${id}`, {
      bearer: s.token, body: JSON.stringify({ unread: false, folder: "ohmail/News" }),
    }), deps);
    expect(res.status).toBe(409);

    const [m] = await db.select().from(messages).where(eq(messages.id, id));
    expect(m!.unread).toBe(true);
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs!.desiredFolder).toBe("INBOX");
  });
});
