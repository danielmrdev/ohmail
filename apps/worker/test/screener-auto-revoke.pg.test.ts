import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, folderState, mailboxes, messageBodies, messages, type Tx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { screenerAutoApplyPass } from "../src/screener-auto.js";

/**
 * ═══ AN OPT-OUT THAT COMPLETED MID-WALK STOPS THE WALK ═══════════════════════════════════════
 *
 * the headline damage, in the words the ledger uses for it: "a completed
 * opt-OUT followed by up to 100 automatic moves". The opt-in was read ONCE, in a single PK probe
 * before the first page. The pass then walks up to `SCREENER_AUTO_MAX_PAGES` transactions filing up
 * to `SCREENER_AUTO_WRITES_PER_CYCLE` messages, and an account that switched auto-apply off during
 * that walk had the whole remainder applied anyway — carried to their real mailbox by the
 * reconciler, with no line anywhere saying a withdrawn decision had been acted on.
 *
 * The fix is not "read it again somewhere": a bare re-read has the same window one statement later.
 * It is the SAME shape `ohbox-tidy.ts` already uses — the settings row is taken `FOR UPDATE` as the
 * first statement of every page transaction, so it is simultaneously the serialization point
 * between two drivers and the revoke check. This file is the proof for the sibling pass.
 *
 * ── WHY THE INTERLEAVE IS REAL RATHER THAN SIMULATED ────────────────────────────────────────
 *
 * The opt-out is issued from a SECOND CONNECTION while the pass is inside a page transaction that
 * holds `account_settings` locked. It therefore BLOCKS — which is the production sequence exactly,
 * not an artefact — commits the instant that page commits, and is seen by the next page's locked
 * read. Nothing here polls for a convenient moment: the lock decides the ordering, which is the
 * property under test.
 *
 * REAL POSTGRES (:5433) is required twice over. `FOR UPDATE` is a no-op on PGlite (single
 * connection), so the lock could not block and the interleave could not exist; and a second session
 * committing mid-transaction is not expressible there at all. On PGlite every assertion below would
 * pass against the UNFIXED pass — which is precisely the blindness CLAUDE.md records for
 * transactional code, and why `screener-auto.test.ts` says in its own header that this claim is
 * "the sibling passes' `*.pg.test.ts` territory". This is that territory.
 *
 * ── MUTATIONS WATCHED (each restored) ────────────────────────────────────────────────────────
 *
 *  1.  delete the locked re-read and its `revoked` early return
 *      ⇒ RED: every remaining page is applied after the opt-out committed — the defect verbatim.
 *  2.  keep the re-read but drop `.for("update")`
 *      ⇒ **STILL GREEN, and the note is kept because the prediction was wrong.** Under READ
 *        COMMITTED each page's read is a fresh statement, so it sees the committed opt-out with or
 *        without the lock: the RE-READ is what detects a revoke, and the lock is not. What the lock
 *        buys is the other property — serializing two drivers (a cycle tail and a second worker
 *        mid-failover) so the loser wakes with the winner's committed state instead of re-deciding
 *        the same page — plus the lock ORDER `ohbox-tidy.ts` documents (settings before
 *        `folder_state` before the `recordChange` counter). Neither of those is what this file
 *        asserts, so this file must not claim them. Written down rather than quietly dropped:
 *        a mutation that fails to redden is evidence about the test, and pretending otherwise is
 *        how a suite comes to be trusted for something it never checked.
 *  3.  report the revoke as `capped` instead of `revoked`
 *      ⇒ RED on the two flags — and **the production consequence this note used to assert was
 *        false**, corrected 2026-09-01 by a review round. It said "the caller re-kicks a walk that
 *        owes no work". It does not: `index.ts` destructures `{ ran, moved, capped }`, never reads
 *        `revoked`, and does nothing with `capped` but log it — both outcomes take the same
 *        scheduling path, and the next ordinary cycle's probe sees the opt-in OFF and stops anyway.
 *
 *        So what the third proves is that the two states are DISTINGUISHABLE at the pass boundary, which is
 *        worth holding — "the user withdrew this" and "there is more to do" have opposite meanings to
 *        any future caller, and a revoke reported as a cap is the kind of wrong that only becomes
 *        visible once somebody acts on it. It is a claim about the interface, not about today's
 *        behaviour, and it is now written as one. **No consumer of `revoked` exists yet; the first
 *        one to arrive is the reason this distinction is here.**
 */

const AVAILABLE = await realPgAvailable();
const SCREENER = "ohmail/Screener";
/** The strong-bulk floor: List-Unsubscribe AND a corroborating list marker. */
const STRONG_BULK = { "list-unsubscribe": ["<https://x.test/u>"], "list-id": ["<news.shop.test>"] };

describe.skipIf(!AVAILABLE)("screener auto-apply — a withdrawn opt-in stops the walk", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;
  let otherSql: ReturnType<typeof postgres>;
  let otherDb: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
    otherSql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    otherDb = brandDialect(drizzle(otherSql, { schema }), "pg");
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await otherSql?.end({ timeout: 5 });
  });

  async function seed(n: number, setBy: "us" | "external" | "peer" = "us"): Promise<{ accountId: string; ids: string[] }> {
    const accountId = randomUUID();
    const tag = accountId.slice(0, 8);
    await db.insert(accounts).values({ id: accountId, name: `rev-${tag}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `rev-${tag}@example.test`, status: "connected",
    }).returning();
    await db.insert(accountSettings).values({
      accountId, screenerAutoApplyAt: new Date(),
    }).onConflictDoUpdate({
      target: accountSettings.accountId, set: { screenerAutoApplyAt: new Date() },
    });
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id, bodyHash: `rev-h-${tag}-${i}`,
        dedupKey: `rev:${tag}:${i}`, subject: `newsletter ${i}`,
        fromAddress: `news${i}@shop.test`,
        nativeLocator: { folder: SCREENER, ref: `1:${100 + i}` },
      }).returning();
      await db.insert(messageBodies).values({
        messageId: m!.id, text: "", html: null, headers: STRONG_BULK,
      });
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER,
        lastSetBy: setBy, reconcileStatus: "reconciled", conflict: false,
      });
      ids.push(m!.id);
    }
    return { accountId, ids };
  }

  const desiredOf = async (id: string): Promise<string> => {
    const [r] = await db.select().from(folderState).where(eq(folderState.messageId, id)).limit(1);
    return r!.desiredFolder;
  };

  it("a `peer` row is NOT auto-applied — this pass runs unbidden", async () => {
    /* `'peer'` is a placement another install of this account made and a READER recorded
       (`pipeline.ts#readerAdoption`). This pass auto-files on a graduated pattern with nobody
       pressing anything, so admitting `peer` would mean a promotion silently re-filing mail this
       install never decided about — which is what the import hold refuses. Only `rule-retro`
       admits `peer`, and only behind a press.

       THE POSITIVE CONTROL IS THE POINT: an identical `us` row in the SAME account and the SAME
       pass must move. Without it, "the peer row stayed" is what a pass that does nothing at all
       also looks like — and this pass does nothing by default, since it is gated on an opt-in. */
    const ours = await seed(1, "us");
    const theirs = await seed(1, "peer");

    const mine = await screenerAutoApplyPass(db as unknown as Tx, { accountId: ours.accountId });
    const other = await screenerAutoApplyPass(db as unknown as Tx, { accountId: theirs.accountId });

    expect(mine.ran, "the opt-in was not live — the comparison below would be vacuous").toBe(true);
    expect(mine.moved, "the pass filed nothing at all, so the peer assertion proves nothing").toBe(1);
    expect(await desiredOf(ours.ids[0]!)).not.toBe(SCREENER);

    expect(other.ran).toBe(true);
    expect(other.moved, "a reader's adoption was auto-filed by a pass nobody pressed").toBe(0);
    expect(await desiredOf(theirs.ids[0]!), "the peer row left the gate").toBe(SCREENER);
  });

  it("the pages after the opt-out committed are NOT applied, and the stop is reported as a revoke", async () => {
    const { accountId, ids } = await seed(8);

    // One row per page, so the walk is eight transactions and there are seven boundaries for the
    // opt-out to land on. `deps.now` is read once to plan the walk and then once per moved row, so
    // its SECOND reading is how this test learns the first page is under way WITHOUT reaching into
    // the pass. Keyed on the first, the opt-out raced the plan and the full walk's step 0.
    let movedRows = 0;
    const optOutFired = { at: -1 };

    const optOut = (async () => {
      // Wait until the pass has actually filed something, so the opt-out cannot win the race to the
      // lock before any work happens — that would prove only the up-front probe, which already
      // worked.
      while (movedRows < 2) await new Promise((r) => setTimeout(r, 2));
      optOutFired.at = movedRows;
      // BLOCKS on `account_settings` while the current page holds it, commits when that page does.
      await otherDb.update(accountSettings)
        .set({ screenerAutoApplyAt: null })
        .where(eq(accountSettings.accountId, accountId));
    })();

    const res = await screenerAutoApplyPass(db as unknown as Tx, {
      accountId,
      batch: 1,
      now: () => { movedRows++; return new Date(); },
    });
    await optOut;

    // It began as a live opt-in and did some work — otherwise this proves nothing about a WALK.
    expect(res.ran).toBe(true);
    expect(optOutFired.at).toBeGreaterThanOrEqual(2);
    expect(res.moved).toBeGreaterThanOrEqual(1);

    // THE POINT: it stopped, and it stopped short of the whole queue.
    expect(res.revoked, "a withdrawn opt-in must stop the walk").toBe(true);
    expect(res.moved, "the pass filed the entire queue after the user opted out").toBeLessThan(ids.length);

    // A revoke is not a cap: the caller must not re-kick a walk that owes nothing.
    expect(res.capped).toBe(false);

    // Every message it did not reach is still held at the gate.
    const desired = await Promise.all(ids.map(desiredOf));
    const stillHeld = desired.filter((d) => d === SCREENER).length;
    expect(stillHeld).toBe(ids.length - res.moved);

    // The opt-out really is committed and durable — not merely observed in flight.
    const [live] = await db.select({ at: accountSettings.screenerAutoApplyAt })
      .from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);
    expect(live!.at).toBeNull();
  }, 60_000);

  it("the pages committed BEFORE the opt-out stand — a revoke is not a reversal", async () => {
    const { accountId, ids } = await seed(6);

    let movedRows = 0;
    const optOut = (async () => {
      while (movedRows < 2) await new Promise((r) => setTimeout(r, 2));
      await otherDb.update(accountSettings)
        .set({ screenerAutoApplyAt: null })
        .where(eq(accountSettings.accountId, accountId));
    })();

    const res = await screenerAutoApplyPass(db as unknown as Tx, {
      accountId, batch: 1, now: () => { movedRows++; return new Date(); },
    });
    await optOut;

    // What was applied while the opt-in was live REMAINS applied. Those moves were legitimate when
    // made, each carries its own recorded inverse, and silently undoing them would be a second
    // automatic decision taken on the account's behalf — the opposite of what switching the feature
    // off asks for. Turning it off means "stop", not "put it all back".
    const moved = (await Promise.all(ids.map(desiredOf))).filter((d) => d !== SCREENER).length;
    expect(moved).toBe(res.moved);
    expect(res.moved).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
