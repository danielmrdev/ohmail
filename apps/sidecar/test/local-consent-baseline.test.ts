import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freshDataDir } from "./_datadir.js";
import { eq } from "drizzle-orm";
import { accountSettings, mailboxes } from "@trafficflow/db";
import { DEFAULT_DORMANCY_DAYS } from "@trafficflow/core/mail";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld } from "../src/identity.js";
import { authorizeOrganizerTakeover, requestOrganizerTakeover } from "../src/organize-here.js";

/**
 * THE STANDALONE DOOR'S CONSENT WRITES THE BASELINE, OR THE WINDOW IS DECORATIVE.
 *
 * ── THE DEFECT, AS THE PERSON EXPERIENCES IT ────────────────────────────────────────────────
 *
 * The first-run flow asks two questions in one breath: may this machine organize your mail, and
 * how far back should it screen. On the standalone door the answer to the second was thrown away.
 * `organize_consented_at` and `takeover_authorized_at` were written; `account_settings` was never
 * touched at all.
 *
 * The cutline reads `(screeningBaselineAt ?? now()) - dormancyDays`. With no baseline the window
 * is measured from the moment of the READ rather than from the moment of the agreement, so on a
 * mailbox with any history at all every message older than the dial falls outside the window and
 * the whole backlog moves to `ohmail/Screener` — whatever the person chose, `all_time` included.
 * Nothing errors. The mailbox is simply reorganised against an answer nobody gave.
 *
 * ── WHY THE ASSERTIONS ARE ON COLUMNS, AND WHY ON ONE STATEMENT ─────────────────────────────
 *
 * "Which columns does one consent write" is the whole question, so the tests read the rows back.
 * The baseline's COALESCE is the second half: it must be written while NULL and never moved
 * afterwards, because moving it forward on a re-run slides a live install's cutline — the same
 * damage as having no baseline, arriving later and looking like a sync bug.
 *
 * ── AND THE STAMP IS NOT CONDITIONAL ON THE QUESTION BEING ASKED ────────────────────────────
 *
 * The write above was reached only `if (input.screening)`, so the two doors that ask no window —
 * the CLI, and Settings’ "Organize from this machine" — consented and left the baseline NULL,
 * which is the same damage by the same arithmetic. The baseline is a property of "this mailbox is
 * organized from now", not of a request field: every door stamps it, the window only chooses the
 * DIALS, and `writeConsentScreening` is the one writer of the column on this door.
 *
 * Mutation-checked, each watched red and restored:
 *  · drop the `account_settings` upsert            → the four-column test and the scope test;
 *  · write the baseline unconditionally (no COALESCE) → the re-run test;
 *  · store the dial even when it is the default    → the never-store-the-default test;
 *  · drop the bounds check                         → the refusal tests;
 *  · restore `if (input.screening)` around the stamp → the window-less consent tests, both doors.
 */

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const o of opens.splice(0)) await o.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** An account that is not the one this store’s mailbox belongs to. A uuid, because the column is. */
const SOMEBODY_ELSE = "00000000-0000-4000-8000-0000000000ff";

const t0 = new Date("2026-03-01T10:00:00.000Z");
const t1 = new Date("2026-06-01T10:00:00.000Z");

async function standUp(): Promise<{
  db: OpenLocalDb["db"]; accountId: string; mailboxId: string;
}> {
  const dataDir = await freshDataDir("ohmail-consent-baseline-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: "me@ohmail.test", now: t0 });
  // The state the flow's consent screen is reached in: a connected READER that nobody has yet
  // agreed to let organize. That is the first-consent case, not a claim-back.
  await opened.db.update(mailboxes)
    .set({ organizerRole: "reader", organizeConsentedAt: null })
    .where(eq(mailboxes.id, world.mailboxId));
  return { db: opened.db, accountId: world.accountId, mailboxId: world.mailboxId };
}

const settingsRow = async (db: OpenLocalDb["db"], accountId: string) =>
  (await db.select().from(accountSettings).where(eq(accountSettings.accountId, accountId)))[0];

const mailboxRow = async (db: OpenLocalDb["db"], id: string) =>
  (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;

describe("the standalone door's consent — one write, four columns", () => {
  it("CONSENT WRITES THE BASELINE, THE WINDOW AND THE SCOPE, not just the consent stamp", async () => {
    const { db, accountId, mailboxId } = await standUp();

    const out = await requestOrganizerTakeover(db, { intent: "takeover",
      mailboxId, accountId, now: t0,
      screening: { dormancyDays: 30, scope: "window" },
    });
    expect(out.outcome).toBe("authorized");

    const mb = await mailboxRow(db, mailboxId);
    expect(mb.organizeConsentedAt, "the consent itself").toEqual(t0);
    expect(mb.takeoverAuthorizedAt, "the one-shot stamp the gate spends").toEqual(t0);

    const s = await settingsRow(db, accountId);
    // THE ROW MUST EXIST AT ALL. Before this, the standalone door never created it, and every
    // assertion below was unreachable because there was nothing to read.
    expect(s, "consent created no account_settings row — the window has nothing to sit on").toBeDefined();
    expect(s!.screeningBaselineAt, "the window is measured from this; NULL means 'from now', which moves the whole backlog")
      .toEqual(t0);
    expect(s!.dormancyDays).toBe(30);
    expect(s!.screeningScope).toBe("window");
  });

  it("`all_time` is carried through — the answer that means 'screen everything above the baseline'", async () => {
    const { db, accountId, mailboxId } = await standUp();
    await requestOrganizerTakeover(db, { intent: "takeover",
      mailboxId, accountId, now: t0, screening: { scope: "all_time" },
    });
    const s = await settingsRow(db, accountId);
    expect(s!.screeningScope).toBe("all_time");
    expect(s!.screeningBaselineAt).toEqual(t0);
  });

  it("THE BASELINE IS WRITTEN ONLY WHILE NULL — a re-run does not slide a live install's cutline", async () => {
    const { db, accountId, mailboxId } = await standUp();
    await requestOrganizerTakeover(db, { intent: "takeover",
      mailboxId, accountId, now: t0, screening: { dormancyDays: 30 },
    });

    // The flow is re-run months later (Settings → Mailboxes offers exactly this), with a
    // different dial. The DIAL is the new answer and moves; the BASELINE is when the account's
    // screening history began and must not.
    await db.update(mailboxes)
      .set({ organizerRole: "reader", organizeConsentedAt: null })
      .where(eq(mailboxes.id, mailboxId));
    await requestOrganizerTakeover(db, { intent: "takeover",
      mailboxId, accountId, now: t1, screening: { dormancyDays: 90, scope: "all_time" },
    });

    const s = await settingsRow(db, accountId);
    expect(s!.screeningBaselineAt, "the baseline moved forward — every message between the two dates now falls outside the window")
      .toEqual(t0);
    expect(s!.dormancyDays, "the dial IS the new answer and must move").toBe(90);
    expect(s!.screeningScope).toBe("all_time");
  });

  it("THE PRODUCT DEFAULT IS NEVER STORED — NULL reads back as the default, so the default can move", async () => {
    const { db, accountId, mailboxId } = await standUp();
    await requestOrganizerTakeover(db, { intent: "takeover",
      mailboxId, accountId, now: t0, screening: { dormancyDays: DEFAULT_DORMANCY_DAYS },
    });
    const s = await settingsRow(db, accountId);
    expect(s!.dormancyDays, "storing the default freezes this install at today's number").toBeNull();
    // The baseline is still written: "I did not move the dial" is an answer, not an absence.
    expect(s!.screeningBaselineAt).toEqual(t0);
  });

  it("A CONSENT WITH NO WINDOW STILL STAMPS THE BASELINE — and invents no dials", async () => {
    const { db, accountId, mailboxId } = await standUp();
    const out = await requestOrganizerTakeover(db, { intent: "takeover", mailboxId, now: t0 });
    expect(out.outcome).toBe("authorized");
    expect((await mailboxRow(db, mailboxId)).organizeConsentedAt).toEqual(t0);
    /* THIS ROW USED TO BE ABSENT, and this case used to assert that it was. The reasoning was
       that a button which asks nothing should write nothing — true of the DIALS and false of the
       baseline, because an absent baseline is not "no answer", it is the answer "no cutoff", and
       it holds the sender’s whole history at the gate. Consent is the baseline. */
    const s = await settingsRow(db, accountId);
    expect(s, "a consent with no window wrote no settings row — the cutline has nothing to sit on")
      .toBeDefined();
    expect(s!.screeningBaselineAt, "NULL is 'measured from now', which slides for ever").toEqual(t0);
    // The DIALS are still not invented: nobody was asked, so the default stays unstored (NULL
    // reads back as the default) and the scope stays at the column's own.
    expect(s!.dormancyDays).toBeNull();
    expect(s!.screeningScope).toBe("window");
  });

  it("a SECOND window-less consent does not move the baseline either", async () => {
    const { db, accountId, mailboxId } = await standUp();
    await requestOrganizerTakeover(db, { mailboxId, now: t0, intent: "takeover" });
    // Back to the pre-consent state, the way a stand-down and a claim-back leave it.
    await db.update(mailboxes)
      .set({ organizerRole: "reader", organizeConsentedAt: null })
      .where(eq(mailboxes.id, mailboxId));
    await requestOrganizerTakeover(db, { mailboxId, now: t1, intent: "takeover" });
    expect((await settingsRow(db, accountId))!.screeningBaselineAt).toEqual(t0);
  });

  it("THE CLI DOOR STAMPS IT TOO — the arm that never touched account_settings at all", async () => {
    const { db, accountId, mailboxId } = await standUp();
    const out = await authorizeOrganizerTakeover(db, { mailboxId, now: t0, intent: "takeover" });
    expect(out.outcome).toBe("authorized");
    expect((await mailboxRow(db, mailboxId)).organizeConsentedAt).toEqual(t0);
    const s = await settingsRow(db, accountId);
    expect(s, "`ohmail organize-here` consented and left the account with no baseline").toBeDefined();
    expect(s!.screeningBaselineAt).toEqual(t0);
  });

  it("an accountId that does not own the mailbox is REFUSED, never written for", async () => {
    const { db, accountId, mailboxId } = await standUp();
    await expect(
      requestOrganizerTakeover(db, {
        mailboxId, accountId: SOMEBODY_ELSE, now: t0, intent: "takeover",
        screening: { dormancyDays: 30 },
      }),
    ).rejects.toThrow(/accountId/);
    // Neither account was written for — not the named one, and not the one that owns the row.
    expect(await settingsRow(db, accountId)).toBeUndefined();
    expect(await settingsRow(db, SOMEBODY_ELSE)).toBeUndefined();
    expect((await mailboxRow(db, mailboxId)).organizeConsentedAt).toBeNull();
  });

  it("a dial outside 1–365 is REFUSED and writes nothing at all", async () => {
    const { db, accountId, mailboxId } = await standUp();
    for (const bad of [0, -1, 400, 1.5]) {
      await expect(
        requestOrganizerTakeover(db, { intent: "takeover", mailboxId, accountId, now: t0, screening: { dormancyDays: bad } }),
        `dormancyDays ${bad}`,
      ).rejects.toThrow(/dormancyDays/);
    }
    // NOTHING was written — not the consent either. A refusal that half-applied would leave a
    // consented mailbox with no window, which is the defect this file exists for.
    expect((await mailboxRow(db, mailboxId)).organizeConsentedAt).toBeNull();
    expect(await settingsRow(db, accountId)).toBeUndefined();
  });

  it("an unknown scope is REFUSED — the read side has no branch for a string it has never seen", async () => {
    const { db, accountId, mailboxId } = await standUp();
    await expect(
      requestOrganizerTakeover(db, { intent: "takeover",
        mailboxId, accountId, now: t0,
        screening: { scope: "everything" as unknown as "window" },
      }),
    ).rejects.toThrow(/screeningScope/);
    expect(await settingsRow(db, accountId)).toBeUndefined();
  });

  it("a screening answer with no account is REFUSED rather than guessed at", async () => {
    const { db, mailboxId } = await standUp();
    await expect(
      requestOrganizerTakeover(db, { intent: "takeover", mailboxId, now: t0, screening: { dormancyDays: 30 } }),
    ).rejects.toThrow(/accountId/);
  });
});

/**
 * A RE-RUN OF SETUP ON A MAILBOX THIS INSTALL ALREADY ORGANIZES.
 *
 * ── THE STATE THE TESTS ABOVE NEVER REACH ───────────────────────────────────────────────────
 *
 * The re-run case in the block above resets the row to `reader` with no consent before the second
 * call, so it exercises a SECOND FIRST-CONSENT and not a re-run at all. The real re-run — "Run
 * setup again" from Settings on an install that has been organizing for months — arrives with
 * `organizer_role = 'organizer'` and `organize_consented_at` set, and that pair used to return
 * `already_organizing` before any write. So the person chose a new window, pressed "Agree and
 * start organizing", got a 200, and the install kept the window it already had.
 *
 * Reported on a released build. It is the same defect class this file was written for — a window
 * control that stores nothing — reached through the one door that had been tested.
 *
 * Watched red by restoring the bare `return { outcome: "already_organizing" … }`: both of the
 * first two cases fail on the dial, and the third (the stamp) passes either way, which is why it
 * is here as the negative control rather than as the proof.
 */
describe("a re-run of setup, on a mailbox this install already organizes", () => {
  /** The real re-run state: consented months ago, still the organizer, dials already stored. */
  const organizing = async () => {
    const w = await standUp();
    await requestOrganizerTakeover(w.db, { intent: "takeover",
      mailboxId: w.mailboxId, accountId: w.accountId, now: t0,
      screening: { dormancyDays: 30, scope: "window" },
    });
    await w.db.update(mailboxes)
      .set({ organizerRole: "organizer" })
      .where(eq(mailboxes.id, w.mailboxId));
    return w;
  };

  it("STORES THE NEW WINDOW — the control was decorative on this path and reported success", async () => {
    const { db, accountId, mailboxId } = await organizing();

    const out = await requestOrganizerTakeover(db, { intent: "takeover",
      mailboxId, accountId, now: t1, screening: { dormancyDays: 90, scope: "window" },
    });
    // Still `already_organizing` — this press is not a second becoming and must not claim to be.
    expect(out.outcome).toBe("already_organizing");

    const s = await settingsRow(db, accountId);
    expect(s!.dormancyDays, "the dial the person just chose was thrown away").toBe(90);
  });

  it("carries `all_time` through, which is the answer people come back to change", async () => {
    const { db, accountId, mailboxId } = await organizing();
    await requestOrganizerTakeover(db, { intent: "takeover",
      mailboxId, accountId, now: t1, screening: { scope: "all_time" },
    });
    const s = await settingsRow(db, accountId);
    expect(s!.screeningScope).toBe("all_time");
    // …and the dial goes back to NULL, because "all time" is a mode and not a number of days.
    expect(s!.dormancyDays).toBeNull();
  });

  it("DOES NOT MOVE THE BASELINE — the coalesce is what makes this path safe", async () => {
    const { db, accountId, mailboxId } = await organizing();
    await requestOrganizerTakeover(db, { intent: "takeover",
      mailboxId, accountId, now: t1, screening: { dormancyDays: 90 },
    });
    const s = await settingsRow(db, accountId);
    expect(s!.screeningBaselineAt, "a re-run slid the cutline forward — the backlog would move")
      .toEqual(t0);
  });

  it("DOES NOT RE-STAMP THE MAILBOX — a second press is not a second becoming", async () => {
    // The negative control for the change above. The precondition exists so a re-run cannot leave
    // a spendable takeover stamp on a healthy mailbox, and writing the dials must not weaken it.
    const { db, accountId, mailboxId } = await organizing();
    const before = await mailboxRow(db, mailboxId);
    await requestOrganizerTakeover(db, { intent: "takeover",
      mailboxId, accountId, now: t1, screening: { dormancyDays: 90 },
    });
    const after = await mailboxRow(db, mailboxId);
    expect(after.takeoverAuthorizedAt).toEqual(before.takeoverAuthorizedAt);
    expect(after.organizeConsentedAt, "the record of when the person first agreed").toEqual(t0);
  });

  it("a refused dial writes NOTHING on this path either", async () => {
    const { db, accountId, mailboxId } = await organizing();
    await expect(
      requestOrganizerTakeover(db, { intent: "takeover", mailboxId, accountId, now: t1, screening: { dormancyDays: 0 } }),
    ).rejects.toThrow(/dormancyDays/);
    const s = await settingsRow(db, accountId);
    expect(s!.dormancyDays, "a 400 must leave the stored answer alone").toBe(30);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  AN `already_organizing` MAILBOX WITH NO SETTINGS RECORD GETS ONE — CONSENT WRITES WHAT IS MISSING
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured on the 0.18.0 release candidate: the person pressed Organize here, the takeover was
 * authorized, they ran setup to the end, and the door answered `already_organizing` having
 * written nothing at all. The row said Organized · Up to date; the account carried NO
 * `account_settings` row, so the cutline was measured from the moment of every later READ rather
 * than from the agreement — "no cutoff", which is how a mailbox reads healthy and files nothing
 * the person expects.
 *
 * `already_organizing` is about the MAILBOX ROW. It has never been an argument about
 * `account_settings`, and the branch answered as if it were: "the row already says so" was taken
 * to mean "everything this press would write is already written", without asking whether a
 * settings record exists at all.
 *
 * ── WHY NOT SIMPLY STAMP THE BASELINE ON EVERY PRESS ────────────────────────────────────────
 *
 * That was tried and is wrong: a press that asks no window must not slide a LIVE account's
 * cutline forward, which is the same damage as having no baseline, arriving later. The condition
 * is the narrow one — write only where there is no readable settings record, which is the state
 * that has no cutline to slide. A press over a readable record still writes nothing.
 */
describe("consent on an already-organizing mailbox whose settings record is missing", () => {
  /** Organizing and consented, with the `account_settings` row deleted out from under it. */
  const organizingWithNoSettings = async () => {
    const w = await standUp();
    await requestOrganizerTakeover(w.db, { intent: "takeover",
      mailboxId: w.mailboxId, accountId: w.accountId, now: t0,
      screening: { dormancyDays: 30, scope: "window" },
    });
    await w.db.update(mailboxes)
      .set({ organizerRole: "organizer" })
      .where(eq(mailboxes.id, w.mailboxId));
    await w.db.delete(accountSettings).where(eq(accountSettings.accountId, w.accountId));
    expect(await settingsRow(w.db, w.accountId), "the fixture did not reach the measured state")
      .toBeUndefined();
    return w;
  };

  it("a window-less re-run writes the settings record the consent always implied", async () => {
    /* THE MEASURED PRESS: "Organize from this machine", which asks no window. Before this it
     * returned `already_organizing` having touched nothing, and the account stayed cutline-less
     * for the life of the install. */
    const { db, accountId, mailboxId } = await organizingWithNoSettings();

    const out = await requestOrganizerTakeover(db, { intent: "takeover", mailboxId, accountId, now: t1 });

    expect(out.outcome, "this press is still not a second becoming").toBe("already_organizing");
    const s = await settingsRow(db, accountId);
    expect(s, "a consented mailbox was left with no settings record to measure its window from")
      .toBeDefined();
    expect(s!.screeningBaselineAt, "the record exists and still has no cutline").toEqual(t1);
  });

  it("and the wizard's answers go in with it when the door asked them", async () => {
    /* THIS ARM ALREADY HELD, and it is here to say which half of the branch was broken: a press
     * carrying a window reached `writeConsentScreening`, whose INSERT stamps the baseline, so a
     * re-run of the full wizard healed the record by accident. The measured press is the one
     * below it — "Organize from this machine", which asks nothing and reached no write at all. */
    const { db, accountId, mailboxId } = await organizingWithNoSettings();

    await requestOrganizerTakeover(db, { intent: "takeover", mailboxId, accountId, now: t1,
      screening: { dormancyDays: 90, scope: "window" } });

    const s = await settingsRow(db, accountId);
    expect(s!.screeningBaselineAt).toEqual(t1);
    expect(s!.dormancyDays, "the answer the person had just given was dropped").toBe(90);
  });

  it("a READABLE settings record is left exactly alone — nothing is rewritten", async () => {
    /* THE NEGATIVE CONTROL, and the whole reason the condition is "no readable record" rather
     * than "always". A live account's cutline may not move, and neither may the row's clock. */
    const w = await standUp();
    await requestOrganizerTakeover(w.db, { intent: "takeover",
      mailboxId: w.mailboxId, accountId: w.accountId, now: t0,
      screening: { dormancyDays: 30, scope: "window" },
    });
    await w.db.update(mailboxes)
      .set({ organizerRole: "organizer" })
      .where(eq(mailboxes.id, w.mailboxId));
    const before = await settingsRow(w.db, w.accountId);

    const out = await requestOrganizerTakeover(w.db, { intent: "takeover",
      mailboxId: w.mailboxId, accountId: w.accountId, now: t1 });

    expect(out.outcome).toBe("already_organizing");
    expect(await settingsRow(w.db, w.accountId),
      "a press that asked nothing rewrote a settings record that was already readable")
      .toEqual(before);
  });

  it("the CLI door answers the same way — the path beside the one that was measured", async () => {
    /* `authorizeOrganizerTakeover` is the same ceremony by address, and its `already_organizing`
     * arm returned before `writeConsentScreening` existed on it at all. A fix on one door and not
     * the other is half-applied by construction. */
    const w = await standUp();
    await requestOrganizerTakeover(w.db, { intent: "takeover",
      mailboxId: w.mailboxId, accountId: w.accountId, now: t0,
      screening: { dormancyDays: 30, scope: "window" },
    });
    await w.db.update(mailboxes)
      .set({ organizerRole: "organizer" })
      .where(eq(mailboxes.id, w.mailboxId));
    await w.db.delete(accountSettings).where(eq(accountSettings.accountId, w.accountId));

    const out = await authorizeOrganizerTakeover(w.db, {
      intent: "takeover", address: "me@ohmail.test", now: t1,
    });

    expect(out.outcome).toBe("already_organizing");
    expect((await settingsRow(w.db, w.accountId))?.screeningBaselineAt,
      "the CLI door consented over a mailbox with no settings record and wrote nothing")
      .toEqual(t1);
  });
});
