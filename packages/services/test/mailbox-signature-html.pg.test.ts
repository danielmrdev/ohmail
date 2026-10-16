import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import { accountSettings, accounts, changeLog, mailboxes, accountSyncState } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  mailboxSignatureHtmls, mailboxSignatures, setMailboxSignature,
} from "../src/consent-seed.js";
import type { ServiceContext } from "../src/context.js";
import { brandDialect } from "@trafficflow/db/dialect";

/**
 * THE SIGNATURE'S TWO SHAPES, ON REAL POSTGRES — mail 0098.
 *
 * ── WHY `.pg.test.ts` AND NOT ONLY THE PGLITE TWIN ───────────────────────────────────────
 *
 * `mailbox-signature-html.test.ts` proves the DECISIONS (which shape is authoritative, what is
 * derived, what is refused) and it proves them against PGlite. Three things it cannot see, each
 * of which has cost this repository a release:
 *
 *   · THE COLUMN. PGlite runs the same journal, but "the migration applies" and "the migration
 *     applies to the database the fleet runs" are different claims, and the second is the one a
 *     deploy depends on. A `signature_html` that exists only under PGlite is a `GET /consent`
 *     that fails in production while every off-box suite is green.
 *   · THE DRIVER. PGlite and postgres@3 disagree about parameter serialization, and the
 *     disagreement is invisible until a real connection binds the value — a whole seam went red
 *     that way once the pg twins finally ran. The values here are text, which is the quiet case;
 *     running them is how it stays quiet.
 *   · THE ROLLBACK. The both-halves refusal is thrown inside the transaction's own scope on the
 *     text path and BEFORE it opens on this one; that the refused request persists nothing is a
 *     property of a real transaction, and one connection cannot demonstrate it.
 *
 * ── SCOPING, BECAUSE THIS TABLE IS SHARED ────────────────────────────────────────────────
 *
 * One account, minted per run, and every read is filtered to it. Nothing is stamped in the
 * future and nothing is read deployment-globally: two `.pg.test.ts` files that each pass alone
 * have poisoned each other through this database before, and the order they happened to run in
 * was the only reason the pair was ever green. `afterAll` removes exactly what this file made.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ACCOUNT = randomUUID();
const NOW = new Date("2026-09-08T12:00:00.000Z");

const ctx = (): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId: ACCOUNT,
  userId: null,
  now: () => NOW,
  requestId: `sgh-${randomUUID()}`,
} as ServiceContext);

const columns = async (id: string) => {
  const [row] = await db
    .select({ signature: mailboxes.signature, signatureHtml: mailboxes.signatureHtml })
    .from(mailboxes)
    .where(and(eq(mailboxes.id, id), eq(mailboxes.accountId, ACCOUNT)));
  return row!;
};

describe.skipIf(!PG_UP)("mail 0098 — the signature's markup half on real Postgres", () => {
  let mb: string;

  beforeAll(async () => {
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
    await runMigrations(PG_TEST_URL);
    await db.insert(accounts).values({ id: ACCOUNT, name: `sgh-${ACCOUNT.slice(0, 8)}` });
    const [a] = await db.insert(mailboxes).values({
      id: randomUUID(), accountId: ACCOUNT, provider: "imap",
      address: `sgh-${ACCOUNT.slice(0, 8)}@x.example`,
    }).returning();
    mb = a!.id;
  });

  afterAll(async () => {
    await db.delete(changeLog).where(eq(changeLog.accountId, ACCOUNT));
    await db.delete(accountSyncState).where(eq(accountSyncState.accountId, ACCOUNT));
    await db.delete(accountSettings).where(eq(accountSettings.accountId, ACCOUNT));
    await db.delete(mailboxes).where(eq(mailboxes.accountId, ACCOUNT));
    await db.delete(accounts).where(eq(accounts.id, ACCOUNT));
    await client.end();
  });

  it("the column EXISTS and holds the sanitized markup, with the text derived from it", async () => {
    const out = await setMailboxSignature(
      ctx(), mb, null, "<p><strong>Anna</strong><br>ohmail<script>x()</script></p>",
    );
    // Sanitized on the way in — `script` goes with its content — and the text is rendered from
    // what survived, never from what arrived.
    expect(out.signatureHtml).toBe("<p><strong>Anna</strong><br />ohmail</p>");
    expect(out.signature).toBe("Anna\nohmail");
    const row = await columns(mb);
    expect(row.signatureHtml).toBe("<p><strong>Anna</strong><br />ohmail</p>");
    expect(row.signature).toBe("Anna\nohmail");
    // And through the read the settings route uses, scoped to this account.
    expect(await mailboxSignatureHtmls(db as never, ACCOUNT))
      .toEqual({ [mb]: "<p><strong>Anna</strong><br />ohmail</p>" });
    expect(await mailboxSignatures(db as never, ACCOUNT)).toEqual({ [mb]: "Anna\nohmail" });
  });

  it("a refused write persists NOTHING — the row is exactly what it was", async () => {
    const before = await columns(mb);
    await expect(setMailboxSignature(ctx(), mb, "Bob", "<p><em>Anna</em></p>"))
      .rejects.toMatchObject({ httpStatus: 400 });
    // Both columns unchanged: the refusal is not a partial write wearing an error's clothes.
    expect(await columns(mb)).toEqual(before);
  });

  it("a plain write clears the markup, in one statement on one row", async () => {
    expect((await columns(mb)).signatureHtml).not.toBeNull();
    await setMailboxSignature(ctx(), mb, "just words");
    const row = await columns(mb);
    expect(row.signature).toBe("just words");
    expect(row.signatureHtml).toBeNull();
  });

  it("markup that renders to nothing clears both halves", async () => {
    await setMailboxSignature(ctx(), mb, null, "<p><strong>Anna</strong></p>");
    expect((await columns(mb)).signatureHtml).not.toBeNull();
    await setMailboxSignature(ctx(), mb, null, "<p></p>");
    const row = await columns(mb);
    expect(row.signature).toBeNull();
    expect(row.signatureHtml).toBeNull();
  });

  it("every write rings the settings doorbell, and the log has no hole and no duplicate", async () => {
    // Scoped to this account's rows. The doorbell is what makes an open composer re-read
    // `GET /consent` and pick up the new shape; a signature write appends no other entity.
    const rows = await db.select().from(changeLog)
      .where(eq(changeLog.accountId, ACCOUNT)).orderBy(changeLog.seq);
    expect(rows.length).toBeGreaterThan(0);
    const seqs = rows.map((r) => Number(r.seq));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[seqs.length - 1]! - seqs[0]!).toBe(seqs.length - 1);
    expect(rows.every((r) => r.entityType === "settings")).toBe(true);
  });
});
