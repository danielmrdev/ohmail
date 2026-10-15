import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, getTableName, inArray, type SQL } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, mailboxes, messageBodies, messages } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { deleteAccount, type ServiceContext } from "../src/index.js";

/**
 * AN ERASURE NO CONCURRENT INGEST CAN REFUSE.
 *
 * Measured on a first sync: `DELETE /account` answered 500, Postgres 23503 on
 * `message_bodies_message_id_messages_id_fk`. The erasure deletes the bodies, an ingest commits a
 * NEW message with its body, and the erasure's `messages` delete then takes that message and is
 * refused by the body it never saw. Every ingest commit takes the mailbox row first (the lease
 * fence, the liveness read, or the insert's own key), so the erasure takes the account's mailbox
 * rows `FOR UPDATE` before any delete: an ingest in flight finishes first and is swept, a later
 * one waits and is refused by the parent it no longer has. Both orders are driven here.
 */
const PG_UP = await realPgAvailable();

const NOW = new Date("2026-09-26T16:00:00.000Z");
let owned: OwnedDb;
/** The worker's connection: an ingest is another process's transaction, never the erasure's. */
let ingest: OwnedDb;

beforeAll(async () => {
  if (!PG_UP) return;
  await runMigrations(PG_TEST_URL);
  owned = makeOwnedDb(PG_TEST_URL);
  ingest = makeOwnedDb(PG_TEST_URL);
}, 120_000);

afterAll(async () => {
  await Promise.all([owned?.close(), ingest?.close()]);
}, 60_000);

interface Seeded { accountId: string; mailboxId: string }

/** An account whose first sync has stored one message and its body. */
async function seeded(): Promise<Seeded> {
  const [a] = await owned.db.insert(accounts)
    .values({ name: `erase-ingest-${randomUUID().slice(0, 8)}` }).returning();
  const [mb] = await owned.db.insert(mailboxes).values({
    accountId: a!.id, provider: "imap", address: `ei-${randomUUID().slice(0, 8)}@x.test`,
    status: "connected", organizerRole: "organizer",
  }).returning();
  const s = { accountId: a!.id, mailboxId: mb!.id };
  const repo = makeDrizzleRepo(owned.db);
  await repo.transaction(async (tx) => {
    const m = await tx.insertMessage(messageFor(s));
    await tx.insertMessageBody(m.id, BODY, { accountId: s.accountId, capBytes: null });
  });
  return s;
}

const BODY = { text: "the whole letter", html: null, headers: {} };

/**
 * The worker's new-message shape: the carrier for THIS mailbox, so the door asks no fence read of
 * its own and the first lock on the mailbox is the insert's key check — the weakest any commit takes.
 */
const messageFor = (s: Seeded) => ({ senderCheck: null,
  accountId: s.accountId, mailboxId: s.mailboxId,
  canonical: { messageIdHeader: `<${randomUUID()}@x.test>`, bodyHash: randomUUID() },
  dedupKey: randomUUID(), subject: "the kiln", fromAddress: "them@x.test", date: NOW,
  nativeLocator: { folder: "INBOX", ref: `1:${Math.floor(Math.random() * 1e6) + 2}` },
  flags: { no_ai: false, no_forward: false, no_kb: false, priority: false },
  mailboxMustBeLive: { mailboxId: s.mailboxId, answer: () => { /* the allocation's half */ } },
});

const ctxFor = (accountId: string, db: unknown): ServiceContext => ({
  db: db as ServiceContext["db"],
  accountId,
  userId: null,
  now: () => NOW,
  requestId: `erase-ingest-${randomUUID()}`,
} as ServiceContext);

/**
 * `owned.db` with ONE seam: `hook` runs after the erasure's `message_bodies` delete and before its
 * `messages` delete — the window the measured 23503 needs. Everything else passes through.
 */
function hookBeforeMessagesDelete(hook: () => Promise<void>): unknown {
  let fired = false;
  const db = owned.db as unknown as { transaction: (fn: (tx: object) => Promise<unknown>) => Promise<unknown> };
  return new Proxy(db, {
    get(target, key) {
      if (key !== "transaction") {
        const v = Reflect.get(target, key, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      }
      return (fn: (tx: object) => Promise<unknown>) => target.transaction((tx) => fn(new Proxy(tx, {
        get(t, k) {
          const v = Reflect.get(t, k, t) as unknown;
          if (k !== "delete") return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
          return (table: Parameters<typeof getTableName>[0]) => {
            const builder = (v as (x: unknown) => { where: (c: SQL) => unknown }).call(t, table);
            if (fired || getTableName(table) !== "messages") return builder;
            fired = true;
            return { where: (cond: SQL) => hook().then(() => builder.where(cond)) };
          };
        },
      })));
    },
  });
}

/** Everything of the account's mail still standing — messages and the bodies keyed off them. */
async function mailLeft(accountId: string): Promise<{ messages: number; bodies: number }> {
  const ids = (await owned.db.select({ id: messages.id }).from(messages)
    .where(eq(messages.accountId, accountId))).map((r) => r.id);
  const bodies = ids.length === 0 ? 0
    : (await owned.db.select({ id: messageBodies.id }).from(messageBodies)
      .where(inArray(messageBodies.messageId, ids))).length;
  return { messages: ids.length, bodies };
}

const sleep = (ms: number) => new Promise<"waiting">((r) => setTimeout(() => r("waiting"), ms));
const pgCode = (e: unknown): string | undefined => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code ?? err?.cause?.code;
};
const pgConstraint = (e: unknown): string | undefined => {
  const err = e as { constraint_name?: string; cause?: { constraint_name?: string } } | null;
  return err?.constraint_name ?? err?.cause?.constraint_name;
};

describe.skipIf(!PG_UP)("an account erasure against an ingest on another connection", () => {
  it("AFTER — an ingest arriving mid-erasure waits, is refused, and the erasure commits", async () => {
    const s = await seeded();
    let writer: Promise<string> | null = null;
    let seenMidErase: "committed" | "refused" | "waiting" | null = null;
    const db = hookBeforeMessagesDelete(async () => {
      writer = makeDrizzleRepo(ingest.db).transaction(async (repo) => {
        const m = await repo.insertMessage(messageFor(s));
        await repo.insertMessageBody(m.id, BODY, { accountId: s.accountId, capBytes: null });
        return m.id;
      });
      seenMidErase = await Promise.race([
        writer.then(() => "committed" as const, () => "refused" as const), sleep(1500),
      ]);
    });

    const erased = await deleteAccount(ctxFor(s.accountId, db)).then(() => null, (e: unknown) => e);
    expect(writer, "the seam never ran: the hook did not reach the messages delete").not.toBeNull();
    const late = await writer!.then(() => null, (e: unknown) => e);

    expect(erased === null ? null : `${pgCode(erased)} ${pgConstraint(erased)}`,
      "the erasure was refused by a row an ingest committed under it").toBeNull();
    expect(seenMidErase, "the ingest was not ordered behind the erasure").toBe("waiting");
    expect(pgCode(late), "the late ingest must be refused by the parent it no longer has").toBe("23503");
    expect(await mailLeft(s.accountId)).toEqual({ messages: 0, bodies: 0 });
  }, 60_000);

  it("BEFORE — an ingest already in flight commits first, and the erasure sweeps what it wrote", async () => {
    const s = await seeded();
    let inserted!: () => void;
    const holding = new Promise<void>((r) => { inserted = r; });
    let release!: () => void;
    const mayCommit = new Promise<void>((r) => { release = r; });

    const writer = makeDrizzleRepo(ingest.db).transaction(async (repo) => {
      const m = await repo.insertMessage(messageFor(s));
      inserted();
      await mayCommit;
      await repo.insertMessageBody(m.id, BODY, { accountId: s.accountId, capBytes: null });
      return m.id;
    });
    await holding;

    const erasure = deleteAccount(ctxFor(s.accountId, owned.db)).then(() => null, (e: unknown) => e);
    const early = await Promise.race([erasure.then(() => "settled" as const), sleep(1000)]);
    release();

    const written = await writer.then(() => "committed", (e: unknown) => `refused ${pgCode(e)}`);
    const erased = await erasure;

    expect(written, "the in-flight ingest is not the side that loses").toBe("committed");
    expect(early, "the erasure did not wait for the transaction holding the mailbox").toBe("waiting");
    expect(erased === null ? null : `${pgCode(erased)} ${pgConstraint(erased)}`,
      "the erasure was refused by a row an ingest committed under it").toBeNull();
    expect(await mailLeft(s.accountId)).toEqual({ messages: 0, bodies: 0 });
  }, 60_000);

  it("the ordinary erasure with no ingest running is admitted and empties the mailbox", async () => {
    const s = await seeded();
    expect(await mailLeft(s.accountId)).toEqual({ messages: 1, bodies: 1 });
    await deleteAccount(ctxFor(s.accountId, owned.db));
    expect(await mailLeft(s.accountId)).toEqual({ messages: 0, bodies: 0 });
    const [mb] = await owned.db.select().from(mailboxes).where(eq(mailboxes.id, s.mailboxId));
    expect(mb, "the mailbox row goes with the account").toBeUndefined();
  }, 60_000);
});
