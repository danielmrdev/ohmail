import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { messages, messageStates, mailboxes } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { syncService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";

/**
 * A CHILD NEVER ARRIVES WITHOUT ITS PARENT — the race, driven.
 *
 * `getSnapshot` reads its message window twice: a keyset SELECT that picks the page's ids, then
 * `materializeMessagesInOrder`, which RE-APPLIES the living-view filter. The child read is keyed
 * on what materialization returned and NOT on the keyset rows, and the whole difference between
 * those two lists is a tombstone committing between them. Key it on the keyset rows instead — the
 * shorter, more obvious line — and a client is handed a pending approval, a routing decision or a
 * triage state for a message it will never receive: a pile entry titled with a bare id, and the
 * cursor moves past the change for ever.
 *
 * ── WHY THIS CANNOT BE A PGlite TEST ─────────────────────────────────────────────────────────
 *
 * The discriminator is what a SECOND connection commits between two statements of one read.
 * `makeTestDb()` is a single-connection PGlite, where two awaited calls are sequential by
 * construction, so a PGlite version of this file could not fail however the child read is keyed.
 *
 * ── THE BARRIER, AND WHY IT IS NOT A TABLE LOCK ──────────────────────────────────────────────
 *
 * `sync-snapshot-seq.pg.test.ts` parks its reader with `LOCK TABLE messages`, which works there
 * because the reader touches `rules` first. It cannot work here: BOTH statements this race sits
 * between read `messages`, so any lock on that table parks the reader ahead of the first one and
 * the window never opens. The reader is parked on its own handle instead — a `then` that resolves
 * the keyset read, waits, and only then hands control back. Everything else is real: a second
 * Postgres connection commits a real tombstone, and the reader's next statement sees it because
 * it is a new snapshot on an autocommit session.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let writer: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const NOW = new Date("2026-09-12T12:00:00.000Z");
const MIN = 60_000;

const ctx = (accountId: string, handle: unknown = db): ServiceContext => ({
  db: handle as ServiceContext["db"], accountId, userId: null,
  now: () => NOW, requestId: "orphan",
});

/**
 * The reader's handle, parked after its Nth awaited `select`. Only the PAUSE is injected: the
 * statements, the connection and the concurrent commit are the real ones.
 */
function gatedDb<T extends object>(base: T, after: number, gate: () => Promise<void>): T {
  let seen = 0;
  let fired = false;
  const wrapBuilder = (b: object): object => new Proxy(b, {
    get(t, p) {
      const v = Reflect.get(t, p, t) as unknown;
      if (p === "then" && typeof v === "function") {
        return (onOk?: (x: unknown) => unknown, onErr?: (e: unknown) => unknown) => {
          seen += 1;
          const mine = !fired && seen === after;
          if (mine) fired = true;
          const run = Promise.resolve(
            (v as (f: (x: unknown) => unknown) => unknown).call(t, (x: unknown) => x),
          );
          const held = mine ? run.then(async (x) => { await gate(); return x; }) : run;
          return held.then(onOk, onErr);
        };
      }
      if (typeof v === "function") {
        return (...a: unknown[]) => {
          const out = (v as (...x: unknown[]) => unknown).apply(t, a);
          return out !== null && typeof out === "object" ? wrapBuilder(out as object) : out;
        };
      }
      return v;
    },
  });
  return new Proxy(base, {
    get(t, p) {
      const v = Reflect.get(t, p, t) as unknown;
      if (p === "select" && typeof v === "function") {
        return (...a: unknown[]) =>
          wrapBuilder((v as (...x: unknown[]) => object).apply(t, a));
      }
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  }) as T;
}

/** Three messages, newest first, each with a `message_states` child. */
async function seed(): Promise<{ accountId: string; ids: string[]; stateIds: string[] }> {
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `orph-${accountId}@tf.example`,
  }).returning();
  const rows = [0, 1, 2].map((i) => ({
    id: randomUUID(),
    accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `orph:${accountId}:${String(i)}`,
    subject: `m-${String(i)}`, fromAddress: "anna@x.example",
    date: new Date(NOW.getTime() - (i + 1) * MIN),
  }));
  await db.insert(messages).values(rows);
  const states = await db.insert(messageStates).values(
    rows.map((r) => ({ accountId, messageId: r.id, state: "reply_later" })),
  ).returning({ id: messageStates.id, messageId: messageStates.messageId });
  return {
    accountId,
    ids: rows.map((r) => r.id),
    stateIds: rows.map((r) => states.find((s) => s.messageId === r.id)!.id),
  };
}

/** Page 1 at limit 1 hands back the cursor page 2 resumes from. */
async function cursorAfterFirst(accountId: string): Promise<string> {
  const page = await syncService.getSnapshot(ctx(accountId), { limit: 1 });
  expect(page.nextCursor, "page 1 did not open a second page").not.toBeNull();
  return page.nextCursor!;
}

describe.skipIf(!PG_UP)("a snapshot child and its parent (real Postgres)", () => {
  beforeAll(async () => {
    client = postgres(PG_TEST_URL, { max: 4 });
    writer = postgres(PG_TEST_URL, { max: 2 });
    db = brandDialect(drizzle(client, { schema }), "pg");
    await runMigrations(PG_TEST_URL);
  }, 180_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await writer?.end({ timeout: 5 });
  });

  it("ORDINARY PAGE: the parent and its child arrive together", async () => {
    // The positive control. Without it the refusal below is satisfied by a page that carries
    // nothing at all.
    const { accountId, ids, stateIds } = await seed();
    const page = await syncService.getSnapshot(ctx(accountId), {
      limit: 1, cursor: await cursorAfterFirst(accountId),
    });
    expect(page.changes.filter((c) => c.type === "message").map((c) => c.id)).toEqual([ids[1]]);
    expect(page.changes.filter((c) => c.type === "message_state").map((c) => c.id))
      .toEqual([stateIds[1]]);
  });

  it("a tombstone committed BETWEEN the two reads takes the child with the parent", async () => {
    const { accountId, ids, stateIds } = await seed();
    const cursor = await cursorAfterFirst(accountId);

    let reached!: () => void;
    let release!: () => void;
    const atBarrier = new Promise<void>((r) => { reached = r; });
    const mayProceed = new Promise<void>((r) => { release = r; });

    // Parked after the FIRST awaited select of this page, which on a cursor page is the keyset
    // read — the page-1 state block does not run.
    const handle = gatedDb(db as unknown as object, 1, async () => {
      reached();
      await mayProceed;
    });
    const reading = syncService.getSnapshot(ctx(accountId, handle), { limit: 1, cursor });

    await atBarrier;
    // A SECOND CONNECTION, a real commit: the message the keyset read just picked is deleted.
    const done = await writer`
      update messages set deleted_at = now() where id = ${ids[1]!}::uuid returning id`;
    expect(done, "the tombstone did not commit — the race was never driven").toHaveLength(1);
    release();

    const page = await reading;
    const kinds = page.changes.map((c) => `${c.type}:${c.id}`);
    // THE PARENT IS GONE, which is correct — materialization re-applies the living view.
    expect(kinds).not.toContain(`message:${ids[1]}`);
    // AND SO IS ITS CHILD. Keying the child read on the keyset rows instead leaves this one
    // behind, with no message on any page of this snapshot and no delta that can repair it.
    expect(kinds, "a child was emitted for a message this snapshot never delivered")
      .not.toContain(`message_state:${stateIds[1]}`);
    expect(page.changes.filter((c) => c.type === "message_state")).toEqual([]);
  }, 60_000);

  it("the barrier really parks the reader — a run without the commit still delivers", async () => {
    // The gate itself gets a control: if the pause were a no-op the refusal above would pass for
    // the wrong reason, and if it parked the reader in the wrong place the commit would land
    // before the keyset read and the parent would never be picked at all.
    const { accountId, ids, stateIds } = await seed();
    const cursor = await cursorAfterFirst(accountId);
    let parked = false;
    const handle = gatedDb(db as unknown as object, 1, async () => { parked = true; });

    const page = await syncService.getSnapshot(ctx(accountId, handle), { limit: 1, cursor });

    expect(parked, "the gate never fired — this file measures nothing").toBe(true);
    expect(page.changes.map((c) => `${c.type}:${c.id}`))
      .toEqual(expect.arrayContaining([`message:${ids[1]}`, `message_state:${stateIds[1]}`]));
  });
});
