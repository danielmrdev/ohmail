import { describe, it, expect } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { folderState } from "@trafficflow/db";
import { MessageGoneError } from "@trafficflow/core/adapters/imap";
import type { AdapterPort, NativeLocator } from "@trafficflow/core";
import { HeyMigrationService } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";
import type { MigrationObservation } from "@trafficflow/core";

/**
 * ARM 4, SECOND HALF — **ONE STALE LOCATOR MUST NOT TRUNCATE A MAILBOX-WIDE
 * MIGRATION, AND THE ROWS IT DID NOT REACH MUST NOT LOSE THEIR INTENT.**
 *
 * `rerouteToMatchRules` runs once, on a verb the person opted into, AFTER the migrated rules have
 * committed — and it is the ONLY thing that persists the desires it computes. The row's finding
 * was precise about why that combination is worse than a loop that merely stops early: *"the
 * un-attempted rows carry no durable per-message intent for the worker to drain."*
 *
 * So before the fix, a provider recycling one folder produced this: rules in place, the first few
 * messages moved, and every message after the stale one left with its OLD desire — no exception
 * surfaced to anything that could retry, no queue entry, and no way for the organizer to discover
 * that work was owed. Re-running the whole verb was the only recovery, and nothing told the user
 * to.
 *
 * The seam now defers, so this pass reaches the end of its list. The two assertions that matter
 * are therefore about the rows BEHIND the refusal — that they were attempted at all, and that the
 * deferred one is queued rather than dropped.
 */

const OBS: MigrationObservation[] = [
  { senderOrDomain: "alice@work.example", kind: "sender", destination: "INBOX" },
];

/** Refuses `refuseFolder` with the adapter's own gone error; moves everything else. */
function partlyGoneAdapter(refuseRef: string): AdapterPort & { moves: string[] } {
  const moves: string[] = [];
  let uid = 9000;
  return {
    moves,
    async move(locator: NativeLocator, to: string): Promise<NativeLocator> {
      if (locator.ref === refuseRef) throw new MessageGoneError(locator);
      moves.push(locator.ref);
      return { folder: String(to), ref: `19:${++uid}` };
    },
  } as AdapterPort & { moves: string[] };
}

describe("the HEY reroute past a stale locator", () => {
  it("continues past the refusal, moves the rest, and QUEUES the one it could not move", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    // Three of alice's messages, all out of place. The MIDDLE one's locator is stale — chosen
    // deliberately, so a loop that stops on it leaves a row behind that the pass never reaches.
    const first = await seedMessage(db, accountId, mailboxId,
      { from: "alice@work.example", folder: "ohmail/News", desired: "ohmail/News", ref: "12:1" });
    const stale = await seedMessage(db, accountId, mailboxId,
      { from: "alice@work.example", folder: "ohmail/News", desired: "ohmail/News", ref: "12:2" });
    const behind = await seedMessage(db, accountId, mailboxId,
      { from: "alice@work.example", folder: "ohmail/News", desired: "ohmail/News", ref: "12:3" });

    const adapter = partlyGoneAdapter("12:2");
    const res = await new HeyMigrationService({ adapter })
      .migrateFromObservations(ctx, { mailboxId, observations: OBS }, { reroute: true });

    // TWO moved, ONE deferred — and the counts are separate facts, because telling somebody three
    // messages were re-routed when one has not moved is a claim about their mailbox that is false.
    expect(res.rerouted).toBe(2);
    expect(res.deferred).toBe(1);
    // EVERY OTHER ROW WAS REACHED. This is the assertion the old behaviour fails: a throw out of
    // the loop left whichever row came after the stale one un-attempted.
    //
    // Sorted rather than positional, because `rerouteToMatchRules`'s SELECT carries no ORDER BY —
    // so WHICH row sits behind the refusal is not fixed, and an assertion on a particular order
    // would be pinning an accident of the planner instead of the property under test.
    expect([...adapter.moves].sort()).toEqual(["12:1", "12:3"]);

    const rows = await db.select().from(folderState)
      .where(inArray(folderState.messageId, [first, stale, behind]));
    const byId = new Map(rows.map((r) => [r.messageId, r]));
    // The two that moved are converged.
    expect(byId.get(first)!.observedFolder).toBe("INBOX");
    expect(byId.get(behind)!.observedFolder).toBe("INBOX");
    // THE DEFERRED ONE CARRIES A DURABLE INTENT — the whole point of the arm. `desired` is the
    // migrated destination and `observed` still says where the mail actually is, which is exactly
    // the pending pair the organizer's reconcile queue selects on.
    expect(byId.get(stale)!.desiredFolder).toBe("INBOX");
    expect(byId.get(stale)!.observedFolder).toBe("ohmail/News");
  });

  it("a mailbox whose folder was recycled wholesale still queues EVERY message — nothing is silently dropped", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const ids = [
      await seedMessage(db, accountId, mailboxId, { from: "alice@work.example", folder: "ohmail/News", desired: "ohmail/News", ref: "12:1" }),
      await seedMessage(db, accountId, mailboxId, { from: "alice@work.example", folder: "ohmail/News", desired: "ohmail/News", ref: "12:2" }),
    ];
    // Every locator refused — the shape a recreated folder produces, where the epoch guard
    // declines the whole mailbox at once.
    const adapter: AdapterPort = {
      async move(l: NativeLocator): Promise<NativeLocator> { throw new MessageGoneError(l); },
    } as AdapterPort;

    const res = await new HeyMigrationService({ adapter })
      .migrateFromObservations(ctx, { mailboxId, observations: OBS }, { reroute: true });

    expect(res.rerouted).toBe(0);
    expect(res.deferred).toBe(2);
    const rows = await db.select().from(folderState).where(inArray(folderState.messageId, ids));
    for (const r of rows) {
      expect(r.desiredFolder).toBe("INBOX");
      expect(r.observedFolder).toBe("ohmail/News");
    }
  });

  /**
   * REVIEW FINDING — MOVING THE WRITE EARLIER OPENED A SNAPSHOT-AGE RACE IN ITS PLACE.
   *
   * The pass reads the whole account in ONE bulk snapshot and then spends an IMAP round trip per
   * out-of-place message. Over a large mailbox that is a long time, and an unconditional pre-write
   * overwrote a decision committed on another device for a message the loop had not reached yet.
   * Fixing the post-I/O race by writing earlier and calling it done would have been the same defect
   * a few milliseconds sooner.
   *
   * The guard is `DO UPDATE … WHERE desired_folder = <what the snapshot saw>`, which is the
   * construction the Screener already uses: re-route only rows still where this pass believed they
   * were, and let a row that moved on keep where it went.
   */
  it("declines a row whose destination changed after the snapshot — the newer decision wins", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    // TWO messages, because the interleave has to land INSIDE the loop and the loop's only
    // suspension point is its network call. So the first row's `move` is where somebody else's
    // decision commits, and the second row is the one whose snapshot has gone stale — which is
    // exactly the sequence review described: a long pass over one bulk read of the account.
    const a = await seedMessage(db, accountId, mailboxId,
      { from: "alice@work.example", folder: "ohmail/News", desired: "ohmail/News", ref: "12:1" });
    const b = await seedMessage(db, accountId, mailboxId,
      { from: "alice@work.example", folder: "ohmail/News", desired: "ohmail/News", ref: "12:2" });

    const byRef = new Map([["12:1", a], ["12:2", b]]);
    let interleaved = 0;
    const adapter: AdapterPort = {
      async move(locator: NativeLocator, to: string): Promise<NativeLocator> {
        if (interleaved === 0) {
          interleaved++;
          // Whichever row the loop has NOT reached yet — the SELECT has no ORDER BY, so the other
          // one is named by elimination rather than by position.
          const other = [...byRef.entries()].find(([ref]) => ref !== locator.ref)![1];
          await db.update(folderState).set({ desiredFolder: "ohmail/Paper Trail" })
            .where(eq(folderState.messageId, other));
        }
        return { folder: String(to), ref: locator.ref };
      },
    } as AdapterPort;

    const res = await new HeyMigrationService({ adapter })
      .migrateFromObservations(ctx, { mailboxId, observations: OBS }, { reroute: true });

    expect(interleaved).toBe(1);
    // One moved, one declined. The pass reports what it actually did rather than what it intended.
    expect(res.rerouted).toBe(1);
    expect(res.superseded).toBe(1);
    // AND THE NEWER DECISION STANDS. Before the guard this read `INBOX` — the migration's own
    // destination, written over a choice made after it had read the account.
    const rows = await db.select().from(folderState)
      .where(inArray(folderState.messageId, [a, b]));
    const desires = rows.map((r) => r.desiredFolder).sort();
    expect(desires).toEqual(["INBOX", "ohmail/Paper Trail"]);
  });

  it("a refusal that is NOT a gone locator still ends the pass — the narrowing is one condition wide", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    await seedMessage(db, accountId, mailboxId,
      { from: "alice@work.example", folder: "ohmail/News", desired: "ohmail/News", ref: "12:1" });
    const boom = new Error("[NO] mailbox is read-only");
    const adapter: AdapterPort = { async move(): Promise<NativeLocator> { throw boom; } } as AdapterPort;

    await expect(new HeyMigrationService({ adapter })
      .migrateFromObservations(ctx, { mailboxId, observations: OBS }, { reroute: true }))
      .rejects.toBe(boom);
    // The rules still committed — they are a separate transaction that ran first, and that
    // ordering is unchanged by any of this.
    const [row] = await db.select().from(folderState).limit(1);
    expect(row).toBeDefined();
  });
});
