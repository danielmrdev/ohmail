import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, seedMailbox, seedMessage, req, FIXED_NOW } from "./helpers.js";

/**
 * POWER THROUGH MUST NOT READ THE PILE IT EXISTS TO CLEAR.
 *
 * `GET /views/power-through` answers one message and a count. It used to produce that answer
 * from a query with NO `limit`: every unread INBOX id for the account was ordered, sent to the
 * process, and then used for exactly two things — `rows[0]` for the message on screen and
 * `rows.length` for `remaining`. So the user with the most unread mail, who is the user this
 * feature is for, paid the most for every screen — and advancing repeated it: N ids, then N-1,
 * then N-2, one full transfer per message dismissed.
 *
 * A CORRECTNESS TEST CANNOT SEE THIS. The old code returned exactly the same three values, so
 * every assertion about `current`, `remaining` and `nextCursor` passes either way — which is why
 * `triage.test.ts` was green throughout. What distinguishes them is how many rows the driver
 * hands back, so that is what this measures: `deps.db` is wrapped in a counting proxy and the
 * largest single result set is asserted against the pile.
 *
 * THE MUTATION THAT MAKES THIS RED is deleting `.limit(2)` from the page query in
 * `packages/services/src/triage-service.ts#powerThrough`. Watched fail and restored.
 */
const app = createApp(apiRoutes);
const PILE = 40;

/** Wraps a db handle so every awaited `select()` result has its row count recorded. */
function countingDb<T extends object>(db: T): { db: T; sizes: number[] } {
  const sizes: number[] = [];
  const wrapBuilder = (builder: object): object =>
    new Proxy(builder, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "then" && typeof value === "function") {
          // Awaiting the builder is what runs the query: record what came back, pass it through.
          return (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
            (value as (...a: unknown[]) => unknown).call(
              target,
              (rows: unknown) => {
                if (Array.isArray(rows)) sizes.push(rows.length);
                return onOk(rows);
              },
              onErr,
            );
        }
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            const out = (value as (...a: unknown[]) => unknown).apply(target, args);
            // A chained builder method returns a builder; keep counting down the chain.
            return out !== null && typeof out === "object" ? wrapBuilder(out as object) : out;
          };
        }
        return value;
      },
    });

  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "select" && typeof value === "function") {
        return (...args: unknown[]) =>
          wrapBuilder((value as (...a: unknown[]) => unknown).apply(target, args) as object);
      }
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { db: proxy, sizes };
}

describe("GET /views/power-through is bounded by the screen, not by the pile", () => {
  it(`counts ${PILE} unread without any query handing back ${PILE} rows`, async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    for (let i = 0; i < PILE; i++) {
      await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX", unread: true });
    }

    // Wrapped AFTER seeding, so only the request's own reads are measured.
    const counting = countingDb(deps.db as object);
    const measured = { ...deps, db: counting.db, session: null, idempotency: null } as ApiDeps;

    const res = await app.handle(req("GET", "/views/power-through", { bearer: s.token }), measured);
    expect(res.status).toBe(200);
    const body = await res.json() as { current: unknown; remaining: number; nextCursor: string | null };

    // The answer is unchanged: the count is still the whole pile.
    expect(body.remaining).toBe(PILE);
    expect(body.current).not.toBeNull();
    expect(body.nextCursor).toBeTruthy();

    // …and producing it did not transfer the pile.
    const largest = Math.max(...counting.sizes);
    expect(
      largest,
      `largest result set was ${largest} rows for a ${PILE}-message pile (all sizes: ${counting.sizes.join(",")})`,
    ).toBeLessThan(PILE);
  });

  it("an empty pile answers nothing", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await app.handle(
      req("GET", "/views/power-through", { bearer: s.token }),
      { ...deps, session: null, idempotency: null },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ current: null, remaining: 0, nextCursor: null });
  });
});
