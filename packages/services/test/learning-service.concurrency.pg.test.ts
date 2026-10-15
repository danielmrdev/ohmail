import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { graduations } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { LearningService, GRADUATION_THRESHOLD } from "@trafficflow/services";
import { pgTestUrl } from "@trafficflow/db/testing";

/**
 * Resolution the graduation-counter analogue of the allocateSeq test,
 * and the ONE learning test PGlite cannot host. Proves the `graduations` counter
 * bump (`ON CONFLICT DO UPDATE SET positives = positives + 1`, with the `graduated`
 * flip computed in the SAME statement) is lost-update-free under TWO concurrent
 * blocking transactions on separate physical connections to a REAL Postgres
 * (docker compose service on :5433). An app-side read-modify-write — the exact
 * worker-read / API-write race the spec warns about — would drop increments here;
 * the row lock the ON CONFLICT takes cannot.
 */
const URL = pgTestUrl(import.meta.url);

const sqlA = postgres(URL, { max: 5 });
const sqlB = postgres(URL, { max: 5 });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");
const dbB = brandDialect(drizzle(sqlB, { schema }), "pg");

describe("graduation counter under real-Postgres concurrency", () => {
  beforeAll(async () => { await runMigrations(URL); });
  afterAll(async () => { await sqlA.end({ timeout: 5 }); await sqlB.end({ timeout: 5 }); });

  const DEST = "ohmail/News";
  const svc = new LearningService();
  const pk = (sender: string) => `sender:${sender.toLowerCase()}→${DEST}`;

  async function readCounter(acct: string, sender: string) {
    const [g] = await dbA.select().from(graduations)
      .where(and(eq(graduations.accountId, acct), eq(graduations.patternKey, pk(sender))));
    return g;
  }

  it("two long-lived blocking transactions each bumping K positives → positives = 2K (no lost update) + graduated", async () => {
    const acct = randomUUID();
    const sender = `race-${acct.slice(0, 8)}@ex.example`;
    const K = 20;

    // Each tx takes the graduations row lock on its first bump (INSERT … ON CONFLICT)
    // and holds it until commit, so the other tx BLOCKS on its first bump — genuine
    // concurrent-but-serialized writers to the SAME (account, pattern) counter.
    const worker = (db: typeof dbA, tag: string) =>
      db.transaction(async (tx) => {
        for (let i = 0; i < K; i++) {
          await svc.recordOn(tx, acct, {
            triggeringActionId: `${tag}:${i}`, // distinct → every signal inserts → every bump counts
            kind: "approval", senderAddress: sender, destination: DEST, label: "positive",
          });
        }
      });

    await Promise.all([worker(dbA, "A"), worker(dbB, "B")]);

    const g = await readCounter(acct, sender);
    expect(g.positives).toBe(2 * K);   // a read-modify-write would land short of it here
    expect(g.negatives).toBe(0);
    expect(g.graduated).toBe(true);    // past GRADUATION_THRESHOLD
    expect(g.graduatedAt).not.toBeNull();
    expect(2 * K).toBeGreaterThanOrEqual(GRADUATION_THRESHOLD);
  });

  it("many concurrent single-bump transactions across two connections → positives = N (the worker-read/API-write race)", async () => {
    const acct = randomUUID();
    const sender = `burst-${acct.slice(0, 8)}@ex.example`;
    const N = 40;

    const tasks: Array<Promise<void>> = [];
    for (let i = 0; i < N; i++) {
      const db = i % 2 === 0 ? dbA : dbB;
      tasks.push(db.transaction((tx) => svc.recordOn(tx, acct, {
        triggeringActionId: `burst:${i}`,
        kind: "approval", senderAddress: sender, destination: DEST, label: "positive",
      })));
    }
    await Promise.all(tasks);

    const g = await readCounter(acct, sender);
    expect(g.positives).toBe(N);       // every one of N concurrent increments survived
    expect(g.graduated).toBe(true);
  });

  it("a replayed triggering action (same id) never double-counts under concurrency", async () => {
    const acct = randomUUID();
    const sender = `dedup-${acct.slice(0, 8)}@ex.example`;
    const N = 30;

    // N concurrent transactions all replay the SAME triggeringActionId → the
    // learning_signals unique gate lets exactly ONE through → exactly ONE bump.
    const tasks: Array<Promise<unknown>> = [];
    for (let i = 0; i < N; i++) {
      const db = i % 2 === 0 ? dbA : dbB;
      tasks.push(
        db.transaction((tx) => svc.recordOn(tx, acct, {
          triggeringActionId: "same-action",
          kind: "approval", senderAddress: sender, destination: DEST, label: "positive",
        })).catch(() => undefined), // a serialization conflict on the dup insert is fine — it just means no bump
      );
    }
    await Promise.all(tasks);

    const g = await readCounter(acct, sender);
    expect(g.positives).toBe(1);       // deduped by (accountId, triggeringActionId) → single count
  });
});
