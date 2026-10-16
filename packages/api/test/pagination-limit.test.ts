import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { clampLimit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "@trafficflow/services";
import { makeDeps, seedSession, seedMailbox, seedMessage, seedBody, req, FIXED_NOW } from "./helpers.js";

/**
 * THE PAGE CEILING IS TOTAL — `?limit=` is a caller-chosen double, not a caller-chosen integer.
 *
 * Every paginated read builds its ceiling from `Number(url.searchParams.get("limit"))`, so the
 * value that reaches `clampLimit` is whatever `Number()` returns for an arbitrary string. The
 * arithmetic clamp this replaced was correct for every NUMBER and wrong for the two doubles that
 * are not numbers in that sense:
 *
 *  · `NaN` (`?limit=abc`) and `-Infinity` (`?limit=-1e999`) survived the clamp, and **drizzle
 *    omits the `limit` clause entirely for a falsy value** — so the query ran with NO CEILING
 *    over the whole account, and `rows.slice(0, NaN)` then returned a page of nothing. Maximum
 *    work, zero result, repeatable. On `GET /messages/bodies` the rows fetched are full message
 *    BODIES and the `BODIES_BYTE_BUDGET` that exists to bound that response is evaluated inside
 *    the empty loop, so it never fires.
 *  · `1.5` and `Infinity` reached Postgres as a `bigint` parameter and raised
 *    `invalid input syntax for type bigint` — a 500 for a plainly bad request.
 *
 * THE MUTATION THAT MAKES THESE RED is restoring the arithmetic clamp in
 * `packages/services/src/pagination.ts`:
 *   `return Math.min(Math.max(1, limit ?? DEFAULT_PAGE_LIMIT), MAX_PAGE_LIMIT);`
 * Watched fail and restored — the unbounded arm returns 0 items instead of a page, and the
 * fractional arm 500s.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

/**
 * The `?limit=` strings `Number()` turns into a double that is NOT a usable page size.
 *
 * `""` is deliberately absent: `Number("")` is `0`, an ordinary number the clamp has always
 * raised to 1. These ten are the ones that were never numbers — `NaN` and `\u00b1Infinity` — which is
 * exactly the set the arithmetic clamp let through.
 */
const NOT_A_NUMBER = ["abc", "null", "[]", "0x", "NaN", "true", "1e999", "-1e999", "Infinity"];
/** Finite, so it is a real request — it just is not an integer, and `bigint` will not take it. */
const FRACTIONAL = ["1.5", "2.9", "0.5"];
const HOSTILE = [...NOT_A_NUMBER, ...FRACTIONAL];

describe("clampLimit is total over every double Number() can produce", () => {
  it("answers a usable integer page size for every hostile ?limit= string", () => {
    for (const raw of HOSTILE) {
      const n = clampLimit(Number(raw));
      expect(Number.isInteger(n), `clampLimit(Number(${JSON.stringify(raw)})) = ${n}`).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(MAX_PAGE_LIMIT);
    }
  });

  it("keeps the ceiling and the default it always had", () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
    expect(clampLimit(10)).toBe(10);
    expect(clampLimit(100000)).toBe(MAX_PAGE_LIMIT);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
  });
});

/**
 * ── WHERE THE ANSWER MOVED, AND WHY THE TWO CASES ABOVE DID NOT ─────────────────────────────
 *
 * `clampLimit` is unchanged and still total: it is the BACKSTOP, and the callers that reach a
 * service without coming through a request (the desktop door calls them directly) still depend on
 * it. What changed is the REQUEST door. Answering the default page for `?limit=abc` closed the
 * unbounded read and left a silent reinterpretation in its place — and the same silence answered
 * `?limit=` with a page of ONE, because `Number("")` is 0 and the clamp raises 0 to 1. The paging
 * seam (`src/query-bounds.ts`) refuses the shape once, at dispatch, naming the field.
 *
 * The property these two cases defend is unchanged and is asserted below exactly as before: never
 * a 500, and never a silent empty page. A stated 400 is neither.
 */
describe("GET /messages — a hostile ?limit= is refused by name, never an unbounded read", () => {
  it("refuses every hostile limit with the field named, and never 500s", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    for (let i = 0; i < 6; i++) {
      await seedMessage(db, {
        accountId: s.accountId, mailboxId: mb, folder: "INBOX",
        date: new Date(FIXED_NOW.getTime() - i * 60_000),
      });
    }

    for (const raw of HOSTILE) {
      const res = await H(req("GET", `/messages?view=imbox&limit=${encodeURIComponent(raw)}`, { bearer: s.token }), deps);
      // Never a 500: a fractional limit used to reach Postgres as a `bigint` parameter.
      expect(res.status, `status for ?limit=${raw}`).toBe(400);
      const body = await res.json() as { error?: { message?: string }; items?: unknown[] };
      // The refusal NAMES THE FIELD, so a caller can narrow to it rather than guess which of its
      // parameters the server disliked.
      expect(body.error?.message, `message for ?limit=${raw}`).toBe("limit must be a whole number of at least 1");
      // …and it is a refusal, not the empty page the unbounded read produced: the shape that
      // looked like "no results" while costing the most it could is still unreachable.
      expect(body.items, `items for ?limit=${raw}`).toBeUndefined();
    }
    // A blank limit is not hostile — it is "I did not say" — and it answers the default page.
    // Its absence from HOSTILE used to be the note above; now it is a case.
    const blank = await H(req("GET", "/messages?view=imbox&limit=", { bearer: s.token }), deps);
    expect(blank.status).toBe(200);
    expect(((await blank.json()) as { items: unknown[] }).items).toHaveLength(6);
  });

  it("still honours a real limit and its ceiling", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    for (let i = 0; i < 6; i++) {
      await seedMessage(db, {
        accountId: s.accountId, mailboxId: mb, folder: "INBOX",
        date: new Date(FIXED_NOW.getTime() - i * 60_000),
      });
    }
    const res = await H(req("GET", "/messages?view=imbox&limit=2", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBeTruthy();
  });
});

describe("GET /messages/bodies — the byte budget cannot be routed around", () => {
  it("refuses every hostile limit by name, and answers a bounded page for a blank one", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    for (let i = 0; i < 5; i++) {
      const m = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX" });
      await seedBody(db, { messageId: m.id, text: `body ${i}` });
    }

    for (const raw of HOSTILE) {
      const res = await H(req("GET", `/messages/bodies?limit=${encodeURIComponent(raw)}`, { bearer: s.token }), deps);
      expect(res.status, `status for ?limit=${raw}`).toBe(400);
      const body = await res.json() as { error?: { message?: string }; items?: unknown[] };
      expect(body.error?.message, `message for ?limit=${raw}`).toBe("limit must be a whole number of at least 1");
      // The empty loop that never reached `BODIES_BYTE_BUDGET` is still unreachable: there is no
      // page here at all, and the read the budget bounds never starts.
      expect(body.items, `bodies for ?limit=${raw}`).toBeUndefined();
    }
    // The read the budget bounds still happens for a request that IS one: a blank limit is not an
    // ask, so the service's own default page size applies and the whole seed comes back.
    const blank = await H(req("GET", "/messages/bodies?limit=", { bearer: s.token }), deps);
    expect(blank.status).toBe(200);
    expect(((await blank.json()) as { items: unknown[] }).items).toHaveLength(5);
  });
});
