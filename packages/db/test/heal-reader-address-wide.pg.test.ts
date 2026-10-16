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
 * ═══ 0086 — THE HEAL WITH AN ADDRESS-WIDE GUARD, AND A NO-OP ON TODAY'S ROWS ════════════════
 *
 * ── THE HOLE 0085 HAD ───────────────────────────────────────────────────────────────────────
 *
 * 0085's sibling test was scoped `o.account_id = m.account_id`, written about
 * `mailboxes_active_address_uq` — `UNIQUE (account_id, lower(address)) WHERE status <> 'disabled'`
 * — rather than about the mailbox. A mailbox is an address on somebody's mail server, two ohmail
 * accounts can hold rows for one, the index permits it, and a per-account guard cannot see it.
 * Production had that pair with one row stranded and off the roster, so nothing had noticed.
 *
 * The guard is purely on the address now: a stranded row whose address is already served by ANY
 * connected row stays disabled. Strictly narrower than 0085 — every row 0085 skips, this skips too.
 *
 * ── AND IT MUST NOT MOVE ANYTHING THAT IS THERE NOW ─────────────────────────────────────────
 *
 * The last case seeds the THREE rows production actually holds for the affected address and
 * asserts none of them changes. That is the assertion the release train reads: the lease has
 * already arbitrated the pair, both rows are consistent, and this migration is not allowed to
 * reopen it.
 *
 * Mutation-checked, each watched red and restored:
 *  · restore the per-account scope           → the cross-account case (0085's actual hole);
 *  · drop the sibling guard entirely          → the same case, and the no-op fixture;
 *  · widen to rows with no reason             → the user's-own-disconnect case.
 */

const URL = pgTestUrl(import.meta.url);
const client = postgres(URL, { max: 2 });
const db = brandDialect(drizzle(client, { schema }), "pg");
const tx = db as unknown as Tx;

beforeAll(async () => { await runMigrations(URL); });
afterAll(async () => { await client.end({ timeout: 5 }); });

/** 0086's statement, verbatim from the journal — never a paraphrase. */
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
        WHERE lower(o."address") = lower(m."address")
          AND o."id" <> m."id"
          AND o."status" <> 'disabled'
      )`);
}

const account = async (): Promise<string> => {
  const id = randomUUID();
  await tx.insert(accounts).values({ id, name: "heal-address-wide" });
  return id;
};
const rowOf = async (id: string) =>
  (await tx.select().from(mailboxes).where(eq(mailboxes.id, id)).limit(1))[0]!;

describe("0086 — the sibling test is on the ADDRESS, not on the account", () => {
  it("A CROSS-ACCOUNT LIVE SIBLING NOW BLOCKS THE HEAL — 0085's hole, closed", async () => {
    /* THE CASE THAT ACTUALLY HAPPENED. Two accounts, one address; one row stranded. 0085's
       per-account guard could not see the twin, promoted the stranded row, and the worker — which
       has ONE lease identity for every account — then read its own claim and made it an organizer
       too. Two organizers for one IMAP mailbox. */
    const a = await account();
    const b = await account();
    const addr = `shared-${a}@example.test`;
    const [stranded] = await tx.insert(mailboxes).values({
      accountId: a, provider: "imap", address: addr,
      status: "disabled", disabledReason: "organized_elsewhere:cloud", organizerRole: "organizer",
    }).returning();
    await tx.insert(mailboxes).values({
      accountId: b, provider: "imap", address: addr.toUpperCase(), status: "connected",
    });

    await heal();
    const after = await rowOf(stranded!.id);
    expect(after.status, "the stranded row was promoted beside a live twin on another account")
      .toBe("disabled");
    expect(after.disabledReason).toBe("organized_elsewhere:cloud");
  });

  it("CONTROL: with NO sibling at all it still heals, so the guard did not swallow everything", async () => {
    const a = await account();
    const [lone] = await tx.insert(mailboxes).values({
      accountId: a, provider: "imap", address: `lone-${a}@example.test`,
      status: "disabled", disabledReason: "organized_elsewhere:local", organizerRole: "organizer",
    }).returning();
    await heal();
    const after = await rowOf(lone!.id);
    expect(after.status).toBe("connected");
    // The role flip 0085 established, restated: a demoted install is a READER.
    expect(after.organizerRole).toBe("reader");
    expect(after.organizedByKind).toBe("local");
    expect(after.disabledReason).toBeNull();
  });

  it("a SAME-account live sibling still blocks it — the narrower rule is contained in this one", async () => {
    const a = await account();
    const addr = `same-${a}@example.test`;
    const [old] = await tx.insert(mailboxes).values({
      accountId: a, provider: "imap", address: addr,
      status: "disabled", disabledReason: "organized_elsewhere:local", organizerRole: "reader",
    }).returning();
    /* THE SAME ADDRESS, LIVE, ON THE SAME ACCOUNT — which the partial unique index permits
       precisely because the stranded row is `disabled` and therefore outside it. A first draft of
       this fixture used a DIFFERENT address and the case passed for the wrong reason: nothing
       blocked the heal because there was no sibling to block it. */
    await tx.insert(mailboxes).values({
      accountId: a, provider: "imap", address: addr.toUpperCase(), status: "connected",
    });
    await heal();
    expect((await rowOf(old!.id)).status).toBe("disabled");
  });

  it("IDEMPOTENT — a replay writes nothing, which every desktop launch depends on", async () => {
    const a = await account();
    const [lone] = await tx.insert(mailboxes).values({
      accountId: a, provider: "imap", address: `again-${a}@example.test`,
      status: "disabled", disabledReason: "organized_elsewhere:local",
    }).returning();
    await heal();
    const first = await rowOf(lone!.id);
    await heal();
    expect(await rowOf(lone!.id)).toEqual(first);
  });
});

describe("THE NO-OP ASSERTION — production's three rows, and none of them may move", () => {
  it("seeds the three settled rows as they stand and asserts nothing changes", async () => {
    /* THE STATE THE LEASE ALREADY ARBITRATED. Two connected rows on two accounts for one address —
       one organizer, one reader — and a third row disconnected by its owner. This migration must
       not reopen any of it: which account organizes that mailbox is the lease's to say and the
       product's own "Organize here instead" to change, not a statement in a journal.
       Shapes, not the real ids: the assertion is about the SHAPES the predicate sees. */
    const a = await account();
    const b = await account();
    const addr = `qa-${a}@example.test`;
    // the older row, stood down to reader by the lease.
    const [steppedDown] = await tx.insert(mailboxes).values({
      accountId: a, provider: "imap", address: addr, status: "connected",
      organizerRole: "reader", organizedByKind: "cloud", disabledReason: null,
    }).returning();
    // healed by 0085, then promoted by the worker; it kept the role.
    const [promoted] = await tx.insert(mailboxes).values({
      accountId: b, provider: "imap", address: addr, status: "connected",
      organizerRole: "organizer", disabledReason: null,
    }).returning();
    // disabled by its OWNER, which carries no reason and is not a stand-down.
    const [ownerDisabled] = await tx.insert(mailboxes).values({
      accountId: b, provider: "imap", address: `other-${addr}`,
      status: "disabled", disabledReason: null, organizerRole: "organizer",
    }).returning();

    const before = await Promise.all([rowOf(steppedDown!.id), rowOf(promoted!.id), rowOf(ownerDisabled!.id)]);
    await heal();
    const after = await Promise.all([rowOf(steppedDown!.id), rowOf(promoted!.id), rowOf(ownerDisabled!.id)]);
    expect(after, "0086 moved a row the lease had already settled").toEqual(before);
  });
});
