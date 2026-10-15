import { describe, it, expect } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxes, messages, folderState } from "@trafficflow/db";
import { StaticKeyProvider } from "@trafficflow/core";
import { makeMailboxService, type ServiceContext } from "@trafficflow/services";

/**
 * ═══ `MailboxDTO.pendingMoves` IS ONE NUMBER FOR FOUR SITUATIONS ════════════════════════════
 *
 * `pendingMoves` counts every outstanding filing of ours, and the client has nothing else to
 * read — so "the reconciler will file this on its next turn" and "the server refused this five
 * times and the next attempt is six hours out" arrive as the same `1`.
 *
 * The two are not even the same set of work. The strip's count filters `pending` ∧
 * `last_set_by = 'us'` ∧ `desired <> observed`; the reconciler's own queue
 * (`listPendingFolderStates`) filters `pending` ∧ `dueNow(next_attempt_at)`. A DEFERRED row is
 * therefore IN the count and ABSENT from the queue — nothing is going to touch it until its
 * `next_attempt_at` — which is precisely the shape a person reads as "stuck".
 *
 * `filing` splits that number by the operand that decides: `due` is work the next turn will
 * pick up, `deferred` is work that is asleep, and the three timestamps say for how long and
 * why. `asOf` is the read's own instant, so a client can say when it last looked instead of
 * running a clock over a number that has not been re-fetched.
 *
 * ── WHY `updated_at` IS THE AGE AND `created_at` IS NOT ─────────────────────────────────────
 *
 * `folder_state` is keyed by message and UPSERTED: one row per message, reused every time that
 * message is filed again. A `created_at` would therefore date the message's FIRST filing —
 * months ago for a message re-filed today — and "not filed for 47 days" over a decision made a
 * second ago is a worse lie than the one this replaces.
 *
 * `updated_at` is the honest operand and the code already treats it as one: the intent writers
 * stamp it (`upsertDesired`, `upsertFolderState`), `deferFolderReconcile` deliberately does NOT
 * ("a refusal is not a re-filing" — it is this row's place in the oldest-first queue), and
 * `listPendingFolderStates` orders by it. So `min(updated_at)` over the outstanding rows is the
 * queue's own head, measured the way the queue measures it.
 *
 * PGlite deliberately: this is about which rows one aggregate counts and what it reports about
 * them, not about concurrency.
 */

const NOW = new Date("2026-09-08T12:00:00.000Z");
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 1);
const svc = makeMailboxService({ keyProvider: KP });

type Db = Awaited<ReturnType<typeof makeTestDb>>;

const ctxFor = (db: Db, accountId: string): ServiceContext =>
  ({ db, accountId, userId: null, now: () => NOW, requestId: "r" });

async function seed(db: Db): Promise<{ accountId: string; mailboxId: string }> {
  const [a] = await db.insert(accounts).values({ name: "filing-report" }).returning();
  const [mb] = await db.insert(mailboxes).values({
    accountId: a!.id, provider: "imap", address: "person@example.test",
  }).returning();
  return { accountId: a!.id, mailboxId: mb!.id };
}

/** One outstanding filing, with the schedule columns the reconciler writes on a refusal. */
async function seedFiling(
  db: Db,
  ids: { accountId: string; mailboxId: string },
  n: number,
  row: {
    updatedAt: Date;
    attempts?: number;
    nextAttemptAt?: Date | null;
    lastErrorClass?: string | null;
    by?: "us" | "external";
    desired?: string;
    observed?: string;
    status?: "pending" | "reconciled";
  },
): Promise<void> {
  const [m] = await db.insert(messages).values({
    accountId: ids.accountId,
    mailboxId: ids.mailboxId,
    dedupKey: `mid:<fr-${n}@example.test>`,
    messageIdHeader: `<fr-${n}@example.test>`,
    fromAddress: "stranger@example.test",
    subject: `s${n}`,
    date: NOW,
    bodyHash: `fr-hash-${n}`,
  }).returning();
  await db.insert(folderState).values({
    messageId: m!.id,
    desiredFolder: row.desired ?? "ohmail/News",
    observedFolder: row.observed ?? "INBOX",
    reconcileStatus: row.status ?? "pending",
    lastSetBy: row.by ?? "us",
    updatedAt: row.updatedAt,
    attempts: row.attempts ?? 0,
    nextAttemptAt: row.nextAttemptAt ?? null,
    ...(row.lastErrorClass !== undefined ? { lastErrorClass: row.lastErrorClass } : {}),
  });
}

const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const minutesAhead = (n: number) => new Date(NOW.getTime() + n * 60_000);

describe("MailboxDTO.filing — why an outstanding filing is outstanding", () => {
  it("is present with zeros on a healthy mailbox — absent would mean 'cannot tell'", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(dto.filing).toBeTruthy();
    expect(dto.filing?.due).toBe(0);
    expect(dto.filing?.deferred).toBe(0);
    expect(dto.filing?.oldestPendingAt).toBeNull();
    expect(dto.filing?.nextAttemptAt).toBeNull();
    expect(dto.filing?.attempts).toBe(0);
    expect(dto.filing?.lastRefusalClass).toBeNull();
    // The read's own instant, so the client can state when it last looked.
    expect(dto.filing?.asOf).toBe(NOW.toISOString());
  });

  it("counts a DUE row as due — NULL `next_attempt_at` means due now", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await seedFiling(db, ids, 1, { updatedAt: minutesAgo(1) });
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(dto.filing?.due).toBe(1);
    expect(dto.filing?.deferred).toBe(0);
    expect(dto.filing?.oldestPendingAt).toBe(minutesAgo(1).toISOString());
    // The legacy total keeps counting BOTH, byte for byte — a client that reads only it behaves
    // exactly as it did before this field existed.
    expect(dto.pendingMoves).toBe(1);
  });

  it("counts a DEFERRED row as deferred — it is not in the reconciler's queue", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await seedFiling(db, ids, 1, {
      updatedAt: minutesAgo(9), attempts: 2,
      nextAttemptAt: minutesAhead(6), lastErrorClass: "no_such_folder",
    });
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(dto.filing?.due, "a deferred row was reported as work in progress").toBe(0);
    expect(dto.filing?.deferred).toBe(1);
    expect(dto.filing?.nextAttemptAt).toBe(minutesAhead(6).toISOString());
    expect(dto.filing?.attempts).toBe(2);
    expect(dto.filing?.lastRefusalClass).toBe("no_such_folder");
    expect(dto.pendingMoves).toBe(1);
  });

  it("a PAST `next_attempt_at` is due again — the deferral expired", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await seedFiling(db, ids, 1, {
      updatedAt: minutesAgo(30), attempts: 3, nextAttemptAt: minutesAgo(2),
      lastErrorClass: "refused",
    });
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(dto.filing?.due).toBe(1);
    expect(dto.filing?.deferred).toBe(0);
    // The class and the count STAY — they are what the row has been through, not a schedule.
    expect(dto.filing?.attempts).toBe(3);
    expect(dto.filing?.lastRefusalClass).toBe("refused");
  });

  it("reports the OLDEST outstanding filing and the SOONEST next attempt", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await seedFiling(db, ids, 1, { updatedAt: minutesAgo(3), attempts: 1, nextAttemptAt: minutesAhead(20) });
    await seedFiling(db, ids, 2, { updatedAt: minutesAgo(14), attempts: 4, nextAttemptAt: minutesAhead(5) });
    await seedFiling(db, ids, 3, { updatedAt: minutesAgo(8) });
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(dto.filing?.due).toBe(1);
    expect(dto.filing?.deferred).toBe(2);
    expect(dto.filing?.oldestPendingAt).toBe(minutesAgo(14).toISOString());
    // MIN, not max: the soonest is when something will next happen, which is what a sentence
    // promising a retry has to name.
    expect(dto.filing?.nextAttemptAt).toBe(minutesAhead(5).toISOString());
    // MAX: "this one has been refused four times" is the row that decides whether it is stuck.
    expect(dto.filing?.attempts).toBe(4);
    expect(dto.pendingMoves).toBe(3);
  });

  it("EXCLUDES the same three shapes the count excludes — one set, both fields", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    // The user tidying in their own client: adopted, never pushed.
    await seedFiling(db, ids, 1, { updatedAt: minutesAgo(20), by: "external" });
    // Folders already agree: a no-op the reconciler retires without touching IMAP.
    await seedFiling(db, ids, 2, { updatedAt: minutesAgo(20), desired: "INBOX", observed: "INBOX" });
    // Converged.
    await seedFiling(db, ids, 3, { updatedAt: minutesAgo(20), status: "reconciled" });
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(dto.pendingMoves).toBe(0);
    expect(dto.filing?.due).toBe(0);
    expect(dto.filing?.deferred).toBe(0);
    // And no age from a row that is not outstanding — an `oldestPendingAt` over an excluded row
    // would report a wait nobody is waiting.
    expect(dto.filing?.oldestPendingAt).toBeNull();
  });

  it("is scoped to THIS mailbox — another mailbox's backlog is not this one's", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    const [other] = await db.insert(mailboxes).values({
      accountId: ids.accountId, provider: "imap", address: "second@example.test",
    }).returning();
    await seedFiling(db, { ...ids, mailboxId: other!.id }, 1, { updatedAt: minutesAgo(40) });
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(dto.filing?.due).toBe(0);
    expect(dto.filing?.oldestPendingAt).toBeNull();
  });
});

/**
 * THE STUCK ROWS ALONE. The stuck sentence read the aggregate: a seconds-old move
 * beside a 62-minute one read "2 messages … 62 minutes", and a row nothing refused took the class
 * of another row. `stuck`, `stuckSince` and `stuckRefusalClass` are computed over the rows past
 * the rule (`filingStuck`: five minutes waited, or two refusals) and nothing else.
 */
describe("MailboxDTO.filing — the stuck rows are counted apart", () => {
  it("counts the old row and not the seconds-old one, under the old row's own clock", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await seedFiling(db, ids, 1, { updatedAt: minutesAgo(62) });
    await seedFiling(db, ids, 2, { updatedAt: new Date(NOW.getTime() - 30_000) });
    const f = (await svc.get(ctxFor(db, ids.accountId), ids.mailboxId)).filing!;
    expect(f.due).toBe(2);
    expect(f.stuck, "the seconds-old move was counted as stuck").toBe(1);
    expect(f.stuckSince).toBe(minutesAgo(62).toISOString());
    expect(f.stuckRefusalClass, "a row nothing refused was given a class").toBeNull();
  });

  it("a row refused twice is stuck at any age, and carries its own class", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await seedFiling(db, ids, 1, {
      updatedAt: minutesAgo(3), attempts: 2, nextAttemptAt: minutesAhead(10), lastErrorClass: "over_quota",
    });
    await seedFiling(db, ids, 2, { updatedAt: minutesAgo(4) });
    const f = (await svc.get(ctxFor(db, ids.accountId), ids.mailboxId)).filing!;
    expect(f.stuck).toBe(1);
    expect(f.stuckSince).toBe(minutesAgo(3).toISOString());
    expect(f.stuckRefusalClass).toBe("over_quota");
  });

  it("a young refused row does not lend its class to a stuck row nothing refused", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await seedFiling(db, ids, 1, { updatedAt: minutesAgo(70) });
    await seedFiling(db, ids, 2, {
      updatedAt: minutesAgo(1), attempts: 1, nextAttemptAt: minutesAhead(4), lastErrorClass: "read_only",
    });
    const f = (await svc.get(ctxFor(db, ids.accountId), ids.mailboxId)).filing!;
    expect(f.lastRefusalClass, "the precondition: the aggregate carries the young row's class").toBe("read_only");
    expect(f.stuck).toBe(1);
    expect(f.stuckRefusalClass, "the stuck row borrowed another row's reason").toBeNull();
  });

  it("CONTROL — five minutes is the boundary, and a reconciled or external row is never stuck", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await seedFiling(db, ids, 1, { updatedAt: minutesAgo(5) });
    await seedFiling(db, ids, 2, { updatedAt: new Date(NOW.getTime() - 299_000) });
    await seedFiling(db, ids, 3, { updatedAt: minutesAgo(90), status: "reconciled" });
    await seedFiling(db, ids, 4, { updatedAt: minutesAgo(90), by: "external" });
    const f = (await svc.get(ctxFor(db, ids.accountId), ids.mailboxId)).filing!;
    expect(f.stuck).toBe(1);
    expect(f.stuckSince).toBe(minutesAgo(5).toISOString());
  });
});
