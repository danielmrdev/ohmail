import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mailboxes } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { stampSynced } from "../src/sync-stamp.js";

/**
 * THE IMPORT'S OWN CLOCK on the device door: a pass that ran out of cycles with the first-import
 * stamp still null moves `sync_progress_at`, which search reads past the first day
 * (`search-coverage.ts`). A drained pass writes the stamp and leaves the clock; a pass after the
 * stamp writes neither. Both stores: this file runs in the sqlite project too, where the instant is
 * an integer and spelled by the dialect.
 */
async function freshMailbox() {
  const db = await makeTestDb();
  const [mb] = await db.insert(mailboxes).values({ accountId: randomUUID(), provider: "imap", address: "clock@lichtgrat.example" }).returning();
  const read = async () => (await db.select({ progress: mailboxes.syncProgressAt, stamp: mailboxes.initialImportCompletedAt })
    .from(mailboxes).where(eq(mailboxes.id, mb!.id)))[0]!;
  return { db, id: mb!.id, read };
}
const t0 = new Date("2026-09-20T10:00:00.000Z");
const later = (ms: number) => new Date(t0.getTime() + ms);

describe("stampSynced moves the import's clock while the first import owes mail", () => {
  it("an undrained pass with the stamp null writes the clock and no stamp", async () => {
    const m = await freshMailbox();
    const stamps = await stampSynced(m.db, m.id, t0, false);
    expect(stamps).toEqual({ importWasOpen: true, importStamped: false });
    expect(await m.read()).toEqual({ progress: t0, stamp: null });
    await stampSynced(m.db, m.id, later(60_000), false);
    expect((await m.read()).progress, "the clock moves with each pass that owes mail").toEqual(later(60_000));
  });

  it("a drained pass writes the stamp and leaves the clock where the last owing pass put it", async () => {
    const m = await freshMailbox();
    await stampSynced(m.db, m.id, t0, false);
    expect(await stampSynced(m.db, m.id, later(1000), true)).toEqual({ importWasOpen: true, importStamped: true });
    expect(await m.read()).toEqual({ progress: t0, stamp: later(1000) });
    const cold = await freshMailbox();
    await stampSynced(cold.db, cold.id, t0, true);
    expect(await cold.read(), "an import that drains in one pass never owed mail").toEqual({ progress: null, stamp: t0 });
  });

  it("a pass after the stamp writes neither, drained or not", async () => {
    const m = await freshMailbox();
    await stampSynced(m.db, m.id, t0, true);
    await stampSynced(m.db, m.id, later(5000), false);
    await stampSynced(m.db, m.id, later(9000), true);
    expect(await m.read()).toEqual({ progress: null, stamp: t0 });
  });
});

/**
 * `last_sync_at` IS THE PASS'S START (mail 0145). An adopted external move is stamped with it as a
 * lower bound of the move; a pass's END can postdate a move its scans missed, and an aged ohmail
 * press made before the move would then be refused behind it and hidden.
 */
describe("stampSynced records when the pass began", () => {
  it("writes the pass start to last_sync_at, drained or not, and the import stamp at now", async () => {
    for (const drained of [false, true]) {
      const m = await freshMailbox();
      const started = new Date(t0.getTime() - 4 * 60_000);
      await stampSynced(m.db, m.id, t0, drained, started);
      const [row] = await m.db.select({ last: mailboxes.lastSyncAt, done: mailboxes.initialImportCompletedAt })
        .from(mailboxes).where(eq(mailboxes.id, m.id));
      expect([drained, row!.last?.getTime(), row!.done?.getTime() ?? null])
        .toEqual([drained, started.getTime(), drained ? t0.getTime() : null]);
    }
  });
});
