import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, mailboxes, idempotencyKeys, organizerRequests, tags,
  AccountErasedError, MailboxErasedError, fencedAccountWrite,
  claimIdempotencyKey, insertOrganizerRequest,
  type Tx,
} from "../src/index.js";
// The staging ticket is a CLOUD leaf — `attachment_staging` is a hosted table, not a mail one.
import { attachmentStaging, createStagingTicket } from "../src/cloud.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE SEAM, THE MAILBOX STAMP, AND THE THREE DB-LAYER WRITERS THAT ASK THEM
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The defect these close, in one sentence: a read begins before the erasure, the erasure commits
 * and is reported complete, and an unfenced write then completes and recreates the person's data.
 * It was found at twelve call sites, which is why the fix is a seam and not twelve calls.
 *
 * WHY `.pg.test.ts`: the fence reads `accounts.erased_at FOR SHARE`, and PGlite is ONE connection
 * — the erasure and the writer are serialised by the driver before either reaches a lock, so a
 * fence that takes no lock passes there. The sweep runs on its OWN connection here, as it does in
 * production: an erasure is a request on another host, not a statement this writer makes.
 *
 * THE ORDER IS THE CONTROL. Erasing BEFORE a writer's own read measures nothing — the writer
 * finds no subject and never reaches its write. Every case below erases at the LAST AWAIT before
 * the write: for these three primitives the caller's read is outside the function, so calling
 * them after a committed erasure IS that window.
 *
 * MUTATIONS WATCHED RED, THEN RESTORED (pristine copy back, `cmp`):
 *  · `fenceErased`'s account arm deleted → every account case red on the recreated row;
 *  · its mailbox arm deleted → the mailbox cases red, the account cases still green, which is the
 *    split that proves the granularity half is doing work the account's stamp cannot;
 *  · the stamp deleted from `sweepMailboxData` → the services control's mailbox cases red, because
 *    a fence is only as real as the stamp it reads.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let sweepClient: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let sweepDb: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  if (!PG_UP) return;
  await runMigrations(PG_TEST_URL);
  client = postgres(PG_TEST_URL, { max: 6, onnotice: () => {} });
  sweepClient = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
  db = brandDialect(drizzle(client, { schema }), "pg");
  sweepDb = brandDialect(drizzle(sweepClient, { schema }), "pg");
});

afterAll(async () => {
  await client?.end({ timeout: 5 });
  await sweepClient?.end({ timeout: 5 });
});

const NOW = new Date("2026-09-14T12:00:00.000Z");

async function seed(): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "seam" });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId}@seam.test`,
  }).returning({ id: mailboxes.id });
  return { accountId, mailboxId: mb!.id };
}

/** The account's erasure, reduced to the one statement every fence is ordered against. */
async function eraseAccount(accountId: string): Promise<void> {
  await sweepDb.update(accounts).set({ erasedAt: NOW }).where(eq(accounts.id, accountId));
}

/**
 * The MAILBOX's erasure, reduced to the stamp the fence is ordered against. `sweepMailboxData`
 * lives in `packages/services`, which this package may not import — that the SWEEP writes this
 * stamp, in its own transaction, is proved in `packages/services/test/erasure-fence-everywhere`.
 * What is proved here is the other half: the fence reads it and refuses.
 */
async function eraseMailbox(_accountId: string, mailboxId: string): Promise<void> {
  await sweepDb.update(mailboxes).set({ erasedAt: NOW }).where(eq(mailboxes.id, mailboxId));
}

describe.skipIf(!PG_UP)("the erasure seam", () => {
  it("refuses a write on an ERASED ACCOUNT and leaves no row", async () => {
    const { accountId } = await seed();
    await eraseAccount(accountId);
    await expect(fencedAccountWrite(db as unknown as Tx, { accountId }, async (tx) => {
      await tx.insert(tags).values({ accountId, name: "back from the dead" });
    })).rejects.toBeInstanceOf(AccountErasedError);
    const rows = await db.select({ id: tags.id }).from(tags).where(eq(tags.accountId, accountId));
    expect(rows, "the seam let a row through on an erased account").toHaveLength(0);
  });

  it("refuses a MAILBOX-scoped write on an erased mailbox whose ACCOUNT is live", async () => {
    // The granularity half, isolated: nothing about the account has changed, so a fence that only
    // reads `accounts.erased_at` admits this write — which is exactly what it did.
    const { accountId, mailboxId } = await seed();
    await eraseMailbox(accountId, mailboxId);
    const live = await db.select({ erasedAt: accounts.erasedAt })
      .from(accounts).where(eq(accounts.id, accountId));
    expect(live[0]!.erasedAt, "the account was erased too — the case proves nothing").toBeNull();

    await expect(fencedAccountWrite(db as unknown as Tx, { accountId, mailboxId }, async (tx) => {
      await tx.insert(organizerRequests).values({
        id: randomUUID(), accountId, mailboxId, kind: "screener.decide",
        payload: {}, decidedAt: NOW, state: "pending",
      });
    })).rejects.toBeInstanceOf(MailboxErasedError);
    const rows = await db.select({ id: organizerRequests.id })
      .from(organizerRequests).where(eq(organizerRequests.mailboxId, mailboxId));
    expect(rows, "the seam let a row through on an erased mailbox").toHaveLength(0);
  });

  it("writes on a LIVE account and a live mailbox — the positive control", async () => {
    // Without this every refusal above is satisfied by a seam that refuses everything.
    const { accountId, mailboxId } = await seed();
    const out = await fencedAccountWrite(db as unknown as Tx, { accountId, mailboxId }, async (tx) => {
      await tx.insert(tags).values({ accountId, name: "ordinary" });
      return "written";
    });
    expect(out).toBe("written");
    expect(await db.select({ id: tags.id }).from(tags).where(eq(tags.accountId, accountId)))
      .toHaveLength(1);
  });

  it("an id with NO row is not a refusal — the sweeps never delete one", async () => {
    // `accounts` survives erasure and `mailboxes` survives its own sweep, so an absent row means
    // the id was never real. Refusing here would turn the fence into an existence check nobody
    // asked for and would break every suite that mints ids without seeding them.
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: "no mailbox" });
    await expect(fencedAccountWrite(db as unknown as Tx,
      { accountId, mailboxId: randomUUID() }, async () => "ok")).resolves.toBe("ok");
  });
});

describe.skipIf(!PG_UP)("the three db-layer writers", () => {
  it("the STAGING TICKET is refused after erasure — no filename, no fresh upload window", async () => {
    const { accountId } = await seed();
    await eraseAccount(accountId);
    await expect((db as unknown as Tx).transaction(async (tx) => createStagingTicket(tx, {
      id: randomUUID(), accountId, objectPath: `staging/${randomUUID()}`,
      filename: "a-name-of-theirs.pdf", contentType: "application/pdf", sizeBytes: 10, now: NOW,
    }))).rejects.toBeInstanceOf(AccountErasedError);
    expect(await db.select({ id: attachmentStaging.id }).from(attachmentStaging)
      .where(eq(attachmentStaging.accountId, accountId))).toHaveLength(0);
  });

  it("the STAGING TICKET is minted for a live account — the positive", async () => {
    const { accountId } = await seed();
    const t = await (db as unknown as Tx).transaction(async (tx) => createStagingTicket(tx, {
      id: randomUUID(), accountId, objectPath: `staging/${randomUUID()}`,
      filename: "ordinary.pdf", contentType: "application/pdf", sizeBytes: 10, now: NOW,
    }));
    expect(t.filename).toBe("ordinary.pdf");
  });

  it("the IDEMPOTENCY CLAIM is refused after erasure", async () => {
    // The screener's suggest run awaits a model between its session check and this claim.
    const { accountId } = await seed();
    await eraseAccount(accountId);
    await expect((db as unknown as Tx).transaction(async (tx) => claimIdempotencyKey(tx, {
      accountId, key: "k1", requestHash: "h", responseStatus: 200,
      responseJson: { suggestions: ["a sender's address"] }, seq: 0, now: NOW,
    }))).rejects.toBeInstanceOf(AccountErasedError);
    expect(await db.select({ key: idempotencyKeys.key }).from(idempotencyKeys)
      .where(eq(idempotencyKeys.accountId, accountId))).toHaveLength(0);
  });

  it("the IDEMPOTENCY CLAIM is taken on a live account — the positive", async () => {
    const { accountId } = await seed();
    const claimed = await (db as unknown as Tx).transaction(async (tx) => claimIdempotencyKey(tx, {
      accountId, key: "k1", requestHash: "h", responseStatus: 200,
      responseJson: {}, seq: 0, now: NOW,
    }));
    expect(claimed).toBe(true);
  });

  it("the ORGANIZER REQUEST is refused when the MAILBOX alone was erased", async () => {
    /* THE SITE THE REVIEW NAMED, and the reason "add the call" was not the whole answer: this
       writer's caller DID fence, on the account, and the account is untouched here. */
    const { accountId, mailboxId } = await seed();
    await eraseMailbox(accountId, mailboxId);
    await expect((db as unknown as Tx).transaction(async (tx) => insertOrganizerRequest(tx, {
      id: randomUUID(), accountId, mailboxId, kind: "screener.decide",
      payload: { address: "a correspondent" }, decidedAt: NOW,
    }))).rejects.toBeInstanceOf(MailboxErasedError);
    expect(await db.select({ id: organizerRequests.id }).from(organizerRequests)
      .where(eq(organizerRequests.mailboxId, mailboxId))).toHaveLength(0);
  });

  it("the ORGANIZER REQUEST is written for a live mailbox — the positive", async () => {
    const { accountId, mailboxId } = await seed();
    const row = await (db as unknown as Tx).transaction(async (tx) => insertOrganizerRequest(tx, {
      id: randomUUID(), accountId, mailboxId, kind: "screener.decide",
      payload: {}, decidedAt: NOW,
    }));
    expect(row.state).toBe("pending");
  });
});
