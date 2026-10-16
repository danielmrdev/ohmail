import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { messages } from "@trafficflow/db";
import { dialect, dialectOf } from "@trafficflow/db/dialect";
import { MessageService } from "../src/index.js";
import { makeCtx } from "./helpers.js";

/**
 * THE HISTORY RAIL IS A READ OF THE ARRIVAL INDEX, NOT OF THE ACCOUNT PER MONTH. `timeline()` is asked on the mount of every list whose mirror is not whole and on
 * every store change while History is open. Its per-month probes once wrapped the key in a `case`,
 * which matches no index, so each probe scanned the account: seconds on a large PGlite store in
 * Zurich, minutes on the phone's SQLite. These are cost BOUNDS on the store a person's app carries —
 * the phone's store and the desktop's, each over years of months — in UTC and in a zone, far above
 * the measured cost and far below the defect's. The server's plan is pinned in the lane-db twin.
 */
const NOW = new Date("2026-09-29T08:00:00.000Z");
const MONTH = 30 * 864e5;
const BOUND_MS = 6_000;

async function grown(rows: number, months: number) {
  const w = await makeCtx(NOW);
  const step = (months * MONTH) / rows;
  const batch: Array<typeof messages.$inferInsert> = [];
  const flush = async () => { if (batch.length) await w.db.insert(messages).values(batch.splice(0)); };
  for (let g = 0; g < rows; g++) {
    const at = new Date(NOW.getTime() - Math.floor(g * step));
    batch.push({
      accountId: w.accountId, mailboxId: w.mailboxId, messageIdHeader: `<t${g}@cost.test>`, bodyHash: `h${g}`,
      dedupKey: `cost:${g}:${randomUUID()}`, subject: "s", fromAddress: "x@cost.test",
      date: g % 97 === 0 ? null : at, arrivedAt: g % 97 === 0 || g % 3 === 0 ? null : at,
      nativeLocator: { folder: "INBOX", ref: `1:${g}` }, snippet: "", unread: false,
    });
    if (batch.length >= 500) await flush();
  }
  await flush();
  await dialect(w.db).exec(w.db, sql`analyze`);
  return w;
}

async function timed<T>(f: () => Promise<T>): Promise<{ ms: number; out: T }> {
  const t0 = performance.now();
  const out = await f();
  return { ms: performance.now() - t0, out };
}

describe("the History rail over a grown store, in UTC and in a zone", () => {
  it("answers inside its bound on the store this project runs (the phone's 20k, the desktop's 74k)", { timeout: 300_000 }, async () => {
    const probe = await makeCtx(NOW);
    const [rows, months] = dialectOf(probe.db) === "sqlite" ? [20_000, 120] : [74_000, 200];
    const w = await grown(rows, months);
    const svc = new MessageService();
    const utc = await timed(() => svc.timeline(w.ctx));
    const zoned = await timed(() => svc.timeline(w.ctx, { zone: "Europe/Zurich" }));
    console.log(`TIMELINE_COST store=${dialectOf(w.db)} rows=${rows} months=${months} utc_ms=${utc.ms.toFixed(0)} zoned_ms=${zoned.ms.toFixed(0)}`);
    // What the bound is about: the whole account, counted — so a green bound is a real rail.
    expect(utc.out.total).toBe(rows);
    expect(zoned.out.total).toBe(rows);
    expect(utc.out.months.length).toBeGreaterThan(months - 5);
    expect(utc.ms, "the UTC rail scanned the account per month").toBeLessThan(BOUND_MS);
    expect(zoned.ms, "the zoned rail scanned the account per window").toBeLessThan(BOUND_MS);
  });
});
