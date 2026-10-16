import { describe, it, expect } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { dialectOf, carryDialect } from "@trafficflow/db/dialect";
import { makeDrizzleRepo } from "../../src/adapters/drizzle-repo.js";

/**
 * A TRANSACTION SPEAKS THE SAME DIALECT AS THE HANDLE THAT OPENED IT.
 *
 * The dialect is a brand the connection factory stamps on the handle it returns. A transaction is
 * a DIFFERENT object, made by the query builder, and it inherits nothing — so a repository built
 * around a transaction has no brand to read and every construct that goes through the seam throws.
 *
 * That is not a hypothetical: the backlog pass takes its lock and reads its page INSIDE
 * `repo.transaction(…)`, and so does the thread merge on the ingest path. Both go through the
 * seam. Neither is covered by a unit test that uses a fake, because a fake repository never opens
 * a transaction at all — which is exactly how this reached a review rather than a red suite.
 */
describe("the seam inside a transaction", () => {
  it("resolves the dialect for a repository the transaction made", async () => {
    const db = await makeTestDb();
    const repo = makeDrizzleRepo(db as never);

    // The handle itself is branded — that much always worked.
    expect(dialectOf(db)).toBe("pg");

    // And the transaction's repository must reach a dialect too. Before the fix this threw
    // `this database handle carries no dialect brand` from the first seam call inside the block.
    const seen = await repo.transaction(async (tx) => {
      await tx.lockAccountThreadStructure("11111111-1111-4111-8111-111111111111");
      return "took the lock";
    });
    expect(seen).toBe("took the lock");
  });

  it("reads a page under a row lock inside a transaction, which is the backlog pass's shape", async () => {
    const db = await makeTestDb();
    const repo = makeDrizzleRepo(db as never);
    const rows = await repo.transaction(async (tx) =>
      tx.listThreadBacklog("11111111-1111-4111-8111-111111111111", 10));
    expect(rows).toEqual([]);
  });

  it("carries the dialect through a transaction opened FROM a transaction", async () => {
    // The previous version of this case was titled "even nested" and opened ONE transaction, so it
    // passed against a fix that resolved the dialect from each child's own handle — which is
    // exactly the shape that breaks one level down, because a transaction's handle is unbranded.
    // The repository a transaction hands you can open another; this opens it.
    const db = await makeTestDb();
    const repo = makeDrizzleRepo(db as never);
    const rows = await repo.transaction(async (outer) =>
      outer.transaction(async (inner) =>
        inner.listThreadBacklog("22222222-2222-4222-8222-222222222222", 1)));
    expect(rows).toEqual([]);
  });

  it("PREMISE: a branded handle's transaction is branded, which is why the shape below works", async () => {
    /* THE CASE THAT ANNOUNCES THE SWITCH, and the reason the two cases this replaced are gone.
     *
     * They asserted that a repository built straight from a driver transaction REFUSES — which was
     * true, and cost two production paths before it was measured. It is no longer true through this
     * route: `brandDialect` now wraps a handle's `transaction`, so the callback is handed a branded
     * object and a savepoint on that one is branded too. The refusal did not go away; the way of
     * REACHING it through a branded handle did, and a case whose contrary state is unreachable
     * cannot be watched fail and reads to the next person as a guarantee.
     *
     * So this is the premise, and it is the thing that must go red if the inheritance is ever
     * removed — at which point the shape below stops working and the two deleted cases become the
     * right ones again. The refusal itself is asserted one case down, on a handle no factory
     * branded, which is the state that IS still reachable.
     */
    const db = await makeTestDb();
    expect(await db.transaction(async (tx) => dialectOf(tx))).toBe("pg");
  });

  it("composes the worker's shape — a repository built around the driver's transaction — with no carry", async () => {
    // FIVE PLACES open a transaction on the driver handle and build a repository around the
    // transaction object themselves: the leadership fence, the retro pass, the Ohbox tidy, the
    // workflow step and the send service's routing writes. None goes through `repo.transaction`,
    // so none of them got the carry that method does internally — and all five now inherit it.
    const db = await makeTestDb();
    const account = "11111111-1111-4111-8111-111111111111";

    const bare = await db.transaction(async (tx) => {
      const repo = makeDrizzleRepo(tx as never);
      await repo.lockAccountThreadStructure(account);
      return "took the lock";
    });
    expect(bare).toBe("took the lock");

    // …and the explicit carry still works, so the eight sites that predate the inheritance are
    // belt-and-braces rather than newly wrong.
    const carried = await db.transaction(async (tx) => {
      const repo = makeDrizzleRepo(carryDialect(db, tx) as never);
      expect(dialectOf(tx)).toBe("pg");
      await repo.lockAccountThreadStructure(account);
      return "took the lock";
    });
    expect(carried).toBe("took the lock");
  });

  it("still refuses a handle NO FACTORY BRANDED, which is the state that remains reachable", async () => {
    /* WHERE THE LINE ACTUALLY IS, stated so nobody assumes it moved further than it did.
     *
     * Refusing in the constructor was tried and reverted on measurement: hundreds of test files build a
     * handle with a bare `drizzle(sql, { schema })` and never brand it, and hundreds of cases failed at
     * construction — every one a harness rather than a caller, since the production factories all
     * brand. So building succeeds and the first dialect-dependent statement refuses, and both
     * halves are asserted here.
     *
     * The handle is a bare object on purpose: it needs no store, because the refusal happens while
     * the statement is being COMPOSED, before anything is sent anywhere. That is also what makes
     * this case independent of the inheritance above — there is no transaction in it to inherit
     * from.
     */
    const repo = makeDrizzleRepo({} as never);
    expect(typeof repo, "an unbranded handle still yields an object").toBe("object");
    await expect(repo.lockAccountThreadStructure("11111111-1111-4111-8111-111111111111"))
      .rejects.toThrow(/carries no dialect brand/);
  });
});
