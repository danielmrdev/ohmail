import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { accounts, mailboxes, messageInstances, messages, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo, type WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { Change, ChangeBatch, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { DELETE_EVIDENCE_PER_CYCLE, runSyncCycle } from "../src/sync.js";

/**
 * A FOLDER THE SERVER SAYS DOES NOT EXIST IS FORGOTTEN WHOLE, IN ONE TRANSACTION.
 *
 * The adapter names the folder in `foldersGone` with a delete per remembered letter; the cycle
 * forgets them in one fenced write and outside the per-cycle delete cap, then the reaper takes the
 * rows. A fault on the second forget leaves every instance; a folder past the cap goes in one
 * cycle. Mutation: route those deletes through the ordinary capped loop and both arms go red.
 * A reset's proved deletes ride the same door at their old epoch.
 */

const EPOCH = "7";

async function seeded(n: number) {
  const db = (await makeTestDb()) as unknown as Tx;
  const [a] = await db.insert(accounts).values({ name: "folder-gone-one-transaction" }).returning();
  const accountId = a!.id;
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `t-${accountId.slice(0, 8)}@example.test` }).returning();
  const mailboxId = mb!.id;
  const plant = async (uid: number, folder: string) => {
    const key = `g${uid}-${folder}@example.test`;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId, messageIdHeader: key, bodyHash: key, dedupKey: `mid:<${key}>`,
      subject: "filed", fromAddress: "anna@example.test", nativeLocator: { folder, ref: `${EPOCH}:${uid}` },
    }).returning();
    await db.insert(messageInstances).values({
      accountId, mailboxId, messageId: m!.id, folder, uidvalidity: BigInt(EPOCH), uid, isPrimary: true,
    });
  };
  for (let uid = 1; uid <= n; uid++) await plant(uid, "Projects");
  await plant(1, "INBOX");
  const instancesIn = async (folder: string) => (await db.select({ id: messageInstances.id }).from(messageInstances)
    .where(and(eq(messageInstances.mailboxId, mailboxId), eq(messageInstances.folder, folder)))).length;
  const uidsIn = async (folder: string) => (await db.select({ uid: messageInstances.uid }).from(messageInstances)
    .where(and(eq(messageInstances.mailboxId, mailboxId), eq(messageInstances.folder, folder)))).map((r) => r.uid).sort();
  const live = async () => (await db.select({ id: messages.id }).from(messages)
    .where(and(eq(messages.mailboxId, mailboxId), isNull(messages.deletedAt)))).length;
  return { db, accountId, mailboxId, repo: makeDrizzleRepo(db), instancesIn, uidsIn, live };
}

function goneBatch(n: number): MailboxAdapter {
  const deletes: Change[] = Array.from({ length: n }, (_, i) => ({
    type: "delete", locator: { folder: "Projects", ref: `${EPOCH}:${i + 1}` },
  }));
  const batch: ChangeBatch = {
    creates: [], moves: [], flagChanges: [], deletes, hasBacklog: false, foldersGone: ["Projects"],
    newCursor: { folders: { Projects: { uidValidity: EPOCH, uidNext: n + 1, highestModseq: "0" } } },
  };
  return { changesSince: async () => batch } as unknown as MailboxAdapter;
}

/** The repo, with `forgetInstanceAt` failing on its second call wherever the cycle makes it. */
function failingSecondForget<R extends object>(repo: R): R {
  let calls = 0;
  const wrap = (target: R): R => new Proxy(target, {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, recv) as unknown;
      if (typeof v !== "function") return v;
      if (prop === "forgetInstanceAt") {
        return async (...args: unknown[]) => {
          if (++calls === 2) throw new Error("the second forget failed");
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      }
      if (prop === "transaction") {
        return (fn: (r: R) => Promise<unknown>): unknown =>
          (v as (f: (r: R) => Promise<unknown>) => unknown).call(t, (inner) => fn(wrap(inner)));
      }
      return (v as (...a: unknown[]) => unknown).bind(t);
    },
  }) as R;
  return wrap(repo);
}

const cycle = (repo: WorkerRepo, adapter: MailboxAdapter, s: { accountId: string; mailboxId: string }) => runSyncCycle({
  repo, adapter, accountId: s.accountId, mailboxId: s.mailboxId, role: "reader",
  writeAuthority: { noLease: "reader" as const }, storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(),
});

describe("a folder the server says does not exist", () => {
  it("is forgotten in one transaction: a fault on the second letter leaves every instance", async () => {
    const s = await seeded(3);
    await expect(cycle(failingSecondForget(s.repo), goneBatch(3), s)).rejects.toThrow(/second forget/);
    expect(await s.instancesIn("Projects"), "a fault mid-folder left the folder half forgotten").toBe(3);
    // Positive control: the same batch with no fault forgets the folder and reaps its rows.
    await cycle(s.repo, goneBatch(3), s);
    expect(await s.instancesIn("Projects")).toBe(0);
    expect(await s.live(), "the letter in INBOX was taken with the folder").toBe(1);
  });

  it("a reset's proved delete is believed at its old epoch; the ordinary one there is not", async () => {
    const s = await seeded(2);
    const at = (ref: string): Change => ({ type: "delete", locator: { folder: "Projects", ref } });
    const batch: ChangeBatch = {
      creates: [], moves: [], flagChanges: [], deletes: [at(`${EPOCH}:2`)], resetGone: [at(`${EPOCH}:1`)], hasBacklog: false,
      newCursor: { folders: { Projects: { uidValidity: "8", uidNext: 1, highestModseq: "0" } } },
    };
    await cycle(s.repo, { changesSince: async () => batch } as unknown as MailboxAdapter, s);
    expect(await s.uidsIn("Projects"), "the proved letter stayed, or the epoch guard let the other one go").toEqual([2]);
  });

  it("is forgotten whole in one cycle, past the per-cycle delete cap", async () => {
    const n = DELETE_EVIDENCE_PER_CYCLE + 3;
    const s = await seeded(n);
    await cycle(s.repo, goneBatch(n), s);
    expect(await s.instancesIn("Projects"), "the cap stranded part of a folder the server said is gone").toBe(0);
    expect(await s.instancesIn("INBOX")).toBe(1);
  }, 120_000);
});
