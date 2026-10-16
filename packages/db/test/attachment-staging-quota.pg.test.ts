import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { NotInTransactionError } from "../src/change-log.js";
import { accounts } from "../src/schema-mail.js";
import { attachmentStaging } from "../src/schema-cloud.js";
import {
  createStagingTicket, createStagingTicketWithinQuota, outstandingStagingUsage,
  readStagingTickets, expiredStagingTickets, deleteStagingTickets,
  sweepExpiredStagingFor, drainExpiredStaging,
  ATTACHMENT_STAGING_TTL_MS, STAGING_QUOTA_LOCK_CLASS,
  STAGING_MAX_OUTSTANDING_TICKETS, STAGING_MAX_OUTSTANDING_BYTES,
  type AttachmentStagingStorage, type StagingQuota,
} from "../src/attachment-staging.js";

/**
 * SEC3-MONEY-2 — THE TWO BOUNDS, ON REAL POSTGRES.
 *
 * The finding was that hosted attachment staging had neither: no per-account ceiling on outstanding
 * tickets or bytes, and a retention sweep that took ONE page an hour with no loop. A client
 * minting faster than a page an hour outran cleanup permanently — and because the sweep's predicate
 * is the clock rather than an identity, its backlog sat in front of every other account's rows too.
 * Storage-cost griefing, from an email-verified account, with one route.
 *
 * ## What is here and could not be anywhere else
 *
 * `attachment-staging-store.test.ts` settles the drain's paging, ceilings and failure handling
 * against an injected expired-set, with no database in the file. What needs REAL Postgres is
 * everything the quota's correctness rests on, and PGlite can speak to none of it:
 *
 *  · **THE LOCK.** A quota is an aggregate over rows the same statement is about to add to. Under
 *    READ COMMITTED every concurrent mint takes its snapshot at the start of its own `SELECT`, so
 *    without a mutex N simultaneous requests all read the same pre-state and all insert — the
 *    overshoot bounded by concurrency instead of by the cap. That is the SEC3-MONEY-7 shape, and
 *    the only way to see it is several physical connections against one server. PGlite has one.
 *  · **THAT THE LOCK IS THE THING DOING IT.** `pg_locks` is asked directly whether the second
 *    mint is waiting on the advisory key, so a green cannot come from an interleave that happened
 *    to be favourable.
 *  · **THE KEYSET CURSOR** the drain pages with, as SQL a real planner runs, including its
 *    `(expires_at, id)` row comparison.
 *
 * ## The mutations watched
 *
 *  · drop the `pg_advisory_xact_lock` line → the concurrent-mint case overshoots the cap, and the
 *    `pg_locks` case reports no waiter;
 *  · count ALL rows instead of unexpired ones → expired tickets stop freeing quota, and a
 *    deployment whose sweep was behind would refuse honest uploads;
 *  · `break` after one page in `drainExpiredStaging` → the flood keeps a permanent backlog.
 */
const PG_UP = await realPgAvailable();

// Several connections, because the decisive assertion is two mints racing on separate backends.
const client = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const db = brandDialect(drizzle(client), "pg");

beforeAll(async () => {
  if (!PG_UP) return;
  await runMigrations(PG_TEST_URL);
}, 120_000);

/**
 * EVERY ACCOUNT THIS FILE CREATES, so it can take them away again.
 *
 * The :5433 Postgres is SHARED and long-lived, and a fixture that leaves rows behind is a
 * permanent change to what every other suite's database-global assertions see. This slice fixed
 * exactly that failure on `mailbox-smtp-max-size.pg.test.ts`, whose NO-BACKFILL assertion had gone
 * permanently red on another suite's leaked mailboxes; a file that argued the point and then leaked
 * a few hundred accounts of its own would be worth nothing.
 */
const created: string[] = [];

afterAll(async () => {
  if (PG_UP && created.length > 0) {
    // Child rows first — `attachment_staging.account_id` carries a foreign key. Through drizzle's
    // `inArray` rather than a `= any(${ids})` template: drizzle expands a JS array in a `sql`
    // template as a ROW constructor, so the cast reads `cannot cast type record to uuid[]`.
    await db.delete(attachmentStaging).where(inArray(attachmentStaging.accountId, created));
    await db.delete(accounts).where(inArray(accounts.id, created));
  }
  await client.end({ timeout: 5 }).catch(() => { /* the pool is already down */ });
});

const NOW = new Date("2026-08-14T12:00:00Z");

/** A throwaway account, so parallel rows in a shared database never collide. */
async function seedAccount(): Promise<string> {
  const rows = await db.execute(sql`
    insert into accounts (name) values ('staging-quota-pg') returning id
  `);
  const id = (rows as unknown as Array<{ id: string }>)[0]!.id;
  created.push(id);       // see `afterAll` — this database outlives the run
  return id;
}

const input = (accountId: string, over: { sizeBytes?: number; now?: Date } = {}) => {
  const id = randomUUID();
  return {
    id,
    accountId,
    objectPath: `${accountId}/${id}`,
    filename: "holiday.mov",
    contentType: "video/quicktime",
    sizeBytes: over.sizeBytes ?? 1024,
    now: over.now ?? NOW,
  };
};

/** One mint, in its own transaction, exactly as the service port composes it. */
const mint = (accountId: string, quota: StagingQuota, over: { sizeBytes?: number; now?: Date } = {}) =>
  db.transaction((tx) => createStagingTicketWithinQuota(tx as never, input(accountId, over), quota));

const TIGHT: StagingQuota = { maxTickets: 3, maxBytes: 10_000 };

describe.skipIf(!PG_UP)("the per-account quota REFUSES at the ceiling", () => {
  it("mints up to the ticket cap and refuses the next one, naming the numbers", async () => {
    const accountId = await seedAccount();
    for (let i = 0; i < TIGHT.maxTickets; i += 1) {
      const res = await mint(accountId, TIGHT, { sizeBytes: 1 });
      expect(res.ok, `mint ${i} should have been admitted`).toBe(true);
    }
    const refused = await mint(accountId, TIGHT, { sizeBytes: 1 });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal).toEqual({ limit: "tickets", outstanding: 3, cap: 3 });
    // AND NOTHING WAS WRITTEN. A refusal that left a row would be the defect with an error
    // message on it.
    const usage = await outstandingStagingUsage(db as never, accountId, NOW);
    expect(usage.tickets).toBe(3);
  });

  it("refuses on BYTES even when the ticket count is nowhere near its cap", async () => {
    // The two limits are independent: one file can carry the whole byte allowance, and the count
    // bound would happily admit hundreds more of them.
    const accountId = await seedAccount();
    const first = await mint(accountId, TIGHT, { sizeBytes: 9_000 });
    expect(first.ok).toBe(true);
    const refused = await mint(accountId, TIGHT, { sizeBytes: 2_000 });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal).toEqual({
      limit: "bytes", outstanding: 9_000, requested: 2_000, cap: 10_000,
    });
    // Exactly filling the allowance is admitted — the comparison is a ceiling, not a margin.
    expect((await mint(accountId, TIGHT, { sizeBytes: 1_000 })).ok).toBe(true);
  });

  it("a declaration LARGER THAN THE WHOLE ALLOWANCE is refused, whatever any mail server announced", async () => {
    // The per-file ceiling at the route is `effectiveAttachmentCap(null, smtpMaxSizeBytes)` — the
    // RFC 1870 `SIZE` the sending mailbox's own submission server announced, which is a number a
    // caller can choose by pointing a mailbox at a server it runs. The byte quota is the bound
    // that does not come from anybody else's server.
    const accountId = await seedAccount();
    const res = await mint(accountId, TIGHT, { sizeBytes: 10 * 1024 * 1024 * 1024 });
    expect(res.ok).toBe(false);
    expect(await outstandingStagingUsage(db as never, accountId, NOW)).toEqual({ tickets: 0, bytes: 0 });
  });

  it("another account's tickets do not count — the quota is per account, like every other read here", async () => {
    const mine = await seedAccount();
    const theirs = await seedAccount();
    for (let i = 0; i < TIGHT.maxTickets; i += 1) {
      expect((await mint(theirs, TIGHT, { sizeBytes: 1 })).ok).toBe(true);
    }
    expect((await mint(mine, TIGHT, { sizeBytes: 1 })).ok).toBe(true);
  });

  it("EXPIRED TICKETS FREE QUOTA, swept or not — the mint never waits on the sweep", async () => {
    // THE COUPLING THIS AVOIDS ON PURPOSE. If the quota counted expired-but-unswept rows, a
    // deployment whose bucket was briefly unreachable would start refusing honest uploads because
    // its own cleanup was behind — a storage incident turned into a product outage. Here the rows
    // are still physically present and the account is under quota anyway.
    //
    // Mutation: drop the `expires_at > now` predicate in `outstandingStagingUsage` → this refuses.
    const accountId = await seedAccount();
    const old = new Date(NOW.getTime() - ATTACHMENT_STAGING_TTL_MS - 60_000);
    for (let i = 0; i < TIGHT.maxTickets; i += 1) {
      expect((await mint(accountId, TIGHT, { sizeBytes: 1, now: old })).ok).toBe(true);
    }
    const stillThere = await db.execute(sql`
      select count(*)::int as n from attachment_staging where account_id = ${accountId}::uuid
    `);
    expect((stillThere as unknown as Array<{ n: number }>)[0]!.n).toBe(3);

    expect(await outstandingStagingUsage(db as never, accountId, NOW)).toEqual({ tickets: 0, bytes: 0 });
    expect((await mint(accountId, TIGHT, { sizeBytes: 1 })).ok).toBe(true);
  });

  it("REFUSES A TOP-LEVEL HANDLE — a lock that auto-commits serializes nothing", async () => {
    // The one seam a type cannot cover: `Tx` is legitimately either handle at several call sites,
    // so the runtime check is what stops a caller acquiring a lock that is released at the end of
    // its own statement. It would pass every single-threaded test.
    const accountId = await seedAccount();
    await expect(createStagingTicketWithinQuota(db as never, input(accountId), TIGHT))
      .rejects.toThrow(NotInTransactionError);
  });
});

describe.skipIf(!PG_UP)("the quota is EXACT under concurrency — the lock, not luck", () => {
  it("TWELVE SIMULTANEOUS MINTS against a cap of three admit exactly three", async () => {
    // THE TOCTOU CASE. Without the advisory lock each of these reads the same pre-state on its own
    // backend and inserts, so the ceiling becomes "three plus however many arrived together".
    //
    // Mutation watched: delete the `pg_advisory_xact_lock` statement → this admits more than three.
    const accountId = await seedAccount();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => mint(accountId, TIGHT, { sizeBytes: 1 })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok)).toHaveLength(9);
    const usage = await outstandingStagingUsage(db as never, accountId, NOW);
    expect(usage.tickets).toBe(3);
  });

  it("the BYTE total is exact too — twelve racing 1 000-byte mints against a 3 000-byte cap", async () => {
    // The cap is deliberately far below the number of racers AND below the connection pool's
    // size. An earlier version of this used a larger byte cap and stayed green under the
    // no-lock mutation: twelve requests through a ten-connection pool admit ten of them, which
    // is exactly what that cap allows, so the assertion could not tell a working mutex
    // from a pool that happened to be the right size. Three is smaller than both.
    const accountId = await seedAccount();
    const quota: StagingQuota = { maxTickets: 1_000, maxBytes: 3_000 };
    const results = await Promise.all(
      Array.from({ length: 12 }, () => mint(accountId, quota, { sizeBytes: 1_000 })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect((await outstandingStagingUsage(db as never, accountId, NOW)).bytes).toBe(3_000);
  });

  it("a second mint WAITS ON THE ADVISORY KEY — asserted from `pg_locks`, not inferred", async () => {
    // A green from the two cases above could in principle come from an interleave that happened to
    // serialize itself. This asks the server directly: while one mint's transaction is open, the
    // next one for the SAME account is blocked, and the lock it is blocked on is this module's.
    //
    // Mutation: delete the lock statement → `waiting` is 0 and the second mint finishes before the
    // first transaction commits.
    const accountId = await seedAccount();
    const quota: StagingQuota = { maxTickets: 100, maxBytes: 1_000_000 };

    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let secondDone = false;

    const holder = db.transaction(async (tx) => {
      await createStagingTicketWithinQuota(tx as never, input(accountId), quota);
      await held;                       // the transaction stays open, so the lock stays taken
    });
    // Let the holder reach its lock before the contender asks for it.
    await new Promise((r) => setTimeout(r, 150));

    const contender = mint(accountId, quota).then((r) => { secondDone = true; return r; });
    await new Promise((r) => setTimeout(r, 300));

    const waiting = await db.execute(sql`
      select count(*)::int as n from pg_locks
      where locktype = 'advisory' and not granted and classid = ${STAGING_QUOTA_LOCK_CLASS}
    `);
    expect((waiting as unknown as Array<{ n: number }>)[0]!.n).toBe(1);
    expect(secondDone, "the second mint ran to completion while the first held the lock").toBe(false);

    release();
    await holder;
    expect((await contender).ok).toBe(true);
  });

  it("a mint for ANOTHER account does not queue behind it — the key is per account", async () => {
    // A global mutex would have been simpler and would make every hosted upload in the deployment
    // serial. `hashtext(account_id)` is the second word of the key for exactly this reason.
    const busy = await seedAccount();
    const other = await seedAccount();
    const quota: StagingQuota = { maxTickets: 100, maxBytes: 1_000_000 };

    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = db.transaction(async (tx) => {
      await createStagingTicketWithinQuota(tx as never, input(busy), quota);
      await held;
    });
    await new Promise((r) => setTimeout(r, 150));

    // No timeout dance: if this queued behind the holder it would never resolve, and the test
    // would fail by timing out rather than by assertion — which is still a failure, loudly.
    expect((await mint(other, quota)).ok).toBe(true);

    release();
    await holder;
  });
});

describe.skipIf(!PG_UP)("the sweep DRAINS, against real rows", () => {
  /** A storage port that deletes nothing and throws nothing — what a 404 looks like to the sweep. */
  const quietStorage = (removed: string[] = []): AttachmentStagingStorage => ({
    async signUpload() { throw new Error("unused"); },
    async download() { throw new Error("unused"); },
    async remove(paths) { removed.push(...paths); },
  });

  /**
   * Clear whatever the rest of the suite left expired in this shared database BEFORE measuring.
   * The sweep is global by design — its predicate is the clock, not an identity — so a bounded
   * assertion that did not start from a known floor would be measuring somebody else's rows.
   */
  async function drainEverything(): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      const res = await sweepExpiredStagingFor(db as never, quietStorage(), NOW);
      if (res.drained) return;
    }
    throw new Error("the shared database could not be drained — something is re-minting expired rows");
  }

  /**
   * A FLOOD CASE HAS ITS OWN BOUND AND IS SETTLED BEFORE THE NEXT CASE. Each writes up to a flood's worth of rows
   * through `createStagingTicket`, two statements a row: 3.0-4.1 s alone, so vitest's 5 s default
   * left under a second of database latency. A case that times out keeps running, and its flood and
   * its global sweep then land inside the next case's drained floor, so `afterEach` waits for it.
   */
  const FLOOD_CASE_MS = 30_000;
  let running: Promise<void> | null = null;
  const floodCase = (name: string, body: () => Promise<void>) =>
    it(name, () => (running = body()), FLOOD_CASE_MS);
  afterEach(async () => {
    await running?.catch(() => { /* that case has already failed by name */ });
    running = null;
  }, FLOOD_CASE_MS);

  /** `n` already-expired tickets for `accountId`, one second apart so the order is deterministic. */
  async function flood(accountId: string, n: number, from = 0): Promise<void> {
    const base = NOW.getTime() - 2 * ATTACHMENT_STAGING_TTL_MS;
    for (let i = 0; i < n; i += 1) {
      await createStagingTicket(db as never, input(accountId, {
        sizeBytes: 1, now: new Date(base + (from + i) * 1000),
      }));
    }
  }

  floodCase("A 500-ROW FLOOD GOES TO ZERO IN ONE PASS — the shape that shipped cleared 200", async () => {
    // 500 is the most one account can put in a retention window under the mint quota, so this is
    // the worst case a single account can produce, drained inside one hourly slot.
    //
    // Mutation: `break` after the first page in `drainExpiredStaging` → 200 go, 300 remain, and
    // every following hour removes 200 while the account mints more.
    await drainEverything();
    const accountId = await seedAccount();
    await flood(accountId, 500);

    const removed: string[] = [];
    const res = await sweepExpiredStagingFor(db as never, quietStorage(removed), NOW);
    expect(res.deleted).toBe(500);
    expect(res.drained).toBe(true);
    expect(res.stoppedBy).toBe("dry");
    expect(res.pages).toBe(3);
    expect(removed).toHaveLength(500);
    const left = await db.execute(sql`
      select count(*)::int as n from attachment_staging where account_id = ${accountId}::uuid
    `);
    expect((left as unknown as Array<{ n: number }>)[0]!.n).toBe(0);
  });

  floodCase("a per-invocation ceiling BELOW the flood still finishes it across bounded passes", async () => {
    // The ceiling is a bound on one pass, not a cap on the deployment: whatever it leaves, the
    // next pass takes, and the cursor means it never re-reads what it already cleared.
    await drainEverything();
    const accountId = await seedAccount();
    await flood(accountId, 500);

    let passes = 0;
    let total = 0;
    for (;;) {
      const res = await sweepExpiredStagingFor(db as never, quietStorage(), NOW, { maxRows: 150 });
      passes += 1;
      total += res.deleted;
      if (res.drained) break;
      expect(passes, "the drain is not making progress").toBeLessThan(10);
    }
    expect(total).toBe(500);
    // The flood over the budget rounds up to four passes. Three passes spend the whole row budget and stop on `rows`; the fourth
    // reads the last 50, comes back under budget, reads again, finds nothing and reports `dry` —
    // so the pass that finishes the work is also the pass that proves it is finished.
    expect(passes).toBe(4);
  });

  floodCase("ONE FLOODING ACCOUNT DOES NOT STARVE ANOTHER'S ROWS in the same pass", async () => {
    // Oldest-first is only fair because the quota bounds how much any one account can put in front
    // of anybody else. The flooder owns the oldest 500; the quiet account's three rows are the
    // youngest and still go in the same invocation.
    await drainEverything();
    const noisy = await seedAccount();
    const quiet = await seedAccount();
    await flood(noisy, 500);
    await flood(quiet, 3, 500);

    const res = await sweepExpiredStagingFor(db as never, quietStorage(), NOW);
    expect(res.deleted).toBe(503);
    const left = await db.execute(sql`
      select count(*)::int as n from attachment_staging
      where account_id in (${noisy}::uuid, ${quiet}::uuid)
    `);
    expect((left as unknown as Array<{ n: number }>)[0]!.n).toBe(0);
  });

  floodCase("A PERMANENTLY UNREMOVABLE OBJECT DOES NOT WEDGE THE TABLE — its page is skipped", async () => {
    // The wedge the cursor exists for, with real rows underneath it. The poisoned rows are the
    // OLDEST, so a loop that restarted from the beginning would hand storage the same page every
    // iteration and reach nothing behind it — one bad object stalling cleanup for the deployment.
    //
    // Object-first is what makes the skip safe: the failed rows still NAME their objects, so
    // nothing is orphaned and the next pass tries again.
    await drainEverything();
    const accountId = await seedAccount();
    await flood(accountId, 250);
    const oldest = await expiredStagingTickets(db as never, NOW, 1);
    const poison = oldest[0]!.objectPath;

    const failing: AttachmentStagingStorage = {
      async signUpload() { throw new Error("unused"); },
      async download() { throw new Error("unused"); },
      async remove(paths) {
        if (paths.includes(poison)) throw new Error("storage refuses this object");
      },
    };
    const res = await drainExpiredStaging({
      storage: failing,
      expired: (n, after) => expiredStagingTickets(db as never, NOW, n, after),
      deleteRows: (ids) => deleteStagingTickets(db as never, ids),
      pageSize: 100,
    });
    expect(res.failedPages).toBe(1);
    expect(res.deleted).toBe(150);
    expect(res.drained).toBe(false);        // rows remain, and the caller is told so
    // The poisoned page survived, WITH its object path — the row is the only record of it.
    const left = await readStagingTickets(db as never, accountId, oldest.map((r) => r.id));
    expect(left).toHaveLength(1);
    expect(left[0]!.objectPath).toBe(poison);
    // And the rest of the table is clear, which is the property the wedge would have destroyed.
    const remaining = await db.execute(sql`
      select count(*)::int as n from attachment_staging where account_id = ${accountId}::uuid
    `);
    expect((remaining as unknown as Array<{ n: number }>)[0]!.n).toBe(100);

    await drainEverything();                // leave the shared database as it was found
  });

  it("the KEYSET CURSOR is a real row comparison — ties on `expires_at` are not skipped", async () => {
    // Twelve tickets sharing one `expires_at` to the microsecond, which is what a compose window
    // minting a dozen files produces. `ORDER BY expires_at` alone leaves their order to the
    // planner, so a cursor built on it would drop rows or loop; the pair `(expires_at, id)` is
    // what makes paging total.
    await drainEverything();
    const accountId = await seedAccount();
    const same = new Date(NOW.getTime() - 2 * ATTACHMENT_STAGING_TTL_MS);
    for (let i = 0; i < 12; i += 1) {
      await createStagingTicket(db as never, input(accountId, { sizeBytes: 1, now: same }));
    }
    const seen = new Set<string>();
    let after: { expiresAt: Date; id: string } | null = null;
    for (let page = 0; page < 12; page += 1) {
      const rows: Awaited<ReturnType<typeof expiredStagingTickets>> =
        await expiredStagingTickets(db as never, NOW, 5, after);
      if (rows.length === 0) break;
      for (const r of rows) seen.add(r.id);
      const last = rows[rows.length - 1]!;
      after = { expiresAt: last.expiresAt, id: last.id };
    }
    expect(seen.size).toBe(12);
    await drainEverything();
  });
});

describe.skipIf(!PG_UP)("the shipped quota numbers", () => {
  it("are the ones the sweep's arithmetic was computed against", () => {
    // These two constants are load-bearing on each other: the drain's ceiling is chosen to beat
    // `STAGING_MAX_OUTSTANDING_TICKETS` rows per TTL per account across a large number of saturated accounts.
    // Changing either without the other is what the comment on `STAGING_SWEEP_MAX_ROWS` asks a
    // future editor to notice.
    expect(STAGING_MAX_OUTSTANDING_TICKETS).toBe(500);
    expect(STAGING_MAX_OUTSTANDING_BYTES).toBe(1024 * 1024 * 1024);
  });
});
