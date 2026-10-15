import { describe, expect, it } from "vitest";
import type { EntityReader } from "@ohmail/client-engine";
import { liveScheduled } from "../src/state/live";
import { Copy } from "../src/copy";

/**
 * ═══ WHAT THE PHONE'S SCHEDULED SCREEN SAYS AFTER A HANDOVER ═════════════════════════════
 *
 * `QAO-SCHEDULED-SEND-ORPHANED-BY-MIGRATION` reaches this surface too, and it reaches it
 * differently from the webapp's, which is why it is asserted rather than assumed.
 *
 * On the webapp a closed appointment falls into the Drafts list underneath with its refusal
 * quoted. `liveScheduled` lists `sendError` drafts BESIDE the standing appointments on purpose —
 * filtered the same way, a message the reader scheduled would vanish from this screen with
 * nothing said, and "it disappeared" reads as "it was sent". The phone now HAS a Drafts screen
 * (`live.ts#liveDrafts`) and such a row is on both: Scheduled answers "what
 * happened to my appointment" and Drafts answers "what have I not sent", and the row is
 * genuinely both — suppressing it on either would hide it from whoever came looking on that one.
 *
 * So the stand-down sentence lands here, and this file checks that landing is the INTENDED
 * presentation per the send-window contract rather than an accident of a shared selector:
 *
 *  · the row is still on screen, with the message in it;
 *  · `when` is null and `cancellable` is false — no appointment stands, so there is no time to
 *    name and nothing left to cancel. A Cancel here would be a control for an act with nothing
 *    to act on, and it is withheld;
 *  · the sentence is quoted VERBATIM inside the phone's own frame, which is the webapp's frame
 *    word for word — one wording of "this did not send" across both clients.
 *
 * ── THE SENTENCE IS A LITERAL HERE, AND THAT IS PINNED FROM THE OTHER SIDE ───────────────
 *
 * The obvious move is to import `STAND_DOWN_SEND_SENTENCES` from the database package that defines
 * it. This app does not depend on that package and must not start to for a test: the phone's
 * bundle has no business naming the server's schema package — this directory's own privacy census
 * bans the name outright, which is how the first draft of this header was caught — and
 * `pnpm -F mobile typecheck`, which DOES typecheck this directory, would not resolve the import.
 * So the words are written out, and the drift that invites is closed from the server side instead:
 * `packages/db/test/stand-down-sends-census.test.ts` reads THIS FILE and asserts the sentence it
 * quotes is the one the database stores. Editing the copy without editing this file is red there.
 */

function readerOf(drafts: Record<string, unknown>[]): EntityReader {
  return {
    list: <T,>(type: string): T[] => (type === "draft" ? (drafts as unknown as T[]) : []),
    get: <T,>(type: string, id: string): T | undefined =>
      type === "draft" ? (drafts.find((d) => d.id === id) as T | undefined) : undefined,
  } as unknown as EntityReader;
}

const draftRow = (over: Record<string, unknown>) => ({
  id: "d-x", mailboxId: "mb-1", threadId: null, inReplyToMessageId: null,
  subject: "Invoice 12", body: "the body", to: [{ name: "Ada", address: "ada@fake.test" }],
  cc: [], bcc: [], rationale: null, status: "scheduled",
  createdAt: "2026-09-01T09:00:00.000Z", updatedAt: "2026-09-01T14:29:00.000Z",
  ...over,
});

const v = { now: new Date("2026-09-01T15:00:00.000Z"), zone: "UTC" };
/** `STAND_DOWN_SEND_SENTENCES["organized_elsewhere:local"]` — see the header for why it is typed
 *  out and where the parity is enforced. */
const SENTENCE =
  "ohmail on another machine took over organizing this mailbox, so the scheduled send was not "
  + "made here. Schedule it again where the mailbox is organized now.";

describe("a scheduled send a handover ended, on the phone", () => {
  it("stays on the Scheduled screen, says it was not sent, and offers nothing to cancel", () => {
    const rows = liveScheduled(readerOf([
      // Exactly what `closeStoodDownAppointments` leaves behind.
      draftRow({ id: "closed", status: "draft", sendAt: null, sendError: SENTENCE }),
      draftRow({ id: "standing", sendAt: "2026-09-02T09:00:00.000Z" }),
    ]), v);

    // Both are listed, and the closed one sorts LAST — no appointment stands, so there is no
    // time to order it by, and the reader's next action is about the one that still will send.
    expect(rows.map((r) => r.id)).toEqual(["standing", "closed"]);

    const closed = rows[1]!;
    expect(closed.subject, "the message itself must still be reachable — failing rather than "
      + "dropping it is the whole point").toBe("Invoice 12");
    expect(closed.failure).toBe(SENTENCE);
    expect(closed.when, "a closed appointment must not still name a time").toBeNull();
    expect(closed.cancellable, "Cancel on a closed appointment is a control for an act with "
      + "nothing to act on").toBe(false);
    expect(rows[0]!.cancellable).toBe(true);
  });

  it("the sentence the reader sees is the webapp's frame, word for word", () => {
    expect(Copy.scheduleFailedNote(SENTENCE)).toBe(
      "This message wasn't sent at its scheduled time: ohmail on another machine took over "
      + "organizing this mailbox, so the scheduled send was not made here. Schedule it again "
      + "where the mailbox is organized now.",
    );
    // And the badge beside it is the phone's own "Not sent" — the marker the webapp gets for
    // free from being a Drafts list and this screen has to supply.
    expect(Copy.scheduledNotSent).toBe("Not sent");
  });

  it("names no destination, so it stays true if the mailbox comes back to this machine", () => {
    // The reclaim ("Organize from this machine") can return the mailbox afterwards. A stored
    // sentence saying "schedule it again on ohmail Cloud" would then be standing advice to go
    // somewhere the mailbox no longer is — and `send_error` outlives its own occasion, so every
    // clause in it has to. The same rule over all three sentences is asserted where they live
    // (`packages/db/test/stand-down-sends-census.test.ts`); this is the one this screen renders.
    expect(SENTENCE).toContain("Schedule it again where the mailbox is organized now.");
    expect(SENTENCE, "the cause must be past tense — it is read long after the moment")
      .toMatch(/took over/);
  });
});
