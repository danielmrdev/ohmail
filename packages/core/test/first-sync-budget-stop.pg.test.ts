import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, mailboxes, mailboxFolders, MailboxErasedError } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "../src/adapters/drizzle-repo.js";

/**
 * THE BUDGET STOP, IN THE TWO COLUMNS THAT HOLD IT (mail 0115).
 *
 * `first-sync-stop-persists.test.ts` proves the restart end to end over a Map; this file is the
 * half a Map cannot answer — that the pair round-trips through real columns, that at most one row
 * of a mailbox carries it, that the stopped folder does not need a row first (the pass took
 * nothing there, so it may have none), and that a cursor write leaves a stop where it is.
 *
 * Mutations watched red and restored by `cmp`: the writer's clear removed → the two-stops case;
 * the read's both-columns test reduced to `budgetStopUid != null` → the half-written case; the
 * fence removed from the writer → the erased case.
 */
const PG_UP = await realPgAvailable();

let owned: OwnedDb;

beforeAll(async () => {
  if (!PG_UP) return;
  await runMigrations(PG_TEST_URL);
  owned = makeOwnedDb(PG_TEST_URL);
}, 120_000);

afterAll(async () => { await owned?.close(); }, 60_000);

async function seeded(): Promise<{ accountId: string; mailboxId: string }> {
  const [a] = await owned.db.insert(accounts)
    .values({ name: `stop-${randomUUID().slice(0, 8)}` }).returning();
  const [mb] = await owned.db.insert(mailboxes).values({
    accountId: a!.id, provider: "imap", address: `stop-${randomUUID().slice(0, 8)}@x.test`,
    status: "connected", organizerRole: "organizer",
  }).returning();
  return { accountId: a!.id, mailboxId: mb!.id };
}

const stop = (folder: string, uid: number, uidValidity = "100") => ({ folder, uidValidity, uid });

describe.skipIf(!PG_UP)("the budget stop round-trips through mailbox_folders", () => {
  it("is written on the stopped folder's own row, which the pass need not have created", async () => {
    const s = await seeded();
    const repo = makeDrizzleRepo(owned.db);
    // INBOX drained; `cust/001` is where the budget ran out, and nothing has ever written a
    // cursor for it — the pass took nothing there.
    await repo.upsertMailboxFolder(s.mailboxId, "INBOX", { uidValidity: "100", uidNext: 21, highestModseq: "0" });
    await repo.setMailboxBudgetStop(s.mailboxId, stop("cust/001", 1));

    const rows = await repo.getMailboxFolders(s.mailboxId);
    expect(rows.find((r) => r.folder === "INBOX")?.budgetStop).toBeUndefined();
    expect(rows.find((r) => r.folder === "cust/001")?.budgetStop)
      .toEqual({ uidValidity: "100", uid: 1 });
    // The row it created carries NO cursor — the cold state, which is what a folder with no row
    // reads as. A stop may never advance a cursor over mail the pass did not take.
    const [created] = await owned.db.select().from(mailboxFolders)
      .where(eq(mailboxFolders.folder, "cust/001"));
    expect(created?.uidvalidity).toBeNull();
    expect(created?.uidnext).toBeNull();
    expect(created?.highestmodseq).toBeNull();
  });

  it("at most one row of a mailbox carries it, and null clears it", async () => {
    const s = await seeded();
    const repo = makeDrizzleRepo(owned.db);
    await repo.setMailboxBudgetStop(s.mailboxId, stop("cust/001", 1));
    await repo.setMailboxBudgetStop(s.mailboxId, stop("cust/044", 9, "101"));

    const carried = (await repo.getMailboxFolders(s.mailboxId)).filter((r) => r.budgetStop !== undefined);
    expect(carried.map((r) => r.folder)).toEqual(["cust/044"]);
    expect(carried[0]?.budgetStop).toEqual({ uidValidity: "101", uid: 9 });

    await repo.setMailboxBudgetStop(s.mailboxId, null);
    expect((await repo.getMailboxFolders(s.mailboxId)).filter((r) => r.budgetStop !== undefined))
      .toEqual([]);
  });

  it("a cursor write leaves the stop alone — they are two facts on one row", async () => {
    const s = await seeded();
    const repo = makeDrizzleRepo(owned.db);
    await repo.setMailboxBudgetStop(s.mailboxId, stop("Archive", 912, "77"));
    await repo.upsertMailboxFolder(s.mailboxId, "Archive", {
      uidValidity: "77", uidNext: 4, highestModseq: "0", serverExists: 3,
    });
    const [row] = (await repo.getMailboxFolders(s.mailboxId)).filter((r) => r.folder === "Archive");
    expect(row?.budgetStop).toEqual({ uidValidity: "77", uid: 912 });
    expect(row?.uidNext).toBe(4);
    expect(row?.serverExists).toBe(3);
  });

  it("a half-written pair is not presented as a fact", async () => {
    const s = await seeded();
    const repo = makeDrizzleRepo(owned.db);
    await repo.setMailboxBudgetStop(s.mailboxId, stop("cust/001", 1));
    // The epoch alone is lost — the state a hand-edit or a partial restore leaves. A uid without
    // the epoch that issued it names a different message, so the read drops both.
    await owned.db.update(mailboxFolders).set({ budgetStopUidvalidity: null })
      .where(eq(mailboxFolders.mailboxId, s.mailboxId));
    expect((await repo.getMailboxFolders(s.mailboxId)).filter((r) => r.budgetStop !== undefined))
      .toEqual([]);
  });

  it("an erased mailbox refuses the write, on the cursor upsert's own fence", async () => {
    const s = await seeded();
    const repo = makeDrizzleRepo(owned.db);
    await owned.db.update(mailboxes).set({ erasedAt: new Date("2026-09-17T00:00:00.000Z") })
      .where(eq(mailboxes.id, s.mailboxId));
    await expect(repo.setMailboxBudgetStop(s.mailboxId, stop("cust/001", 1)))
      .rejects.toBeInstanceOf(MailboxErasedError);
    expect((await repo.getMailboxFolders(s.mailboxId)).filter((r) => r.budgetStop !== undefined))
      .toEqual([]);
  });
});
