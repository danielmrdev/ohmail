import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations } from "../src/migrate.js";
import {
  CHANGE_LOG_CHANNEL, changeWakePayload, parseChangeWake, recordChange, recordChanges,
} from "../src/change-log.js";
import { schema } from "../src/schema.js";
import { pgTestUrl } from "../src/testing.js";

/**
 * THE WAKE CHANNEL, against a REAL Postgres — the one property PGlite cannot witness.
 *
 * `recordChanges` issues `pg_notify` INSIDE the caller's transaction, and everything the wake
 * channel promises rests on Postgres's delivery rule: queued at NOTIFY, delivered at COMMIT,
 * discarded on ROLLBACK. A listener woken before the row is readable would drain and miss it
 * (the poll would catch it later, but the "~1s to visible" promise dies); a listener woken for
 * a rollback drains for nothing. Both directions are asserted here on two physical connections,
 * because a NOTIFY is only observable from a DIFFERENT backend than the one that sent it.
 *
 * The payload discipline is asserted here too: account id and seq, nothing else. NOTIFY
 * payloads can surface in `pg_stat_activity` and server logs, so the day a subject line rides
 * this channel is the day message content reaches the log stream. The shape check is exact.
 */
const URL = pgTestUrl(import.meta.url);

const writerSql = postgres(URL, { max: 5 });
const writer = brandDialect(drizzle(writerSql, { schema }), "pg");
// The listener is a SEPARATE physical connection: same-backend NOTIFY is delivered without the
// wire, so a single-connection test would pass even if in-transaction queueing were broken.
const listenerSql = postgres(URL, { max: 2 });

/** Everything the channel delivered, in order. */
const received: string[] = [];
let unlisten: (() => Promise<void>) | null = null;

const waitFor = async (predicate: () => boolean, ms = 4_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) return;               // the assertion after this says what is missing
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("recordChanges NOTIFYs the wake channel at commit", () => {
  beforeAll(async () => {
    await runMigrations(URL);
    const meta = await listenerSql.listen(CHANGE_LOG_CHANNEL, (payload) => {
      received.push(payload);
    });
    unlisten = meta.unlisten;
  });
  afterAll(async () => {
    await unlisten?.();
    await listenerSql.end({ timeout: 5 });
    await writerSql.end({ timeout: 5 });
  });

  it("one append ⇒ one notification carrying exactly `accountId:seq`, after commit", async () => {
    const acct = randomUUID();
    const seq = await writer.transaction((tx) =>
      recordChange(tx, { accountId: acct, entityType: "message", entityId: randomUUID(), op: "create" }));

    await waitFor(() => received.some((p) => p.startsWith(acct)));
    const mine = received.filter((p) => p.startsWith(acct));
    expect(mine, "the committed append never reached the listener").toHaveLength(1);
    // EXACT shape — the structural half of "no content in the payload, ever". A payload that
    // grew a subject line, a folder or an address would fail the equality, not just a regex.
    expect(mine[0]).toBe(changeWakePayload(acct, seq));
    expect(parseChangeWake(mine[0]!)).toEqual({ accountId: acct, seq });
  });

  it("a BATCH is one notification naming the batch's HIGHEST seq — not one per row", async () => {
    const acct = randomUUID();
    const seqs = await writer.transaction((tx) => recordChanges(tx, [
      { accountId: acct, entityType: "message", entityId: randomUUID(), op: "create" },
      { accountId: acct, entityType: "message", entityId: randomUUID(), op: "create" },
      { accountId: acct, entityType: "rule", entityId: randomUUID(), op: "create" },
    ]));

    await waitFor(() => received.some((p) => p.startsWith(acct)));
    const mine = received.filter((p) => p.startsWith(acct));
    // One frame per recordChanges call: the wake says "drain now", and a drain reads everything,
    // so per-row frames would be pure listener load. The seq is the batch's last.
    expect(mine).toEqual([changeWakePayload(acct, seqs[seqs.length - 1]!)]);
  });

  it("a ROLLBACK delivers NOTHING — the wake cannot name a row that is not there", async () => {
    const acct = randomUUID();
    await expect(writer.transaction(async (tx) => {
      await recordChange(tx, { accountId: acct, entityType: "message", entityId: randomUUID(), op: "create" });
      throw new Error("roll it back");
    })).rejects.toThrow("roll it back");

    // A control append on a SECOND account proves delivery is flowing right now, so the empty
    // read for the rolled-back account below is an absence, not a listener that never worked.
    const control = randomUUID();
    await writer.transaction((tx) =>
      recordChange(tx, { accountId: control, entityType: "message", entityId: randomUUID(), op: "create" }));
    await waitFor(() => received.some((p) => p.startsWith(control)));
    expect(received.some((p) => p.startsWith(control)), "the control frame never arrived").toBe(true);

    expect(received.filter((p) => p.startsWith(acct)), "a rolled-back append woke the channel").toEqual([]);
  });
});

describe("parseChangeWake refuses what it does not recognise", () => {
  it("round-trips its own payloads and rejects foreign ones", () => {
    const acct = randomUUID();
    expect(parseChangeWake(changeWakePayload(acct, 42n))).toEqual({ accountId: acct, seq: 42n });
    for (const bad of ["", ":", "acct:", ":5", "acct", "acct:notanumber", "acct:5x"]) {
      expect(parseChangeWake(bad), `accepted ${JSON.stringify(bad)}`).toBeNull();
    }
  });
});
