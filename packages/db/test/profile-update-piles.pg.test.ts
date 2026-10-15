import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accounts, awayResponders } from "@trafficflow/db";
import { applyProfileUpdate, validateProfileUpdatePayload } from "../src/request-apply.js";
import { MIGRATED_DB_TEARDOWN_BUDGET_MS, PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import type { Tx } from "../src/change-log.js";
import { brandDialect } from "../src/dialect/index.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  `profile.update` WRITES THE AWAY RESPONDER'S PILE SCOPE — against a real server
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The ruling of 2026-09-10, "the away responder's pile scope travels in the profile fan-out". The
 * validator's own arms are measured off-box in `request-apply.test.ts` and the whole drain is
 * driven on PGlite in `apps/worker/test/request-drain.test.ts`. What is measured HERE is the
 * WRITE, and it is here for three reasons that PGlite cannot answer:
 *
 *  1. `piles` is a `text[]` behind a containment CHECK (`away_responders_piles_closed`). An array
 *     bound into an `onConflictDoUpdate` SET is exactly the serialisation class that has bitten
 *     this repo twice against a real server and never against PGlite — a bare array in a raw
 *     `sql` fragment renders flattened (`malformed array literal` for one member, a syntax error
 *     for none), and the sibling `away-piles-closed.pg.test.ts` carries that lesson in its own
 *     docblock. The applier writes through drizzle's column-aware builder for that reason, and
 *     this file is what proves the choice against the server rather than against an assumption.
 *  2. The property under test is a PARTIAL update: an absent scope must leave the stored array
 *     untouched while the six fields beside it replace. That is a statement about which columns
 *     the emitted SET names, which is only true of the SQL a real server parses.
 *  3. The DEFAULT on the insert arm is the database's, not the code's. A test that wrote
 *     `'{INBOX}'` itself would prove nothing about the column.
 *
 * ── A PRIVATE DATABASE, NOT THE SHARED `trafficflow_test` ───────────────────────────────────
 *
 * Created and dropped per run, the shape `away-piles-closed.pg.test.ts` uses. The shared box
 * carries the release chain's own journal watermark, and drizzle applies only a `when` strictly
 * after the recorded max — so a lane running its journal there either poisons that watermark for
 * everybody or silently records a migration as applied without running it. A private database
 * also makes the reads below scopeable to rows this file created, so nothing here can be poisoned
 * by, or poison, a co-tenant.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MAIL_DIR = join(HERE, "..", "..", "db-mail", "drizzle");
const ADMIN_URL = PG_TEST_URL;
const PG_UP = await realPgAvailable(ADMIN_URL);

const NOW = new Date("2026-09-10T09:00:00.000Z");

/** The six fields every `awayResponder` patch carries, whatever release wrote it. */
const SIX = {
  enabled: true, body: "Back Monday.", startsAt: null, endsAt: null,
  audience: "screened_in", throttle: "per_day",
};

describe.skipIf(!PG_UP)("profile.update writes the away responder's pile scope", () => {
  const dbName = `tf_pu_piles_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let admin: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase;

  beforeAll(async () => {
    admin = postgres(ADMIN_URL, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${dbName}`;
    client = postgres(url.toString(), { max: 1, onnotice: () => {} });
    db = brandDialect(drizzle(client), "pg");
    await migrate(db, { migrationsFolder: MAIL_DIR, migrationsSchema: "drizzle_mail" });
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 }).catch(() => {});
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`).catch(() => {});
    await admin?.end({ timeout: 5 }).catch(() => {});
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  /** A fresh account, and optionally an away row already at a chosen scope. */
  async function seed(storedPiles?: string[]): Promise<string> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: "profile update piles" });
    if (storedPiles !== undefined) {
      await db.insert(awayResponders).values({
        accountId, enabled: false, body: "old text",
        audience: "everyone", throttle: "per_week", piles: storedPiles,
      });
    }
    return accountId;
  }

  /** Validate a payload and apply it, exactly as the drain does. Returns the applier's answer. */
  async function applyPayload(accountId: string, payload: unknown): Promise<readonly string[]> {
    const update = validateProfileUpdatePayload(payload);
    if (!update) throw new Error("the payload was refused by the validator");
    // A mailbox id is required by the input shape and only the SIGNATURE arm reads it; these
    // payloads name no signature, so a uuid that matches no row cannot affect the away write.
    const r = await db.transaction((tx) => applyProfileUpdate(tx as unknown as Tx, {
      accountId, mailboxId: randomUUID(), payload: update, now: NOW,
    }));
    return r.wrote;
  }

  const scopeOf = async (accountId: string): Promise<string[]> => {
    const [row] = await db.select({ piles: awayResponders.piles })
      .from(awayResponders).where(eq(awayResponders.accountId, accountId));
    return row!.piles;
  };

  it("a payload carrying both piles writes that array over an existing narrow row", async () => {
    /* THE DEFECT, at the row. The SET did not name the column, so this wrote the six fields and
       left the scope where it was — acked `applied`, with the pane showing the old value back. */
    const accountId = await seed(["INBOX"]);
    const wrote = await applyPayload(accountId, {
      awayResponder: { ...SIX, piles: ["INBOX", "ohmail/News"] },
    });
    expect(wrote).toContain("awayResponder");
    expect(await scopeOf(accountId)).toEqual(["INBOX", "ohmail/News"]);
  });

  it("a payload carrying a NARROWER scope writes that too — the SET is not one-way", async () => {
    /* The mirror of the case above, and not a duplicate of it: a SET that wrote the union, or that
       only ever widened, would pass the first assertion and fail this one. Somebody opting Reads
       back OUT is the same edit in the other direction and it has to land. */
    const accountId = await seed(["INBOX", "ohmail/News"]);
    await applyPayload(accountId, { awayResponder: { ...SIX, piles: ["INBOX"] } });
    expect(await scopeOf(accountId)).toEqual(["INBOX"]);
  });

  it("an explicit EMPTY scope is written — containment admits it and the rule reads it by name", async () => {
    const accountId = await seed(["INBOX", "ohmail/News"]);
    await applyPayload(accountId, { awayResponder: { ...SIX, piles: [] } });
    expect(await scopeOf(accountId), "an empty scope was read as 'no filter' and dropped").toEqual([]);
  });

  it("a payload WITHOUT piles leaves an existing scope untouched, from either value", async () => {
    /* THE COMPATIBILITY ARM against the server, and BOTH stored values are tried on purpose:
       asserting only the wide one is satisfied by a SET that writes the wide value
       unconditionally, and only the narrow one by a SET that writes the column's default. Only a
       SET that does not name the column at all satisfies the pair. */
    for (const stored of [["INBOX", "ohmail/News"], ["INBOX"]]) {
      const accountId = await seed(stored);
      await applyPayload(accountId, { awayResponder: { ...SIX } });
      expect(await scopeOf(accountId),
        `an absent scope overwrote a stored ${JSON.stringify(stored)}`).toEqual(stored);
      // …and the fields it DID name replaced, so this is not green by nothing being applied.
      const [row] = await db.select({ audience: awayResponders.audience, body: awayResponders.body })
        .from(awayResponders).where(eq(awayResponders.accountId, accountId));
      expect(row!.audience).toBe("screened_in");
      expect(row!.body).toBe("Back Monday.");
    }
  });

  it("the INSERT arm with no piles takes the DATABASE's own narrow default", async () => {
    /* Read off the server rather than written by the test: the recoverable direction is the
       column's, and an older install's request creating a row must not widen anything. */
    const accountId = await seed();
    await applyPayload(accountId, { awayResponder: { ...SIX } });
    expect(await scopeOf(accountId)).toEqual(["INBOX"]);
  });

  it("the INSERT arm carrying a scope writes it", async () => {
    const accountId = await seed();
    await applyPayload(accountId, { awayResponder: { ...SIX, piles: ["ohmail/News"] } });
    expect(await scopeOf(accountId)).toEqual(["ohmail/News"]);
  });

  it("a non-member never reaches the server, and the CHECK would refuse it if it did", async () => {
    /* TWO GATES, and they answer different questions. The validator turns a bad request into a
       named refusal the reader can act on (`invalid_payload` at the drain) and is asserted here by
       the row not moving. The CHECK makes the value unrepresentable whichever writer produced it,
       and is asserted by driving the column directly — so a build whose validator was wrong would
       still not store a scope no rule can act on.

       `ohmail/Screened` is the member for this pair since 0.16.1 widened the offered set: the
       durable "no" of a screening decision is a folder no setting may reach, where Receipts and
       the Screener are piles somebody may tick. */
    const accountId = await seed(["INBOX"]);
    expect(validateProfileUpdatePayload({
      awayResponder: { ...SIX, piles: ["INBOX", "ohmail/Screened"] },
    })).toBeNull();
    expect(await scopeOf(accountId)).toEqual(["INBOX"]);

    const direct = await db.update(awayResponders)
      .set({ piles: ["ohmail/Screened"] })
      .where(eq(awayResponders.accountId, accountId))
      .then(() => "accepted", () => "refused");
    expect(direct, "the database accepted a pile outside the closed set").toBe("refused");
    expect(await scopeOf(accountId)).toEqual(["INBOX"]);
  });

  /**
   * THE SCREENER PILE TRAVELS ONLY BESIDE THE WIDER AUDIENCE (0.16.1) — one record, both halves,
   * so this door can and does check the pair. Receipts beside the narrow audience is the
   * discriminator: the rule is one member's, not the whole scope's.
   */
  it("the Screener pile is refused beside `screened_in` and written beside `everyone`", async () => {
    const narrow = await seed(["INBOX"]);
    expect(validateProfileUpdatePayload({
      awayResponder: { ...SIX, piles: ["INBOX", "ohmail/Screener"] },
    }), "the Screener pile travelled beside an audience that answers nobody there").toBeNull();
    expect(await scopeOf(narrow)).toEqual(["INBOX"]);

    await applyPayload(narrow, {
      awayResponder: { ...SIX, piles: ["INBOX", "ohmail/Receipts"] },
    });
    expect(await scopeOf(narrow)).toEqual(["INBOX", "ohmail/Receipts"]);

    const wide = await seed(["INBOX"]);
    await applyPayload(wide, {
      awayResponder: { ...SIX, audience: "everyone", piles: ["INBOX", "ohmail/Screener"] },
    });
    expect(await scopeOf(wide)).toEqual(["INBOX", "ohmail/Screener"]);
  });

  it("the constraint this file relies on exists under the name the migration creates", async () => {
    /* If the journal ever stopped creating it, every refusal above would still pass for the
       validator's sake while the second gate was silently gone. */
    const rows = await db.execute<{ conname: string }>(sql`
      SELECT conname FROM pg_constraint WHERE conname = 'away_responders_piles_closed'`);
    expect((rows as unknown as unknown[]).length).toBe(1);
  });
});
