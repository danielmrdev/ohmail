import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql as sqlRaw } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, mailboxes, mailboxFolders, messageFailures, messages, MailboxErasedError,
} from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "../src/adapters/drizzle-repo.js";

/**
 * THE INGEST REPOSITORY DOES NOT RE-FILL AN ERASED MAILBOX.
 *
 * The stored message, the failure record and the folder cursor key their rows to `mailboxes`
 * alone: that key refuses the ACCOUNT sweep, which deletes the parent, and nothing at all for the
 * mailbox's own erasure, which leaves the row as its tombstone. Each asks `mailboxes.erased_at`
 * first — also the lock order this path holds. `.pg` for the last two cases, which drive both
 * orders across two connections. Mutations watched red, restored by `cmp`: the fence cut from
 * each writer in turn → that case red, the other two green, its row present afterwards.
 */
const PG_UP = await realPgAvailable();

const NOW = new Date("2026-09-16T09:30:00.000Z");
let owned: OwnedDb;
/** A SECOND handle, because an erasure is another host's request and not this pass's statement. */
let sweeper: OwnedDb;

beforeAll(async () => {
  if (!PG_UP) return;
  await runMigrations(PG_TEST_URL);
  owned = makeOwnedDb(PG_TEST_URL);
  sweeper = makeOwnedDb(PG_TEST_URL);
}, 120_000);

afterAll(async () => {
  await Promise.all([owned?.close(), sweeper?.close()]);
}, 60_000);

async function seeded(): Promise<{ accountId: string; mailboxId: string }> {
  const [a] = await owned.db.insert(accounts)
    .values({ name: `ingest-${randomUUID().slice(0, 8)}` }).returning();
  const [mb] = await owned.db.insert(mailboxes).values({
    accountId: a!.id, provider: "imap", address: `ing-${randomUUID().slice(0, 8)}@x.test`,
    status: "connected", organizerRole: "organizer",
  }).returning();
  return { accountId: a!.id, mailboxId: mb!.id };
}

/**
 * THE STAMP ALONE, never the real erasure — which writes `status = 'disabled'` in the same
 * transaction, and the worker's cycle refuses a disabled mailbox inside the writing transaction
 * already (`sync.ts#assertMailboxStillHere`). A case driving the real thing would be green with no
 * fence at all. `status` stays `connected` and every case reads it back, so the older refusal
 * cannot be what answered.
 */
const stampErased = async (mailboxId: string): Promise<void> => {
  await sweeper.db.update(mailboxes).set({ erasedAt: NOW }).where(eq(mailboxes.id, mailboxId));
};

const messageFor = (s: { accountId: string; mailboxId: string }) => ({ senderCheck: null,
  accountId: s.accountId, mailboxId: s.mailboxId,
  canonical: { messageIdHeader: `<${randomUUID()}@x.test>`, bodyHash: randomUUID() },
  dedupKey: randomUUID(), subject: "the roof", fromAddress: "them@x.test", date: NOW,
  nativeLocator: { folder: "INBOX", ref: "1:1" },
  flags: { no_ai: false, no_forward: false, no_kb: false, priority: false },
});

const failureFor = (s: { accountId: string }) => ({
  accountId: s.accountId, folder: "INBOX", uidValidity: "1", uid: 7,
  code: "mime_unparseable", version: "test", nextAttemptAt: null,
});

const CURSOR = { uidValidity: "1", uidNext: 2, highestModseq: "0" };

/** The state that could have answered instead of the fence. Read, never assumed. */
async function statusStillConnected(mailboxId: string): Promise<void> {
  const [mb] = await owned.db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
  expect(mb!.status, "the worker's disabled refusal could have answered this").toBe("connected");
}

describe.skipIf(!PG_UP)("the ingest repository does not re-fill an erased mailbox", () => {
  it("MESSAGE — an insert into an erased mailbox is refused and stores nothing", async () => {
    const s = await seeded();
    const repo = makeDrizzleRepo(owned.db);
    await stampErased(s.mailboxId);
    await expect(repo.insertMessage(messageFor(s))).rejects.toBeInstanceOf(MailboxErasedError);
    expect(await owned.db.select().from(messages).where(eq(messages.mailboxId, s.mailboxId)))
      .toHaveLength(0);
    await statusStillConnected(s.mailboxId);
  });

  it("MESSAGE — a carrier for ANOTHER mailbox answers nothing about this one", async () => {
    /* The hand-over that makes the fence free on the ingest path: a caller sending its own locked
       read of THIS mailbox in this transaction is what the door defers to. A carrier naming a
       different mailbox is not that — it would be a fence read of somebody else's row standing in
       for this write — so the door asks for itself, and the refusal is the proof. */
    const s = await seeded();
    const other = await seeded();
    const repo = makeDrizzleRepo(owned.db);
    await stampErased(s.mailboxId);
    await expect(repo.insertMessage({
      ...messageFor(s),
      mailboxMustBeLive: { mailboxId: other.mailboxId, answer: () => { /* never reached */ } },
    })).rejects.toBeInstanceOf(MailboxErasedError);
    expect(await owned.db.select().from(messages).where(eq(messages.mailboxId, s.mailboxId)))
      .toHaveLength(0);
    await statusStillConnected(s.mailboxId);
  });

  it("FAILURE RECORD — the quarantine row is refused too", async () => {
    const s = await seeded();
    const repo = makeDrizzleRepo(owned.db);
    await stampErased(s.mailboxId);
    await expect(repo.recordMessageFailure(s.mailboxId, failureFor(s)))
      .rejects.toBeInstanceOf(MailboxErasedError);
    expect(await owned.db.select().from(messageFailures)
      .where(eq(messageFailures.mailboxId, s.mailboxId))).toHaveLength(0);
    await statusStillConnected(s.mailboxId);
  });

  it("FOLDER CURSOR — the cycle's cursor is refused too", async () => {
    const s = await seeded();
    const repo = makeDrizzleRepo(owned.db);
    await stampErased(s.mailboxId);
    await expect(repo.upsertMailboxFolder(s.mailboxId, "INBOX", CURSOR))
      .rejects.toBeInstanceOf(MailboxErasedError);
    expect(await owned.db.select().from(mailboxFolders)
      .where(eq(mailboxFolders.mailboxId, s.mailboxId))).toHaveLength(0);
    await statusStillConnected(s.mailboxId);
  });

  it("all three still write to a LIVE mailbox — the refusal is not everything", async () => {
    const s = await seeded();
    const repo = makeDrizzleRepo(owned.db);
    await repo.insertMessage(messageFor(s));
    await repo.recordMessageFailure(s.mailboxId, failureFor(s));
    await repo.upsertMailboxFolder(s.mailboxId, "INBOX", CURSOR);
    expect(await owned.db.select().from(messages).where(eq(messages.mailboxId, s.mailboxId)))
      .toHaveLength(1);
    expect(await owned.db.select().from(messageFailures)
      .where(eq(messageFailures.mailboxId, s.mailboxId))).toHaveLength(1);
    expect(await owned.db.select().from(mailboxFolders)
      .where(eq(mailboxFolders.mailboxId, s.mailboxId))).toHaveLength(1);
  });

  it("THE WINDOW — an erasure that commits after the transaction OPENED is still seen", async () => {
    /**
     * The whole reason the question is asked at the write door rather than at the head of a pass:
     * the pass plans from reads taken outside every transaction, so a removal lands in the gap.
     * Here the transaction is already open when the stamp commits on the OTHER connection, and
     * the write inside it is refused all the same — the fence reads the row `FOR SHARE`, which
     * sees the latest committed value rather than the snapshot this transaction started with.
     */
    const s = await seeded();
    const repo = makeDrizzleRepo(owned.db);
    const refused = await repo.transaction(async (tx) => {
      // Nothing of this mailbox is held yet, so the stamp commits rather than waiting — which is
      // exactly the interleaving the next case proves cannot happen once the fence has run.
      await stampErased(s.mailboxId);
      await tx.insertMessage(messageFor(s));
      return null;
    }).then(() => null, (e: unknown) => e);

    expect(refused, "the erasure landed mid-transaction and the write went in")
      .toBeInstanceOf(MailboxErasedError);
    expect(await owned.db.select().from(messages).where(eq(messages.mailboxId, s.mailboxId)))
      .toHaveLength(0);
    await statusStillConnected(s.mailboxId);
  });

  it("THE OTHER ORDER — once the fence has read the row, the erasure WAITS for the commit", async () => {
    /**
     * What makes the window above closed rather than merely narrow, and the reason this file is
     * `.pg`: the fence reads `FOR SHARE`, so an erasure arriving AFTER it blocks on the row until
     * this transaction ends rather than slipping between the question and the write. Proven by
     * giving the erasing statement its own 300 ms `lock_timeout` and watching it TIME OUT — with
     * no lock the update returns at once and this case is green for a fence that took nothing.
     * The bound is its own because the pool's 5 s one turned the first draft into a wait.
     */
    const s = await seeded();
    const repo = makeDrizzleRepo(owned.db);
    let blocked: unknown = "the erasure was not attempted";
    await repo.transaction(async (tx) => {
      // The fence runs inside this call and leaves the share lock held for the transaction.
      await tx.upsertMailboxFolder(s.mailboxId, "INBOX", CURSOR);
      blocked = await sweeper.db.transaction(async (sw) => {
        await sw.execute(sqlRaw`set local lock_timeout = '300ms'`);
        await sw.update(mailboxes).set({ erasedAt: NOW }).where(eq(mailboxes.id, s.mailboxId));
        return null;
      }).then(() => null, (e: unknown) => e);
    });

    expect(blocked, "the erasure did NOT wait for the writer's share lock").not.toBeNull();
    expect(String((blocked as Error).message)).toMatch(/lock timeout|canceling statement/i);
    // …and the writer's own row committed, because it held the row throughout.
    expect(await owned.db.select().from(mailboxFolders)
      .where(eq(mailboxFolders.mailboxId, s.mailboxId))).toHaveLength(1);
  });
});
