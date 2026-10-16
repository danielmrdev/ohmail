import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { accounts, mailboxes, contacts as contactsTbl, rules as rulesTbl, messages, folderState } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "../../src/adapters/drizzle-repo.js";
import { planChange, commitChange , UNMETERED_STORAGE_CAP} from "../../src/pipeline.js";
import type { Change } from "../../src/ports.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * `messages.auth_verdict` IS ACTUALLY WRITTEN, BY REAL SQL, IN THE INGEST TRANSACTION.
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHY THIS IS NOT A FAKE-REPO ASSERTION ─────────────────────────────────────────────────
 *
 * `packages/core/test/auth-verdict-ingest.test.ts` proves the ROUTING half against `FakeRepo`,
 * and it can only ever prove that `commitChange` ASKED for a column to be written. Whether the
 * value survives drizzle's insert builder, the column's nullability and the `ON CONFLICT DO
 * NOTHING` clause is a claim about SQL, and this repository has three production bugs on record
 * that PGlite reported green — every one of them in this file's subject area.
 *
 * ── AND THE CONCURRENCY HALF, WHICH ONLY REAL POSTGRES CAN ASK ────────────────────────────
 *
 * Two ingests of one message can both plan `new` before either commits. `InsertedMessage.created`
 * is how the loser learns it lost, and the loser's `ON CONFLICT DO NOTHING` never reaches the
 * `authVerdict` value at all — so the verdict on the row is the WINNER'S, written once. Under
 * PGlite the two "concurrent" transactions serialize on a single connection and the property is
 * green by construction. Here they are two connections against one row.
 */

const AVAILABLE = await realPgAvailable();

/** The authserv-id this deployment believes. */
const PROVIDER: ReadonlySet<string> = new Set(["mx.google.com"]);

const TRUSTED_FAIL = "mx.google.com; dkim=fail header.d=bank.example; spf=fail";

function eml(o: { from?: string; authResults?: string; messageId?: string } = {}): Buffer {
  const { from = "partner@bank.example", authResults, messageId = `av-${randomUUID()}` } = o;
  return Buffer.from([
    `Message-ID: <${messageId}>`,
    ...(authResults ? [`Authentication-Results: ${authResults}`] : []),
    `From: ${from}`,
    "To: mila@lichtgrat.example",
    "Subject: Notes from Tuesday",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "The minutes are attached to the next one.",
  ].join("\r\n"));
}

describe.skipIf(!AVAILABLE)("messages.auth_verdict, written by the real ingest path", () => {
  let owned: OwnedDb;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    // An INDEPENDENT pool: `makeDb`/`closeDb` share one module global and this file must not be
    // able to close a handle another test owns (`client.ts#makeOwnedDb`). Its `max: 5` is also
    // what the concurrency case needs — two "concurrent" transactions on a `max: 1` pool queue
    // in the POOL and prove nothing about the database.
    owned = makeOwnedDb(PG_TEST_URL);
  }, 180_000);

  afterAll(async () => { await owned?.close().catch(() => {}); });

  /** A fresh account + mailbox per case; the shared Postgres must not make counts flaky. */
  async function world(): Promise<{ accountId: string; mailboxId: string }> {
    const accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `av-${accountId.slice(0, 8)}` });
    const [mb] = await owned.db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: `${accountId}@av.test` }).returning();
    // The user let this sender through. This is the rule the finding says a forgery rode in on.
    await owned.db.insert(rulesTbl).values({
      accountId, kind: "sender", match: "partner@bank.example",
      destination: "ohmail/News", priority: 10, provenance: "manual", enabled: true,
    });
    return { accountId, mailboxId: mb!.id };
  }

  async function ingest(
    w: { accountId: string; mailboxId: string }, raw: Buffer, trusted?: ReadonlySet<string>,
  ): Promise<string> {
    const change: Change = { type: "create", locator: { folder: "INBOX", ref: "1:10" }, raw };
    const repo = makeDrizzleRepo(owned.db);
    const plan = await planChange(change, { ...w, repo, trustedAuthservIds: trusted });
    const res = await owned.db.transaction(async (tx) => {
      const txRepo = makeDrizzleRepo(tx as never);
      return commitChange(plan, { ...w, repo: txRepo, storageCap: UNMETERED_STORAGE_CAP });
    });
    return res.messageId;
  }

  const verdictOf = async (id: string): Promise<string | null> =>
    (await owned.db.select({ v: messages.authVerdict }).from(messages).where(eq(messages.id, id)))[0]!.v;

  const desiredOf = async (id: string): Promise<string> =>
    (await owned.db.select().from(folderState).where(eq(folderState.messageId, id)))[0]!.desiredFolder;

  it("a trusted failure lands on the column AND in folder_state, in one transaction", async () => {
    const w = await world();
    const id = await ingest(w, eml({ authResults: TRUSTED_FAIL }), PROVIDER);

    expect(await verdictOf(id)).toBe("fail");
    // The routing consequence and the record of its reason are the same commit. A row demoted
    // with a NULL verdict would leave the reason for the demotion nowhere on disk.
    expect(await desiredOf(id)).toBe("ohmail/Screener");
  });

  it("no header at all stores `unavailable` — NOT NULL, and not `unauthenticated`", async () => {
    const w = await world();
    const id = await ingest(w, eml(), PROVIDER);

    // The union's two "no evidence" members are distinguishable on disk on purpose: NULL means
    // nobody looked (`rules.ts#AuthVerdict`), and this ingest DID look.
    expect(await verdictOf(id)).toBe("unavailable");
    expect(await desiredOf(id)).toBe("ohmail/News");
  });

  it("with no trusted set the same forged message stores `unavailable` and routes as today", async () => {
    const w = await world();
    const id = await ingest(w, eml({ authResults: TRUSTED_FAIL }));

    expect(await verdictOf(id)).toBe("unavailable");
    expect(await desiredOf(id)).toBe("ohmail/News");
  });

  it("a known sender is promoted with no verdict — a verdict is never required", async () => {
    const w = await world();
    await owned.db.insert(contactsTbl).values({ accountId: w.accountId, address: "anna@work.example" });
    const id = await ingest(w, eml({ from: "anna@work.example" }), PROVIDER);

    // `unclear` leaves it where it arrived. If a positive verdict were ever required, this is
    // `ohmail/Screener` and a whole backlog goes with it.
    expect(await verdictOf(id)).toBe("unavailable");
    expect(await desiredOf(id)).toBe("INBOX");
  });

  /**
   * TWO CONNECTIONS, ONE MESSAGE — the shape PGlite cannot express.
   *
   * Both cycles plan before either commits, so both hold a `new` plan carrying the same verdict.
   * The winner inserts; the loser's `ON CONFLICT DO NOTHING` returns nothing, `created: false`,
   * and `commitChange` returns `duplicate` before touching anything else. One row, one verdict,
   * one `folder_state`.
   */
  it("a racing loser leaves the winner's verdict alone — one row, written once", async () => {
    const w = await world();
    const raw = eml({ authResults: TRUSTED_FAIL });
    const change: Change = { type: "create", locator: { folder: "INBOX", ref: "1:10" }, raw };
    const repo = makeDrizzleRepo(owned.db);

    const [planA, planB] = await Promise.all([
      planChange(change, { ...w, repo, trustedAuthservIds: PROVIDER }),
      planChange(change, { ...w, repo, trustedAuthservIds: PROVIDER }),
    ]);
    expect(planA.new!.authVerdict).toBe("fail");
    expect(planB.new!.authVerdict).toBe("fail");

    const commit = (plan: typeof planA) => owned.db.transaction(async (tx) => {
      const txRepo = makeDrizzleRepo(tx as never);
      return commitChange(plan, { ...w, repo: txRepo, storageCap: UNMETERED_STORAGE_CAP });
    });
    const [a, b] = await Promise.all([commit(planA), commit(planB)]);

    expect(a.messageId).toBe(b.messageId);
    expect([a.outcome, b.outcome].filter((o) => o === "duplicate")).toHaveLength(1);

    const rows = await owned.db.select().from(messages).where(eq(messages.accountId, w.accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.authVerdict).toBe("fail");
    expect(await desiredOf(a.messageId)).toBe("ohmail/Screener");
  });
});
