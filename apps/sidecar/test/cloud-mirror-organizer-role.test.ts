import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * ═══ THE MIRROR CARRIES THE ORGANIZING ROLE — and what a mirrored role MEANS ════════════════
 *
 * ── THE ROW, AND WHY ITS STATED BLAST RADIUS IS FALSE ───────────────────────────────────────
 *
 * The defect report says a Cloud-connected desktop "mirrors a mailbox Cloud says it
 * only READS as one it organizes", and that "the desktop's own surfaces would permit moves, rules
 * and schedules on a mailbox the hosted side is a reader of" because the local write doors read the
 * LOCAL row through `assertOrganizerRole`.
 *
 * The projection half is true and is fixed here. **The consequence is not**, and the census that
 * settles it already existed: a Cloud-mode engine serves NO mutation. Every write is forwarded to
 * Cloud with the bearer (`cloud-engine.ts`: "READS are served from the mirror it already holds, and
 * every WRITE ... is FORWARDED to Cloud"), and `cloud-engine-census.test.ts` fails the moment that
 * module graph reaches any of the three modules an organizer is built from. So none of the eleven
 * `assertOrganizerRole` sites can run on that door, and the local row is not the authority the row
 * assumes.
 *
 * ── WHAT WAS ACTUALLY BROKEN, THEN ──────────────────────────────────────────────────────────
 *
 * The READ surfaces. `GET /mailboxes` is served from this mirror, so with the facts dropped a
 * Cloud-connected desktop's mailbox pane could not say who organizes the mailbox — the reader
 * banner had no source, on the one door where somebody else genuinely holds it.
 *
 * ── AND THE DOOR SWITCH ─────────────────────────────────────────────────────────────────────
 *
 * It was already safe and for a reason the row did not name: `organize_consented_at` was equally
 * unmirrored, so a switched install found it NULL and `mayOrganize` refuses on
 * `!consented && !takeoverAuthorized`. That safety rested on a column being ABSENT. It now rests on
 * the role saying so.
 *
 * Source-read rather than driven: the subject is which KEYS one projection object carries, and the
 * upsert it feeds is `onConflictDoUpdate`'s set. `cloud-mirror.test.ts` drives the mirror itself.
 */

const SRC = readFileSync(
  fileURLToPath(new URL("../src/cloud-mirror.ts", import.meta.url)), "utf8",
);
const MAILBOX_ROW = SRC.slice(SRC.indexOf("function mailboxRow("), SRC.indexOf("function mailboxReferenced("));

describe("the mirrored mailbox row carries mail 0083's facts", () => {
  it("all six, so the mirrored row cannot contradict the DTO it was built from", () => {
    for (const key of [
      "organizerRole", "organizedByKind", "organizedByName",
      "organizedSince", "organizerState", "organizeConsentedAt",
    ]) {
      expect(MAILBOX_ROW, `${key} is dropped on the way to the local row`).toContain(`${key}:`);
    }
  });

  it("the ROLE defaults to `organizer`, which is the column's own default and the safe direction", () => {
    // A host too old to send the field cannot have demoted anybody; the dangerous default is the
    // other one, which would put a reader banner over a mailbox this account organizes.
    expect(MAILBOX_ROW).toContain('organizerRole: m.organizerRole ?? "organizer"');
  });

  it("every other field is `?? null`, because this object IS the onConflictDoUpdate set", () => {
    // The file's own rule: a key left out makes a value CLEARED on Cloud persist locally, so a
    // mailbox whose holder released would keep naming them for ever.
    for (const line of ["organizedByKind: m.organizedBy?.kind ?? null",
                        "organizedByName: m.organizedBy?.name ?? null",
                        "organizerState: m.organizerState ?? null"]) {
      expect(MAILBOX_ROW).toContain(line);
    }
  });

  it("the two INSTANTS go through `asDate`, like every other timestamp on this row", () => {
    // They arrive as ISO strings on the DTO and the column is `timestamptz`; the neighbouring
    // `failedAt` and `createdAt` take the same conversion.
    expect(MAILBOX_ROW).toContain("organizedSince: asDate(");
    expect(MAILBOX_ROW).toContain("organizeConsentedAt: asDate(");
  });

  it("CONTROL: the fields it already carried are untouched", () => {
    // The change is additive; a projection that lost `disabledReason` while gaining the role
    // would trade one silent omission for another.
    for (const key of ["status:", "disabledReason:", "syncBlockedReason:", "createdAt:"]) {
      expect(MAILBOX_ROW).toContain(key);
    }
  });
});
