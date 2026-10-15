import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { accounts, mailboxes } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "../src/adapters/drizzle-repo.js";

/**
 * THE BUDGET STOP IS WRITTEN AND READ BY WHICHEVER STORE THIS RUN OPENED (mail 0115).
 *
 * The phone's standalone install composes the worker's own sync cycle over the DEVICE store, so
 * the two statements this fact needs — an `is not null`-filtered clear and an upsert on
 * `(mailbox_id, folder)` — run there as well as on the server. `sqlite-baseline.test.ts` proves
 * the device store HAS the columns; nothing proved anything could write them, and a migration
 * carried to a store no code exercises is a column that exists and is never used.
 *
 * Table-driven on `makeTestDb`, so one file answers the same question on both runs — the second
 * one is `pnpm test:sqlite`, where this file is registered by name.
 */

async function seeded(db: Awaited<ReturnType<typeof makeTestDb>>) {
  const [a] = await db.insert(accounts).values({ name: `stop-${randomUUID().slice(0, 8)}` }).returning();
  const [mb] = await db.insert(mailboxes).values({
    accountId: a!.id, provider: "imap", address: `stop-${randomUUID().slice(0, 8)}@x.test`,
    status: "connected", organizerRole: "organizer",
  }).returning();
  return { db, repo: makeDrizzleRepo(db), mailboxId: mb!.id };
}

describe("the budget stop on whichever store this is", () => {
  it("writes the pair on a folder with no cursor row, and reads it back whole", async () => {
    const s = await seeded(await makeTestDb());
    await s.repo.setMailboxBudgetStop(s.mailboxId, { folder: "cust/001", uidValidity: "100", uid: 1 });
    const rows = await s.repo.getMailboxFolders(s.mailboxId);
    expect(rows.map((r) => r.folder)).toEqual(["cust/001"]);
    expect(rows[0]?.budgetStop).toEqual({ uidValidity: "100", uid: 1 });
  });

  it("moves the stop rather than adding one — the clear and the set are one call", async () => {
    const s = await seeded(await makeTestDb());
    await s.repo.setMailboxBudgetStop(s.mailboxId, { folder: "cust/001", uidValidity: "100", uid: 1 });
    await s.repo.setMailboxBudgetStop(s.mailboxId, { folder: "cust/044", uidValidity: "100", uid: 9 });
    const carried = (await s.repo.getMailboxFolders(s.mailboxId))
      .filter((r) => r.budgetStop !== undefined);
    expect(carried.map((r) => r.folder)).toEqual(["cust/044"]);
  });

  it("a completed pass clears it, and a cursor write does not bring it back", async () => {
    const s = await seeded(await makeTestDb());
    await s.repo.setMailboxBudgetStop(s.mailboxId, { folder: "INBOX", uidValidity: "100", uid: 4 });
    await s.repo.setMailboxBudgetStop(s.mailboxId, null);
    await s.repo.upsertMailboxFolder(s.mailboxId, "INBOX", {
      uidValidity: "100", uidNext: 9, highestModseq: "0",
    });
    const rows = await s.repo.getMailboxFolders(s.mailboxId);
    expect(rows.map((r) => r.budgetStop)).toEqual([undefined]);
    expect(rows[0]?.uidNext).toBe(9);
  });

  it("several folders in one write: new rows inserted, a stored count kept where the pass saw none", async () => {
    const s = await seeded(await makeTestDb());
    await s.repo.upsertMailboxFolders(s.mailboxId, [
      { folder: "INBOX", cursor: { uidValidity: "100", uidNext: 9, highestModseq: "3", serverExists: 8 } },
      { folder: "Archive", cursor: { uidValidity: "100", uidNext: 4, highestModseq: "0", serverExists: 3 } },
    ]);
    await s.repo.setMailboxBudgetStop(s.mailboxId, { folder: "Archive", uidValidity: "100", uid: 2 });
    await s.repo.upsertMailboxFolders(s.mailboxId, [
      { folder: "INBOX", cursor: { uidValidity: "100", uidNext: 12, highestModseq: "5" } },
      { folder: "Archive", cursor: { uidValidity: "100", uidNext: 4, highestModseq: "0", serverExists: 5 } },
      { folder: "Sent", cursor: { uidValidity: "7", uidNext: 2, highestModseq: "0" } },
    ]);
    const rows = new Map((await s.repo.getMailboxFolders(s.mailboxId)).map((r) => [r.folder, r]));
    expect(rows.get("INBOX")).toMatchObject({ uidNext: 12, highestModseq: "5", serverExists: 8 });
    expect(rows.get("Archive")).toMatchObject({ uidNext: 4, serverExists: 5, budgetStop: { uidValidity: "100", uid: 2 } });
    expect(rows.get("Sent")).toMatchObject({ uidValidity: "7", uidNext: 2 });
    expect(rows.get("Sent")?.serverExists).toBeUndefined();
  });
});
