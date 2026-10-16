import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accounts, mailboxes, type Tx } from "../src/index.js";
import { schema } from "../src/cloud.js";
import { runMigrations } from "../src/admin.js";
import { pgTestUrl } from "../src/testing.js";

/**
 * ═══ THE STRANDED `disabled` READERS, AND THE CENSUS THAT SAYS THEY ARE GONE ════════════════
 *
 * ── WHY A SECOND HEAL FOR A MIGRATION THAT ALREADY BACKFILLED ───────────────────────────────
 *
 * 0083 promoted every stood-down row to a connected reader — when it ran. The OLD worker kept
 * running afterwards and can express a stand-down only as `status = 'disabled'` plus an
 * `organized_elsewhere:*` reason, so every stand-down it recorded between the migration and its
 * own replacement landed in the shape 0083 had just removed. Those rows are `disabled`, therefore
 * off the roster, therefore never touched by the new worker: they cannot heal.
 *
 * Measured in production before the migration: connected organizers, a few disabled ones, a disabled
 * READER, and ZERO connected readers — the reader path had never run on real data.
 *
 * ── WHY REAL POSTGRES ───────────────────────────────────────────────────────────────────────
 *
 * The guard this statement turns on is a PARTIAL UNIQUE INDEX (`mailboxes_active_address_uq`,
 * `WHERE status <> 'disabled'`), and 0083's header records that promoting past it takes the whole
 * migration down mid-deploy. A partial index is exactly the kind of thing PGlite green says
 * nothing about, and the failure mode is a deploy that stops rather than a test that fails.
 *
 * The last case is the CENSUS ASSERTION the release train verifies on the hosted service after the
 * deploy: no `disabled` row may carry an `organized_elsewhere:*` reason.
 *
 * Mutation-checked, each watched red and restored:
 *  · drop the `NOT EXISTS` guard        → the superseded-sibling case (a unique violation);
 *  · drop `organized_by_kind`           → the holder case;
 *  · widen to `disabled_reason IS NULL` → the user's-own-disconnect case.
 */

const URL = pgTestUrl(import.meta.url);
const client = postgres(URL, { max: 2 });
const db = brandDialect(drizzle(client, { schema }), "pg");
const tx = db as unknown as Tx;

beforeAll(async () => { await runMigrations(URL); });
afterAll(async () => { await client.end({ timeout: 5 }); });

/** Re-apply 0085's statement, exactly as the journal holds it — never a paraphrase. */
async function heal(): Promise<void> {
  await tx.execute(sql`
    UPDATE "mailboxes" AS m SET
      "status" = 'connected',
      "organizer_role" = 'reader',
      "organized_by_kind" = split_part(m."disabled_reason", ':', 2),
      "disabled_reason" = NULL
    WHERE m."status" = 'disabled'
      AND m."disabled_reason" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "mailboxes" AS o
        WHERE o."account_id" = m."account_id"
          AND lower(o."address") = lower(m."address")
          AND o."id" <> m."id"
          AND o."status" <> 'disabled'
      )`);
}

async function account(): Promise<string> {
  const id = randomUUID();
  await tx.insert(accounts).values({ id, name: "heal-readers" });
  return id;
}

const rowOf = async (id: string) =>
  (await tx.select().from(mailboxes).where(eq(mailboxes.id, id)).limit(1))[0]!;

/**
 * The shape the OLD worker wrote after 0083 had already swept: disabled, with a reason.
 *
 * `role` is a PARAMETER because production holds BOTH spellings, and the second is the dangerous
 * one — see the `organizer` case below. Default `reader`, which is the row the census found first.
 */
async function stranded(
  accountId: string, address: string, reason: string,
  role: "reader" | "organizer" = "reader",
): Promise<string> {
  const [row] = await tx.insert(mailboxes).values({
    accountId, provider: "imap", address,
    status: "disabled", disabledReason: reason,
    // The second inconsistency the census found: role says reader, holder says nobody.
    organizerRole: role, organizedByKind: null, organizedByName: null,
  }).returning();
  return row!.id;
}

describe("0085 — the stranded readers are promoted", () => {
  it("a disabled row with an organized_elsewhere reason becomes a CONNECTED reader", async () => {
    const acct = await account();
    const id = await stranded(acct, `strand-${acct}@example.test`, "organized_elsewhere:local");
    await heal();
    const row = await rowOf(id);
    // Connected is what puts it back on the roster — `loadEnabledMailboxes` filters `disabled`
    // out, which is the whole reason it could not heal itself.
    expect(row.status).toBe("connected");
    expect(row.organizerRole).toBe("reader");
    // …and the holder is describable again. `role = reader` with a null holder contradicts the
    // DTO's own contract, so a client rendering the banner had nobody to name.
    expect(row.organizedByKind).toBe("local");
    expect(row.disabledReason, "the role carries this now").toBeNull();
  });

  it("A ROW STILL MARKED `organizer` IS DEMOTED — or the heal manufactures a SECOND organizer", async () => {
    /* THE SHARPEST ROW IN PRODUCTION, and the one that makes this statement's SET unconditional
       rather than incidental. The census found a second stranded row whose `organizer_role` is
       still `organizer` — the old worker disconnected the mailbox without touching the column,
       because in its model `disabled` WAS the whole stand-down.
       Promoting `status` alone would hand that row back to the roster as a CONNECTED ORGANIZER of
       a mailbox Cloud has already stood down from: two organizers on one mailbox, which is the
       single invariant the whole lease exists to keep. `organizer_role = 'reader'` is in the SET
       and `organizer_role` is deliberately ABSENT from the WHERE, so every row this promotes is
       demoted in the same statement whatever it claimed before. */
    const acct = await account();
    const id = await stranded(acct, `stillorg-${acct}@example.test`, "organized_elsewhere:cloud", "organizer");
    await heal();
    const row = await rowOf(id);
    expect(row.status).toBe("connected");
    expect(row.organizerRole, "the heal put a second organizer on a stood-down mailbox").toBe("reader");
    expect(row.organizedByKind).toBe("cloud");
    expect(row.disabledReason).toBeNull();
  });

  it("the holder kind is parsed from the reason, cloud as well as local", async () => {
    const acct = await account();
    const id = await stranded(acct, `cloudy-${acct}@example.test`, "organized_elsewhere:cloud");
    await heal();
    expect((await rowOf(id)).organizedByKind).toBe("cloud");
  });

  it("A USER'S OWN DISCONNECT IS UNTOUCHED — a tombstone is not a stand-down", async () => {
    // `disabled` with NO reason. The census counted two of these in production, and promoting one
    // would resurrect a mailbox somebody deliberately removed.
    const acct = await account();
    const [row] = await tx.insert(mailboxes).values({
      accountId: acct, provider: "imap", address: `gone-${acct}@example.test`,
      status: "disabled", disabledReason: null,
    }).returning();
    await heal();
    const after = await rowOf(row!.id);
    expect(after.status).toBe("disabled");
    expect(after.organizerRole, "a tombstone was demoted as well as revived").toBe("organizer");
  });

  it("A SUPERSEDED ROW STAYS DISABLED — promoting it would violate the partial unique index", async () => {
    // Not hypothetical, and it is why the guard exists: `mailboxes_active_address_uq` is UNIQUE on
    // `(account_id, lower(address)) WHERE status <> 'disabled'`, so the same address can be live
    // beside a stood-down row. Promoting the old one takes the migration down mid-deploy.
    const acct = await account();
    const addr = `dupe-${acct}@example.test`;
    const old = await stranded(acct, addr, "organized_elsewhere:local");
    await tx.insert(mailboxes).values({
      accountId: acct, provider: "imap", address: addr.toUpperCase(), status: "connected",
    });
    /* A LOOSE ROW IN THE SAME ACCOUNT, and it is what makes this case prove SELECTIVITY rather
       than mere survival. Without it, "the superseded row stayed disabled" is equally true of a
       statement that promoted nothing at all, and the `NOT EXISTS` clause would be untested.
       It matters beyond this file: on today's production data the only superseded pair has a NULL
       reason, so the clause is INERT there — a production zero after the migration cannot prove it. This
       fixture is the only place the clause is exercised. */
    const loose = await stranded(acct, `loose-${acct}@example.test`, "organized_elsewhere:local");
    // The statement itself must not throw — that is the first assertion.
    await heal();
    expect((await rowOf(old)).status, "the superseded row was promoted into a unique violation")
      .toBe("disabled");
    expect((await rowOf(old)).disabledReason, "a superseded row KEEPS its reason")
      .toBe("organized_elsewhere:local");
    expect((await rowOf(loose)).status, "the guard swallowed a row it should have promoted")
      .toBe("connected");
    expect((await rowOf(loose)).organizerRole).toBe("reader");
  });

  it("IDEMPOTENT — a replay writes nothing, which every desktop launch depends on", async () => {
    const acct = await account();
    const id = await stranded(acct, `again-${acct}@example.test`, "organized_elsewhere:local");
    await heal();
    const first = await rowOf(id);
    await heal();
    expect(await rowOf(id)).toEqual(first);
  });

  it("THE CENSUS: no STRANDED disabled reader is left — and `stranded` excludes the superseded", async () => {
    /* The assertion the release train re-runs on the hosted service after the deploy, and the
       qualifier is not a softening — it is the statement's own scope.
       A SUPERSEDED row keeps its reason AND stays disabled BY DESIGN: promoting it would violate
       `mailboxes_active_address_uq`, which is the guard tested above. So the naive census — "no
       disabled row carries an organized_elsewhere reason" — is FALSE by construction, and a
       production check written that way reports every legitimately superseded row as a failure.
       Measured on the shared test database: many such rows, ALL of them with a live sibling and
       none of them a hole. The `NOT EXISTS` here is the same clause the migration uses, so the
       check and the statement cannot disagree about what "stranded" means.
       Over the WHOLE table rather than this test's own rows, which is what makes it a census. */
    await heal();
    const left = await tx.execute(sql`
      SELECT m."id" FROM "mailboxes" AS m
      WHERE m."status" = 'disabled'
        AND m."disabled_reason" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "mailboxes" AS o
          WHERE o."account_id" = m."account_id"
            AND lower(o."address") = lower(m."address")
            AND o."id" <> m."id"
            AND o."status" <> 'disabled'
        )`);
    expect([...left].map((r) => (r as { id: string }).id),
      "stranded disabled readers remain after the heal").toEqual([]);
  });
});
