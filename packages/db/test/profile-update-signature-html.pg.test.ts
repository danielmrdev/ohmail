import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accounts, mailboxes } from "@trafficflow/db";
import {
  applyProfileUpdate, validateProfileUpdatePayload, TRAVELLING_SIGNATURE_HTML_MAX_BYTES,
} from "../src/request-apply.js";
import { MIGRATED_DB_TEARDOWN_BUDGET_MS, PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import type { Tx } from "../src/change-log.js";
import { brandDialect } from "../src/dialect/index.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  `profile.update` WRITES THE SIGNATURE'S MARKUP — against a real server
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The ruling of 2026-09-10, "a signature's formatting travels to the install that organizes the
 * mailbox". The validator's arms are measured off-box in `request-apply.test.ts` and the whole
 * drain is driven on PGlite in `apps/worker/test/request-drain.test.ts`. What is measured HERE is
 * the WRITE, for the two reasons PGlite cannot answer:
 *
 *  1. The property is a PARTIAL update — an absent markup key must leave the column untouched
 *     while the text beside it replaces, and an explicit `null` must replace. That is a statement
 *     about WHICH COLUMNS the emitted SET names, which is only true of the SQL a server parses.
 *  2. `null` bound into a `set()` and a column omitted from it are the same thing to a builder and
 *     different things to a row. The sibling `profile-update-piles.pg.test.ts` is here for the
 *     array-serialisation class one field over; this is the same lesson for the NULL case.
 *
 * ── A PRIVATE DATABASE, NOT THE SHARED `trafficflow_test` ───────────────────────────────────
 *
 * Created and dropped per run, the shape the piles twin uses. The shared box carries the release
 * chain's journal watermark and drizzle applies only a `when` strictly after the recorded max, so
 * a lane migrating there either poisons that watermark for everybody or records a migration as
 * applied without running it. A private database also scopes every read below to rows this file
 * created, so nothing here can be poisoned by, or poison, a co-tenant.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MAIL_DIR = join(HERE, "..", "..", "db-mail", "drizzle");
const ADMIN_URL = PG_TEST_URL;
const PG_UP = await realPgAvailable(ADMIN_URL);

const NOW = new Date("2026-09-10T09:00:00.000Z");

describe.skipIf(!PG_UP)("profile.update writes the signature's markup", () => {
  const dbName = `tf_pu_sightml_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
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

  /** A fresh account and mailbox, with both signature columns at chosen values. */
  async function seed(
    signature: string | null, signatureHtml: string | null,
  ): Promise<{ accountId: string; mailboxId: string }> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: "profile update signature html" });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `${randomUUID()}@example.test`,
      signature, signatureHtml,
    }).returning({ id: mailboxes.id });
    return { accountId, mailboxId: mb!.id };
  }

  /** Validate a payload and apply it, exactly as the drain does. Returns the applier's answer. */
  async function applyPayload(
    accountId: string, mailboxId: string, payload: unknown,
  ): Promise<readonly string[]> {
    const update = validateProfileUpdatePayload(payload);
    if (!update) throw new Error("the payload was refused by the validator");
    const r = await db.transaction((tx) => applyProfileUpdate(tx as unknown as Tx, {
      accountId, mailboxId, payload: update, now: NOW,
    }));
    return r.wrote;
  }

  const columns = async (mailboxId: string): Promise<{ signature: string | null; signatureHtml: string | null }> => {
    const [row] = await db
      .select({ signature: mailboxes.signature, signatureHtml: mailboxes.signatureHtml })
      .from(mailboxes).where(eq(mailboxes.id, mailboxId));
    return row!;
  };

  it("a payload carrying both shapes writes both columns over an existing pair", async () => {
    /* THE DEFECT, at the row. The payload had one signature slot and it was the derived TEXT, so
       this wrote the words and left the markup where it was — acked `applied`, with the holder
       appending a sign-off without the formatting. */
    const { accountId, mailboxId } = await seed("-- \nold words", "<p>old <b>words</b></p>");
    const wrote = await applyPayload(accountId, mailboxId, {
      signature: "-- \nMila", signatureHtml: "<p>-- <br><strong>Mila</strong></p>",
    });
    expect(wrote).toContain("signature");
    expect(wrote, "the change feed's written-column list does not name the new column")
      .toContain("signature_html");

    const after = await columns(mailboxId);
    expect(after.signature).toBe("-- \nMila");
    expect(after.signatureHtml, "the markup travelled and the row did not take it")
      .toBe("<p>-- <br><strong>Mila</strong></p>");
  });

  it("an ABSENT markup key leaves the column alone, from BOTH stored values", async () => {
    /* THE COMPATIBILITY ARM against a real server. Both stored values are tried: the markup case
       alone would be satisfied by a SET that never names the column, the NULL case alone by a SET
       that writes NULL unconditionally. Only a SET that names the column when the payload carried
       it and not otherwise satisfies the pair. */
    for (const storedHtml of ["<p>kept <em>markup</em></p>", null]) {
      const { accountId, mailboxId } = await seed("-- \nold", storedHtml);
      const wrote = await applyPayload(accountId, mailboxId, { signature: "-- \nnew words" });
      expect(wrote).toEqual(["signature"]);

      const after = await columns(mailboxId);
      expect(after.signatureHtml, `an absent markup key overwrote a stored ${JSON.stringify(storedHtml)}`)
        .toBe(storedHtml);
      expect(after.signature, "the field the payload DID name was not written").toBe("-- \nnew words");
    }
  });

  it("an EXPLICIT null CLEARS the markup — the plain save's rule, at the row", async () => {
    /* A plain save is saving the whole value. Without this the holder keeps markup the stored
       words no longer match, and its composer ships that in place of what was just saved. */
    const { accountId, mailboxId } = await seed("-- \nMila", "<p><strong>Mila</strong></p>");
    const wrote = await applyPayload(accountId, mailboxId, {
      signature: "-- \nMila, from the phone", signatureHtml: null,
    });
    expect(wrote).toContain("signature_html");

    const after = await columns(mailboxId);
    expect(after.signature).toBe("-- \nMila, from the phone");
    expect(after.signatureHtml, "an explicit clear left the markup standing").toBeNull();
  });

  it("markup ALONE writes only that column, and the text beside it is untouched", async () => {
    /* The mirror of the compatibility arm: a save that changed only the formatting must not blank
       the words. The same conditional SET is what makes both true. */
    const { accountId, mailboxId } = await seed("-- \nMila", null);
    const wrote = await applyPayload(accountId, mailboxId, {
      signatureHtml: "<p><em>Mila</em></p>",
    });
    expect(wrote).toEqual(["signature_html"]);

    const after = await columns(mailboxId);
    expect(after.signature, "a markup-only save blanked the words").toBe("-- \nMila");
    expect(after.signatureHtml).toBe("<p><em>Mila</em></p>");
  });

  it("the ACCOUNT predicate holds: another account's mailbox id writes nothing", async () => {
    /* `applyProfileUpdate` scopes the mailbox by account as well as by id, for the reason the move
       applier states — a predicate correct only because of a uniqueness constraint elsewhere stops
       being correct the day that constraint moves. */
    const mine = await seed("-- \nmine", "<p>mine</p>");
    const theirs = await seed("-- \ntheirs", "<p>theirs</p>");
    const wrote = await applyPayload(mine.accountId, theirs.mailboxId, {
      signature: "-- \nintruder", signatureHtml: "<p>intruder</p>",
    });
    // The applier reports what it asked to write; the row is what proves nothing crossed.
    expect(wrote).toContain("signature_html");

    const other = await columns(theirs.mailboxId);
    expect(other.signature, "another account's signature was overwritten").toBe("-- \ntheirs");
    expect(other.signatureHtml).toBe("<p>theirs</p>");
  });

  it("markup AT the bound is stored whole — the bound is a byte count, not a truncation", async () => {
    /* The bound refuses rather than truncating, so a document at it must arrive intact: a shorter
       value in the column would be a signature the person never wrote. */
    const filler = "y".repeat(TRAVELLING_SIGNATURE_HTML_MAX_BYTES - "<p></p>".length);
    const at = `<p>${filler}</p>`;
    expect(Buffer.byteLength(at, "utf8")).toBe(TRAVELLING_SIGNATURE_HTML_MAX_BYTES);

    const { accountId, mailboxId } = await seed(null, null);
    await applyPayload(accountId, mailboxId, { signatureHtml: at });
    const after = await columns(mailboxId);
    expect(after.signatureHtml).toBe(at);
  });
});
