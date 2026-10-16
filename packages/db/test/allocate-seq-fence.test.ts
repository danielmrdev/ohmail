import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import { allocateSeqRange, recordChanges, type MailboxMustBeLive } from "../src/change-log.js";
import { MailboxErasedError } from "../src/erasure-fence.js";
import { dialect } from "../src/dialect/index.js";
import { accountSyncState, changeLog, mailboxes } from "../src/schema.js";

/**
 * THE MAILBOX QUESTION THE ALLOCATION CARRIES — `allocateSeqRange`'s optional fourth argument.
 *
 * The ingest's removal fence is a locked read of `mailboxes.status` inside the commit's own
 * transaction; folded here it costs no statement of its own. Two properties, and the file exists
 * for the second as much as the first: the fence ANSWERS (with the status under the row lock, once
 * per allocation, refusing by whatever the caller throws), and a writer that asks nothing sends
 * the statements it always sent — the allocator is shared by every writer on the account.
 */
const ACCOUNT = "00000000-0000-4000-8000-0000000000fe";

type Db = Awaited<ReturnType<typeof makeTestDb>>;

/** A fence that records what it was told and refuses the way the ingest's own decider does. */
function fenceOn(mailboxId: string): MailboxMustBeLive & { seen: (string | null)[] } {
  const seen: (string | null)[] = [];
  return {
    mailboxId,
    seen,
    answer(status) {
      seen.push(status);
      if (status === null || status === "disabled") throw new Error(`refused: ${String(status)}`);
    },
  };
}

async function seedMailbox(db: Db, status?: string): Promise<string> {
  const [mb] = await db.insert(mailboxes).values({
    accountId: ACCOUNT, provider: "imap", address: `fence-${Math.random().toString(16).slice(2)}@x.test`,
    ...(status ? { status } : {}),
  }).returning();
  return mb!.id;
}

/** Every statement the store was asked for, including the ones a transaction handle carries. */
interface Doors { query: (...a: unknown[]) => Promise<unknown>; exec: (...a: unknown[]) => Promise<unknown> }
type Client = Doors & { transaction: (cb: (tx: Doors) => Promise<unknown>) => Promise<unknown> };

/** The server store's client, or `null` where the handle has no such door — see the case below. */
function clientOf(db: Db): Client | null {
  const client = (db as unknown as { $client?: Partial<Client> }).$client;
  return typeof client?.query === "function" && typeof client.transaction === "function"
    ? client as Client : null;
}

function recordStatements(client: Client): string[] {
  const seen: string[] = [];
  const instrument = <T extends Doors>(target: T): T => {
    for (const door of ["query", "exec"] as const) {
      const inner = target[door].bind(target);
      target[door] = (...a: unknown[]): Promise<unknown> => {
        if (typeof a[0] === "string") seen.push(a[0]);
        return inner(...(a as []));
      };
    }
    return target;
  };
  instrument(client);
  const innerTx = client.transaction.bind(client);
  client.transaction = (cb) => innerTx((tx) => cb(instrument(tx)));
  return seen;
}

describe("allocateSeqRange's mailbox fence", () => {
  it("answers with the status ONCE and hands back the same block of seqs", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const fence = fenceOn(mailboxId);
    const seqs = await db.transaction((tx) => allocateSeqRange(tx, ACCOUNT, 3, fence));
    expect(seqs, "the folded allocation stopped handing back a consecutive block").toEqual([1n, 2n, 3n]);
    expect(fence.seen, "the fence was asked twice, or not at all").toEqual(["connected"]);
    const [state] = await db.select().from(accountSyncState).where(eq(accountSyncState.accountId, ACCOUNT));
    expect(state!.nextSeq).toBe(3n);
  });

  it("REFUSES on a removed mailbox, and spends no seq doing it", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db, "disabled");
    const fence = fenceOn(mailboxId);
    await expect(db.transaction((tx) => allocateSeqRange(tx, ACCOUNT, 1, fence)))
      .rejects.toThrow("refused: disabled");
    expect(fence.seen).toEqual(["disabled"]);
    const state = await db.select().from(accountSyncState).where(eq(accountSyncState.accountId, ACCOUNT));
    expect(state[0]?.nextSeq ?? 0n, "the refused allocation moved the counter").toBe(0n);
  });

  it("REFUSES a mailbox that is not there at all — the erasure sweep's answer", async () => {
    const db = await makeTestDb();
    const fence = fenceOn("00000000-0000-4000-8000-00000000dead");
    await expect(db.transaction((tx) => allocateSeqRange(tx, ACCOUNT, 1, fence)))
      .rejects.toThrow("refused: null");
    expect(fence.seen).toEqual([null]);
  });

  it("REFUSES an ERASED mailbox itself, before the caller is told a status at all", async () => {
    /* THE SECOND STAMP THE ONE READ CARRIES. `status` travels back unjudged — the ingest admits
       `error`, which is the ordinary state a recovering cycle commits from — but `erased_at` is
       the seam's own question and is decided here, so a caller that would have admitted the row
       beside it never sees one. It is what makes the ingest's write door free: the door hands this
       carrier over instead of sending a locked read of its own per message. */
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    await db.update(mailboxes).set({ erasedAt: new Date() }).where(eq(mailboxes.id, mailboxId));
    const fence = fenceOn(mailboxId);
    await expect(db.transaction((tx) => allocateSeqRange(tx, ACCOUNT, 1, fence)))
      .rejects.toBeInstanceOf(MailboxErasedError);
    expect(fence.seen, "the caller's decider was handed a status for an erased mailbox").toEqual([]);
    const state = await db.select().from(accountSyncState).where(eq(accountSyncState.accountId, ACCOUNT));
    expect(state[0]?.nextSeq ?? 0n, "the refused allocation moved the counter").toBe(0n);
    const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(mb!.status, "the removal arm could have answered this").toBe("connected");
  });

  it("carries the refusal out of recordChanges, with no change_log row behind it", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db, "disabled");
    await expect(db.transaction((tx) => recordChanges(tx, [{
      accountId: ACCOUNT, entityType: "message", entityId: "00000000-0000-4000-8000-00000000beef",
      op: "create", meta: null,
    }], fenceOn(mailboxId)))).rejects.toThrow("refused: disabled");
    expect(await db.select().from(changeLog).where(eq(changeLog.accountId, ACCOUNT))).toHaveLength(0);
  });

  it("leaves a writer that asks nothing with the statements it always sent", async () => {
    const db = await makeTestDb();
    const client = clientOf(db);
    if (!client) {
      /* THE DEVICE STORE'S HANDLE HAS NO SUCH DOOR, so its statements cannot be read as text here.
         Stated rather than skipped: the four cases above run on this store and exercise its own
         arm of the allocator; only the server's one-statement shape is measured below. */
      expect(dialect(db).name, "a store with no client doors that is not the device one").toBe("sqlite");
      return;
    }
    const mailboxId = await seedMailbox(db);
    const seen = recordStatements(client);

    await db.transaction((tx) => allocateSeqRange(tx, ACCOUNT, 1));
    const plain = seen.splice(0, seen.length).filter((s) => /account_sync_state/i.test(s));
    expect(plain.some((s) => /mailboxes/i.test(s)),
      "an allocation nobody fenced named the mailboxes table — every writer on the account shares "
      + "this statement").toBe(false);
    expect(plain.length, "the unfenced allocation changed shape: guard insert + counter update")
      .toBe(2);

    await db.transaction((tx) => allocateSeqRange(tx, ACCOUNT, 1, fenceOn(mailboxId)));
    const fenced = seen.splice(0, seen.length);
    const asks = fenced.filter((s) => /mailboxes/i.test(s));
    expect(asks, "the fenced allocation asked about the mailbox more than once").toHaveLength(1);
    if (dialect(db).name === "sqlite") {
      /* The device store has no data-modifying CTE, and no second writer to order against: the
         question is answered by a read of its own, which is what the standing fence cost anyway. */
      expect(/update/i.test(asks[0]!), "the device arm grew a fold it cannot run").toBe(false);
      return;
    }
    // THE SAVING, in one assertion: the statement that moves the counter is the statement that
    // asks about the mailbox. Two statements here would be the round trip this change removed.
    expect(/update[\s\S]*account_sync_state/i.test(asks[0]!),
      "the fence rode in a statement of its own again — the fold is the whole point").toBe(true);
  });
});
