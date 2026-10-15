import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import { mailboxes } from "../src/schema.js";
import {
  capabilitiesColumn, hasCapability, readRequestEligibility,
  CAPABILITY_REQUESTS, CAPABILITY_MOVES, CAPABILITY_RULES, CAPABILITY_PROFILE,
} from "../src/organizer-role.js";

const ACCT = "00000000-0000-0000-0000-0000000000cb";

/*
 * THE TWO-LITERAL EQUALITY TEST THAT USED TO OPEN THIS FILE IS GONE, because the second literal
 * is gone (mail 0090). `packages/core` now RE-EXPORTS `CAPABILITY_REQUESTS` from this package
 * rather than spelling it again: the dependency edge runs core → db, which is the direction that
 * makes one definition possible, and the old comment here had the direction right but drew the
 * opposite conclusion from it. A test that compares a constant to itself is not a guard.
 */

describe("capabilitiesColumn", () => {
  it("joins, trims and lowercases", () => {
    expect(capabilitiesColumn(["Requests", " foo "])).toBe("requests,foo");
  });
  it("drops empty members", () => {
    expect(capabilitiesColumn(["a", "", "  ", "b"])).toBe("a,b");
  });
  it("nulls out an empty or absent set — never the empty string", () => {
    expect(capabilitiesColumn([])).toBeNull();
    expect(capabilitiesColumn(null)).toBeNull();
    expect(capabilitiesColumn(undefined)).toBeNull();
    expect(capabilitiesColumn(["", "  "])).toBeNull();
  });
});

describe("hasCapability", () => {
  it("finds a member, case- and whitespace-insensitively", () => {
    expect(hasCapability("requests,foo", "REQUESTS")).toBe(true);
    expect(hasCapability("requests, foo", " requests ")).toBe(true);
  });
  it("is false for an absent column — the fail-safe direction", () => {
    expect(hasCapability(null, "requests")).toBe(false);
    expect(hasCapability(undefined, "requests")).toBe(false);
    expect(hasCapability("", "requests")).toBe(false);
  });
  it("is false for a column that does not name it", () => {
    expect(hasCapability("foo,bar", "requests")).toBe(false);
  });
});

async function seedMailbox(
  db: Awaited<ReturnType<typeof makeTestDb>>,
  over: Partial<{
    organizerRole: string; organizerState: string | null; organizedByCapabilities: string | null;
    organizedByKind: string | null; organizedByName: string | null; status: string;
  }> = {},
): Promise<string> {
  const [mb] = await db.insert(mailboxes).values({
    accountId: ACCT, provider: "imap", address: `${crypto.randomUUID()}@x.example`,
    organizerRole: over.organizerRole ?? "reader",
    organizerState: over.organizerState ?? null,
    organizedByCapabilities: over.organizedByCapabilities ?? null,
    organizedByKind: over.organizedByKind ?? null,
    organizedByName: over.organizedByName ?? null,
    status: over.status ?? "connected",
  }).returning({ id: mailboxes.id });
  return mb!.id;
}

describe("readRequestEligibility", () => {
  it("absent row is null", async () => {
    const db = await makeTestDb();
    const result = await db.transaction((tx) => readRequestEligibility(tx, ACCT, crypto.randomUUID(), CAPABILITY_REQUESTS));
    expect(result).toBeNull();
  });

  it("this install's own organizer row is always capable — no request needed, direct write", async () => {
    const db = await makeTestDb();
    const id = await seedMailbox(db, { organizerRole: "organizer" });
    const result = await db.transaction((tx) => readRequestEligibility(tx, ACCT, id, CAPABILITY_REQUESTS));
    expect(result?.role).toBe("organizer");
    expect(result?.capable).toBe(true);
  });

  it("a reader whose holder advertises requests AND is held — capable", async () => {
    const db = await makeTestDb();
    const id = await seedMailbox(db, {
      organizerRole: "reader", organizerState: "held", organizedByCapabilities: "requests",
      organizedByKind: "cloud", organizedByName: "Cloud",
    });
    const result = await db.transaction((tx) => readRequestEligibility(tx, ACCT, id, CAPABILITY_REQUESTS));
    expect(result).toEqual({
      role: "reader", state: "held", capable: true, status: "connected", takeoverPending: false,
      by: { kind: "cloud", name: "Cloud", since: null },
    });
  });

  /* A TAKEOVER THIS INSTALL WAS ASKED FOR AND THE CLAIM HAS NOT LANDED: the stamp
     stands on a reader row. A join over a live holder wins nothing, so it is not pending. */
  it.each([
    ["takeover", "held", true], ["takeover", "stopped", true],
    ["join", "held", false], ["join", "stopped", true], ["join", null, true],
  ] as const)("a reader with a standing %s stamp over a %s holder: takeoverPending %s", async (intent, state, pending) => {
    const db = await makeTestDb();
    const id = await seedMailbox(db, { organizerRole: "reader", organizerState: state });
    await db.update(mailboxes).set({ takeoverAuthorizedAt: new Date(), takeoverIntent: intent })
      .where(eq(mailboxes.id, id));
    const result = await db.transaction((tx) => readRequestEligibility(tx, ACCT, id, CAPABILITY_REQUESTS));
    expect(result?.takeoverPending).toBe(pending);
  });

  it("CONTROL: no stamp, or an organizer row, is never pending", async () => {
    const db = await makeTestDb();
    const reader = await seedMailbox(db, { organizerRole: "reader", organizerState: "stopped" });
    const organizer = await seedMailbox(db, { organizerRole: "organizer" });
    await db.update(mailboxes).set({ takeoverAuthorizedAt: new Date(), takeoverIntent: "takeover" })
      .where(eq(mailboxes.id, organizer));
    for (const id of [reader, organizer]) {
      const result = await db.transaction((tx) => readRequestEligibility(tx, ACCT, id, CAPABILITY_REQUESTS));
      expect(result?.takeoverPending).toBe(false);
    }
  });

  it("a reader whose holder is held but does NOT advertise requests — a stale build — not capable", async () => {
    const db = await makeTestDb();
    const id = await seedMailbox(db, {
      organizerRole: "reader", organizerState: "held", organizedByCapabilities: null,
    });
    const result = await db.transaction((tx) => readRequestEligibility(tx, ACCT, id, CAPABILITY_REQUESTS));
    expect(result?.capable).toBe(false);
  });

  it("a reader whose holder STOPPED — not capable, however the capability column reads", async () => {
    const db = await makeTestDb();
    const id = await seedMailbox(db, {
      organizerRole: "reader", organizerState: "stopped", organizedByCapabilities: "requests",
    });
    const result = await db.transaction((tx) => readRequestEligibility(tx, ACCT, id, CAPABILITY_REQUESTS));
    expect(result?.capable).toBe(false);
  });

  it("a reader with no holder at all (pre-consent, or nobody has ever organized) — not capable", async () => {
    const db = await makeTestDb();
    const id = await seedMailbox(db);
    const result = await db.transaction((tx) => readRequestEligibility(tx, ACCT, id, CAPABILITY_REQUESTS));
    expect(result?.role).toBe("reader");
    expect(result?.state).toBeNull();
    expect(result?.capable).toBe(false);
  });

  it("a DISABLED (tombstoned) mailbox is never capable, even when its stale role column still reads 'organizer'", async () => {
    // mail 0083's own rule: a removal retires the mailbox rather than demoting it, so a
    // tombstone's `organizer_role` column keeps whatever it was at removal. `role` on the
    // returned object still reports it (callers that need the raw column value get it), but
    // `capable` must not — `ScreenerService.decide` uses `capable` alongside `role` for exactly
    // this reason. See `readRequestEligibility`'s own header.
    const db = await makeTestDb();
    const id = await seedMailbox(db, { organizerRole: "organizer", status: "disabled" });
    const result = await db.transaction((tx) => readRequestEligibility(tx, ACCT, id, CAPABILITY_REQUESTS));
    expect(result?.role).toBe("organizer");
    expect(result?.capable).toBe(false);
  });

  it("account-scoped — a mailbox belonging to a different account is invisible", async () => {
    const db = await makeTestDb();
    const id = await seedMailbox(db, { organizerRole: "organizer" });
    const result = await db.transaction((tx) => readRequestEligibility(
      tx, "00000000-0000-0000-0000-0000000000ff", id, CAPABILITY_REQUESTS,
    ));
    expect(result).toBeNull();
  });

  /* ══ THE CAPABILITY IS PER-KIND (mail 0094) ═══════════════════════════════════════════════
   *
   * Every case above asks about `requests`, which is what this function asked about implicitly
   * when it was the only kind. These are the ones that could not be written before: the SAME row
   * answers differently depending on which family of request the caller means, and that is the
   * whole point of the argument. A version number could not express it — builds gain these
   * abilities in an order nobody planned.
   */
  it("a 0.14.1 organizer advertises `requests` alone: capable for a Screener decision, not for a move, a rule or a profile edit", async () => {
    const db = await makeTestDb();
    const id = await seedMailbox(db, {
      organizerRole: "reader", organizerState: "held", organizedByCapabilities: "requests",
      organizedByKind: "cloud", organizedByName: "Cloud",
    });
    const ask = (cap: string) => db.transaction((tx) => readRequestEligibility(tx, ACCT, id, cap));

    /* THE POSITIVE CONTROL FIRST, and it is not a formality: every other assertion here is a
       refusal, and a gate that refuses everything is indistinguishable from one that works until
       somebody tries the case the product is for. If this line goes red the feature is off. */
    expect((await ask(CAPABILITY_REQUESTS))?.capable,
      "a Screener decision was refused against a holder that does advertise `requests`").toBe(true);

    expect((await ask(CAPABILITY_MOVES))?.capable, "a move was offered to a holder with no move applier").toBe(false);
    expect((await ask(CAPABILITY_RULES))?.capable, "a rule was offered to a holder with no rule applier").toBe(false);
    expect((await ask(CAPABILITY_PROFILE))?.capable, "a profile edit was offered to a holder with no profile applier").toBe(false);
  });

  it("a holder advertising the full set is capable for every kind", async () => {
    const db = await makeTestDb();
    const id = await seedMailbox(db, {
      organizerRole: "reader", organizerState: "held",
      organizedByCapabilities: "requests,moves,rules,profile",
      organizedByKind: "local", organizedByName: "Mila's MacBook",
    });
    for (const cap of [CAPABILITY_REQUESTS, CAPABILITY_MOVES, CAPABILITY_RULES, CAPABILITY_PROFILE]) {
      const r = await db.transaction((tx) => readRequestEligibility(tx, ACCT, id, cap));
      expect(r?.capable, `refused ${cap} against a holder that advertises it`).toBe(true);
    }
  });

  it("a partial set answers per member — the state a staged rollout is actually in", async () => {
    // Not hypothetical: the capabilities land with their appliers, so an organizer part-way
    // through a release genuinely advertises some and not others. A reader must be able to move
    // mail through it while being refused a profile edit, rather than being all-or-nothing.
    const db = await makeTestDb();
    const id = await seedMailbox(db, {
      organizerRole: "reader", organizerState: "held", organizedByCapabilities: "requests,moves",
    });
    const ask = (cap: string) => db.transaction((tx) => readRequestEligibility(tx, ACCT, id, cap));
    expect((await ask(CAPABILITY_MOVES))?.capable).toBe(true);
    expect((await ask(CAPABILITY_RULES))?.capable).toBe(false);
    expect((await ask(CAPABILITY_PROFILE))?.capable).toBe(false);
  });

  it("this install's OWN organizer row is capable for every kind, and never consults the column", async () => {
    /* The capability column describes a PEER. An install writing to a mailbox it organizes itself
       makes no request and needs no applier on anybody else's side, so the short-circuit on
       `role === "organizer"` is correct for every kind — asserted here rather than assumed,
       because the alternative reading (gate the organizer's own press on a header an attacker can
       write into the folder) is the one this repository has already had to remove once. The row
       carries a capability set naming NONE of the four, so a read that consulted it would refuse. */
    const db = await makeTestDb();
    const id = await seedMailbox(db, {
      organizerRole: "organizer", organizedByCapabilities: "something-else",
    });
    for (const cap of [CAPABILITY_REQUESTS, CAPABILITY_MOVES, CAPABILITY_RULES, CAPABILITY_PROFILE]) {
      const r = await db.transaction((tx) => readRequestEligibility(tx, ACCT, id, cap));
      expect(r?.capable, `this install's own organizer row was refused for ${cap}`).toBe(true);
    }
  });

  it("a STOPPED holder is refused for every kind, however the column reads", async () => {
    const db = await makeTestDb();
    const id = await seedMailbox(db, {
      organizerRole: "reader", organizerState: "stopped",
      organizedByCapabilities: "requests,moves,rules,profile",
    });
    for (const cap of [CAPABILITY_REQUESTS, CAPABILITY_MOVES, CAPABILITY_RULES, CAPABILITY_PROFILE]) {
      const r = await db.transaction((tx) => readRequestEligibility(tx, ACCT, id, cap));
      expect(r?.capable, `${cap} was offered to a holder that has stopped`).toBe(false);
    }
  });

  // `isOrganizerState`'s coercion inside `readRequestEligibility` is UNREACHABLE from this tree —
  // `mailboxes_organizer_state_closed` refuses an out-of-set value at the row itself, the same
  // shape `standDownMemory`'s own suite notes for its sibling coercion. Kept as the guard for the
  // day the TS union and the CHECK's set stop being equal, not exercised here for the same reason
  // that guard is not: there is no way to reach it honestly through this table.
});
