import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import { webauthnChallenges } from "../src/schema-cloud.js";
import {
  pruneWebauthnChallenges,
  WEBAUTHN_CHALLENGE_PRUNE_LIMIT,
  WEBAUTHN_CHALLENGE_RETENTION_MS,
} from "../src/webauthn-challenges.js";
import type { Tx } from "../src/change-log.js";

/**
 * `webauthn_challenges` STOPS GROWING FOR EVER (cloud 0034).
 *
 * The table held every passkey ceremony a deployment had ever opened, with no index and nothing
 * that deleted a row: an expired challenge is already unusable — `consumeChallenge` refuses on
 * `expires_at <= now` — so the whole tail was dead weight that anyone able to open a ceremony
 * could grow. The claim under test is the GROWTH CURVE, not the single delete: seeded with a
 * backlog, repeated prunes drain it monotonically to the retention window and stop there, and no
 * ONE prune does more than {@link WEBAUTHN_CHALLENGE_PRUNE_LIMIT} rows of work.
 */
type Db = Awaited<ReturnType<typeof makeTestDb>>;

const NOW = new Date("2026-09-12T12:00:00.000Z");
const MIN = 60_000;

/** One challenge row, placed by where its EXPIRY sits relative to `NOW`. */
async function seedChallenges(db: Db, offsetsMs: readonly number[]): Promise<void> {
  if (offsetsMs.length === 0) return;
  await db.insert(webauthnChallenges).values(offsetsMs.map((off, i) => ({
    challenge: `c-${i}-${off}`,
    type: "authentication",
    rpId: "ohmail.app",
    origin: "https://ohmail.app",
    expiresAt: new Date(NOW.getTime() + off),
  })));
}

const countRows = async (db: Db): Promise<number> => {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(webauthnChallenges);
  return Number(row?.n ?? 0);
};

describe("the retention window", () => {
  it("deletes what is past retention and keeps the live ceremony and its grace hour", async () => {
    const db = await makeTestDb();
    await seedChallenges(db, [
      +5 * MIN,                                   // a ceremony somebody is completing right now
      -1 * MIN,                                   // expired, inside the grace hour
      -WEBAUTHN_CHALLENGE_RETENTION_MS + MIN,     // still inside the grace hour, only just
      -WEBAUTHN_CHALLENGE_RETENTION_MS - MIN,     // past retention
      -400 * 24 * 60 * MIN,                       // a year of never having been pruned
    ]);

    const removed = await pruneWebauthnChallenges(db as unknown as Tx, { now: NOW });

    expect(removed).toBe(2);
    expect(await countRows(db)).toBe(3);
  });

  it("prunes by EXPIRY and not by consumption — a spent row is no more dead than an expired one", async () => {
    const db = await makeTestDb();
    await seedChallenges(db, [-WEBAUTHN_CHALLENGE_RETENTION_MS - MIN]);
    await db.update(webauthnChallenges).set({ consumedAt: new Date(NOW.getTime() - 2 * MIN) });

    expect(await pruneWebauthnChallenges(db as unknown as Tx, { now: NOW })).toBe(1);
    expect(await countRows(db)).toBe(0);
  });

  it("an empty table costs one read and writes nothing", async () => {
    const db = await makeTestDb();
    expect(await pruneWebauthnChallenges(db as unknown as Tx, { now: NOW })).toBe(0);
  });

  it("answers the rows it deleted, not the ids it read: a ceremony that took one first is not counted", async () => {
    const db = await makeTestDb();
    await seedChallenges(db, [-WEBAUTHN_CHALLENGE_RETENTION_MS - MIN, -WEBAUTHN_CHALLENGE_RETENTION_MS - 2 * MIN]);
    // Between the prune's read and its delete, another door deletes one of the two rows it read.
    const racing = new Proxy(db, {
      get(target, prop) {
        const v = Reflect.get(target, prop) as unknown;
        if (prop !== "delete") return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        return (table: unknown) => {
          const pending = (v as (t: unknown) => { where: (w: unknown) => unknown }).call(target, table);
          return { where: (w: unknown) => ({
            returning: async (shape: unknown) => {
              await target.execute(sql`delete from webauthn_challenges where id = (select id from webauthn_challenges order by expires_at limit 1)`);
              return (pending.where(w) as { returning: (s: unknown) => Promise<unknown[]> }).returning(shape);
            },
            then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(pending.where(w)).then(ok, ko),
          }) };
        };
      },
    });
    expect(await pruneWebauthnChallenges(racing as unknown as Tx, { now: NOW })).toBe(1);
    expect(await countRows(db)).toBe(0);
  });
});

describe("the growth curve", () => {
  it("a backlog drains monotonically, no single prune exceeding the bound", async () => {
    const db = await makeTestDb();
    const limit = 25;                 // the real bound's shape at a size a test can seed
    const backlog = 2 * limit + 7;    // three prunes' worth, the last one short
    const live = 4;

    await seedChallenges(db, [
      ...Array.from({ length: backlog }, (_, i) =>
        -WEBAUTHN_CHALLENGE_RETENTION_MS - (i + 1) * MIN),
      ...Array.from({ length: live }, (_, i) => (i + 1) * MIN),
    ]);
    expect(await countRows(db)).toBe(backlog + live);

    // Each pass is ONE ceremony start's worth of work. The curve is what is asserted: strictly
    // falling while anything is due, never more than `limit` in one pass, and it STOPS at the
    // live rows rather than draining the table.
    const curve: number[] = [];
    for (let pass = 0; pass < 6; pass += 1) {
      const removed = await pruneWebauthnChallenges(db as unknown as Tx, { now: NOW, limit });
      expect(removed).toBeLessThanOrEqual(limit);
      curve.push(await countRows(db));
    }

    expect(curve).toEqual([
      backlog + live - limit,
      backlog + live - 2 * limit,
      live,
      live,
      live,
      live,
    ]);
  });

  it("the bound out-runs the growth: one row in, up to many out, so the table falls", async () => {
    // The invariant behind `WEBAUTHN_CHALLENGE_PRUNE_LIMIT`. A ceremony start adds exactly one
    // row and prunes up to `limit`, so a deployment opening ceremonies as fast as it likes still
    // converges — the arithmetic, driven rather than asserted in prose.
    const db = await makeTestDb();
    const limit = 10;
    await seedChallenges(db, Array.from({ length: 95 }, (_, i) =>
      -WEBAUTHN_CHALLENGE_RETENTION_MS - (i + 1) * MIN));

    const dueNow = async (): Promise<number> => {
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(webauthnChallenges)
        .where(sql`${webauthnChallenges.expiresAt} < ${NOW.toISOString()}::timestamptz`);
      return Number(row?.n ?? 0);
    };

    let due = await dueNow();
    expect(due).toBe(95);
    let ceremonies = 0;
    while (due > 0 && ceremonies < 40) {
      await seedChallenges(db, [+5 * MIN]);                    // the start's own row
      await pruneWebauthnChallenges(db as unknown as Tx, { now: NOW, limit });
      const next = await dueNow();
      expect(next).toBeLessThan(due);                          // never a standstill
      due = next;
      ceremonies += 1;
    }
    // The backlog is gone, and it took the arithmetic's number of starts, not more: ten rows go
    // per start, so ninety-five take ten. The rows still standing are the ceremonies themselves.
    expect(due).toBe(0);
    expect(ceremonies).toBe(10);
    expect(await countRows(db)).toBe(10);
  });

  it("the real bound is the one the doors use, and it is greater than the one row they add", () => {
    expect(WEBAUTHN_CHALLENGE_PRUNE_LIMIT).toBeGreaterThan(1);
  });
});

describe("the key the prune walks", () => {
  it("cloud 0034's index is on the table the journal replayed", async () => {
    const db = await makeTestDb();
    const rows = await db.execute(sql`
      select indexname from pg_indexes
       where schemaname = 'public' and tablename = 'webauthn_challenges'`);
    const names = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [])
      .map((r) => (r as { indexname: string }).indexname);
    expect(names).toContain("webauthn_challenges_expires_idx");
  });
});
