import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PgSelectQueryBuilderBase } from "drizzle-orm/pg-core";
import { makeTestDb } from "../src/testing.js";
import { accounts } from "../src/schema-mail.js";
import { dialect } from "../src/dialect/index.js";
import { AccountErasedError, fenceErased, fencedAccountWrite } from "../src/erasure-fence.js";
import type { Tx } from "../src/change-log.js";

/**
 * A FENCED TRANSACTION READS ITS ACCOUNT ROW ONCE (RESCUE-READS-THE-ACCOUNT-ROW-TWICE). The opener's
 * read holds the row FOR SHARE until commit, so a second shared ask for the same account inside the
 * branded transaction is answered by that hold. A stronger lock, an unbranded transaction and
 * another account are each read again (the controls), and an erased account is still refused.
 */
afterEach(() => { vi.restoreAllMocks(); });

async function accountReads(run: () => Promise<unknown>): Promise<number> {
  const lockFor = PgSelectQueryBuilderBase.prototype.for;
  let reads = 0;
  vi.spyOn(PgSelectQueryBuilderBase.prototype, "for").mockImplementation(function (this: unknown, ...args: unknown[]) {
    const out = (lockFor as (...a: unknown[]) => { toSQL(): { sql: string } }).apply(this, args);
    if (/from "accounts"/.test(out.toSQL().sql)) reads++;
    return out as never;
  });
  await run();
  vi.restoreAllMocks();
  return reads;
}

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "fence-once" });
  return { db: db as unknown as Tx, accountId };
}

describe("the erasure fence inside a transaction already fenced for the account", () => {
  it("a second shared ask reads nothing more", async () => {
    const w = await world();
    expect(await accountReads(() => fencedAccountWrite(w.db, { accountId: w.accountId }, async (tx) => {
      await fenceErased(tx, dialect(tx), { accountId: w.accountId });
      await fenceErased(tx, dialect(tx), { accountId: w.accountId, lock: "key share" });
    }))).toBe(1);
  });

  it("an update-strength ask, an unbranded transaction and another account are read again (the controls)", async () => {
    const w = await world();
    expect(await accountReads(() => fencedAccountWrite(w.db, { accountId: w.accountId }, async (tx) => {
      await fenceErased(tx, dialect(tx), { accountId: w.accountId, lock: "update" });
    }))).toBe(2);
    const other = randomUUID();
    expect(await accountReads(() => fencedAccountWrite(w.db, { accountId: w.accountId }, async (tx) => {
      await fenceErased(tx, dialect(tx), { accountId: other });
    }))).toBe(2);
    const plain = w.db as unknown as { transaction: <R>(f: (t: Tx) => Promise<R>) => Promise<R> };
    expect(await accountReads(() => plain.transaction(async (tx) => {
      await fenceErased(tx, dialect(w.db), { accountId: w.accountId });
      await fenceErased(tx, dialect(w.db), { accountId: w.accountId });
    }))).toBe(2);
  });

  it("an erased account is still refused at the opener", async () => {
    const w = await world();
    await (w.db as unknown as Awaited<ReturnType<typeof makeTestDb>>).update(accounts)
      .set({ erasedAt: new Date("2026-10-06T00:00:00Z") }).where(eq(accounts.id, w.accountId));
    const verdict = await fencedAccountWrite(w.db, { accountId: w.accountId }, async () => "wrote")
      .catch((e: unknown) => (e instanceof AccountErasedError ? "refused" : "other"));
    expect(verdict).toBe("refused");
  });
});
