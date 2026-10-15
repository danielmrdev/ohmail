import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runMigrations } from "@trafficflow/db/admin";
import { accounts, mailboxes, messages, awayReplies } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "../../src/adapters/drizzle-repo.js";
import { mintMessageId } from "../../src/send.js";
import { parseMessageIds } from "../../src/threading.js";

/**
 * ═══ `isOwnAwayReply` AGAINST REAL POSTGRES ═══════════════════════════════════════════════
 *
 * ── WHY NOT PGlite ─────────────────────────────────────────────────────────────────────────
 *
 * The statement binds a JS ARRAY into an `IN (…)`, which is the shape this repository has been
 * bitten by twice: drizzle FLATTENS a bare array interpolated into a raw `sql` template, and
 * PGlite accepted the flattened form both times while real Postgres answered `malformed array
 * literal`. `inArray` is the correct spelling — it renders one placeholder per
 * element — and this file is the proof that it is, rather than a claim that it looks right.
 *
 * ── THE CASE ARM IS THE ONE THAT FAILED SILENTLY ───────────────────────────────────────────
 *
 * This file used to assert the case arm by handing in a candidate the TEST had lower-cased,
 * under a comment saying that is what `parseMessageIds` produces. It is not: that function keeps
 * an id's case deliberately (RFC 5322 `id-left` is case-sensitive), so the fixture agreed with
 * the reader about a normalisation neither of them performed, and the arm passed while the live
 * path missed every away reply from a mailbox whose address carries a capital in its domain —
 * the bounce read as a stranger's mail and no correspondent was ever stamped undeliverable. The
 * case arm below now takes its candidate FROM `parseMessageIds`, over the quoted header a report
 * actually carries, so the premise is measured rather than restated. `mintMessageId` folds the
 * domain through `foldMessageIdDomain` and the reader folds its candidates through the same
 * helper, which is what makes both spellings one.
 */

const AVAILABLE = await realPgAvailable();

describe.skipIf(!AVAILABLE)("isOwnAwayReply against real Postgres", () => {
  let owned: OwnedDb;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
  }, 180_000);

  afterAll(async () => { await owned?.close().catch(() => {}); });

  /** A fresh account per case, so the shared cluster cannot make one of these answer another's. */
  async function world(address: string): Promise<{ accountId: string; mailboxId: string }> {
    const accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `dsn-${accountId.slice(0, 8)}` });
    const [mb] = await owned.db.insert(mailboxes)
      .values({ accountId, provider: "imap", address }).returning();
    return { accountId, mailboxId: mb!.id };
  }

  /* A REAL message row for the ledger to name. Mail 0118 keys `away_replies` to
     `(message_id, account_id)`, so a minted uuid for a message that never existed is not a state
     the database has — and a double that cannot exist in production measures nothing. One message
     per ledger row, which is also what `away_replies_message_uq` expects. */
  async function message(w: { accountId: string; mailboxId: string }): Promise<string> {
    const [row] = await owned.db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId,
      bodyHash: randomUUID(), dedupKey: `mid:${randomUUID()}`,
    }).returning();
    return row!.id;
  }

  async function ledger(
    w: { accountId: string; mailboxId: string },
    minted: string | null,
    outcome = "sent",
  ): Promise<void> {
    await owned.db.insert(awayReplies).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageId: await message(w),
      sender: "correspondent@elsewhere.example", outcome, mintedMessageId: minted,
    });
  }

  const repoFor = () => makeDrizzleRepo(owned.db as never);

  it("answers true for the id it minted, handed in bracket-free and lower-cased", async () => {
    const w = await world(`${randomUUID()}@dsn.test`);
    const uuid = randomUUID();
    await ledger(w, `<${uuid}@dsn.test>`);

    expect(await repoFor().isOwnAwayReply(w.accountId, [`${uuid}@dsn.test`])).toBe(true);
  });

  it("answers true when the MAILBOX's domain was stored with capitals", async () => {
    const w = await world(`${randomUUID()}@DSN.Test`);
    /* WHAT THE MINT WRITES TODAY — `mintMessageId` folds the domain, so the ledger row carries a
       lower-case domain even though the mailbox's address does not. */
    const minted = mintMessageId("DSN.Test");
    expect(minted.endsWith("@dsn.test>"), "the mint no longer folds the domain").toBe(true);
    await ledger(w, minted);

    /* AND WHAT THE READER IS ACTUALLY HANDED — out of `parseMessageIds`, over a quoted header,
       never a literal this test lower-cased itself. That substitution is the whole point of the
       arm: with the fixture's own fold it was green against a reader that missed. */
    const candidates = parseMessageIds([`In-Reply-To: ${minted}`]);
    expect(candidates).toHaveLength(1);
    expect(await repoFor().isOwnAwayReply(w.accountId, candidates)).toBe(true);
  });

  it("answers true for a LEGACY row minted before the fold, quoted back in its own case", async () => {
    const w = await world(`${randomUUID()}@DSN.Test`);
    const uuid = randomUUID();
    // Exactly what the unfolded mint used to write, and exactly how a report quotes it back.
    await ledger(w, `<${uuid}@DSN.Test>`);

    const candidates = parseMessageIds([`In-Reply-To: <${uuid}@DSN.Test>`]);
    expect(candidates).toEqual([`${uuid}@DSN.Test`]);
    expect(await repoFor().isOwnAwayReply(w.accountId, candidates)).toBe(true);
  });

  it("binds a MULTI-ELEMENT candidate list as an array, not as a flattened scalar", async () => {
    const w = await world(`${randomUUID()}@dsn.test`);
    const uuid = randomUUID();
    await ledger(w, `<${uuid}@dsn.test>`);

    expect(await repoFor().isOwnAwayReply(w.accountId, [
      "not-ours-1@elsewhere.example", `${uuid}@dsn.test`, "not-ours-2@elsewhere.example",
    ])).toBe(true);
  });

  it("answers false for an EMPTY candidate list", async () => {
    const w = await world(`${randomUUID()}@dsn.test`);
    await ledger(w, `<${randomUUID()}@dsn.test>`);

    /* MEASURED, because removing the method's own `candidates.length === 0` guard left this case
       GREEN and a green mutation is a question. drizzle renders an empty `inArray` as the literal
       `false` — not as `IN ()`, which would be a syntax error — and a one- and two-element list as
       `in ($1)` / `in ($1, $2)`, each element its own placeholder rather than one flattened
       scalar. So the guard saves a round trip on a report that quoted no ids and defends against
       nothing; it stays because `findThreadParent` beside it carries the identical line, and this
       case stays because "an empty list is not a match" is the answer callers rely on. */
    expect(await repoFor().isOwnAwayReply(w.accountId, [])).toBe(false);
  });

  it("is ACCOUNT-SCOPED — another account's minted id is not ours", async () => {
    const mine = await world(`${randomUUID()}@dsn.test`);
    const theirs = await world(`${randomUUID()}@dsn.test`);
    const uuid = randomUUID();
    await ledger(theirs, `<${uuid}@dsn.test>`);

    expect(await repoFor().isOwnAwayReply(mine.accountId, [`${uuid}@dsn.test`])).toBe(false);
  });

  it("answers false when the ledger row minted nothing (a reply that never dialled)", async () => {
    const w = await world(`${randomUUID()}@dsn.test`);
    await ledger(w, null, "throttled");

    expect(await repoFor().isOwnAwayReply(w.accountId, [`${randomUUID()}@dsn.test`])).toBe(false);
  });
});
