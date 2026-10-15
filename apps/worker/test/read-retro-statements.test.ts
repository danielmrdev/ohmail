import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { asc, eq, inArray } from "drizzle-orm";
import { accounts, changeLog, flagState, folderState, mailboxes, messages, DECISION_BATCH_MAX, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { readStateRetroPass } from "../src/read-retro.js";

/**
 * WHAT THE READ-RETRO PASS COSTS IN STATEMENTS, counted at PGlite's own client on the real pass,
 * driven the way `run-read-retro.ts` drives it: the production batch and budget, invoked again
 * until it stops reporting `capped`. Each row of a page was written alone — its read intent, its
 * `messages` update and its change row, six statements a row. The writes now go in sets of
 * DECISION_BATCH_MAX, so two sizes give the slope per SET, and every fact per letter is read.
 */

/** Statements one further set may cost, page and invocation overhead included: may only fall. */
const PER_SET_CEILING = 7;

interface Doors { query: (...a: unknown[]) => Promise<unknown>; exec: (...a: unknown[]) => Promise<unknown> }
interface PgliteClient extends Doors { transaction: (cb: (tx: Doors) => Promise<unknown>) => Promise<unknown> }

/** Counts every statement PGlite is handed while `on`, the handle a transaction gives included. */
function counter(db: unknown): { on: boolean; n: number } {
  const c = { on: false, n: 0 };
  const client = (db as { $client: PgliteClient }).$client;
  const wrap = <T extends Doors>(t: T): T => {
    for (const door of ["query", "exec"] as const) {
      const inner = t[door].bind(t);
      t[door] = (...a: unknown[]) => { if (c.on) c.n += 1; return inner(...a); };
    }
    return t;
  };
  wrap(client);
  const tx = client.transaction.bind(client);
  client.transaction = (cb) => tx((inner) => cb(wrap(inner)));
  return c;
}

/** `letters` unread messages screened out or quarantined, seeded in sets; the pass run to its end. */
async function retroCost(letters: number): Promise<number> {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `rrs-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `rrs-${accountId.slice(0, 8)}@ohmail.test`,
  }).returning();
  const rows = Array.from({ length: letters }, (_x, i) => ({
    id: randomUUID(), accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `rrs:${randomUUID()}`,
    subject: `Note ${i}`, fromAddress: `sender-${i}@corp.test`, unread: true,
    nativeLocator: { folder: i % 2 === 0 ? "ohmail/Screened" : "ohmail/Quarantine", ref: `1:${i}` },
  }));
  for (let i = 0; i < rows.length; i += 250) {
    const part = rows.slice(i, i + 250);
    await db.insert(messages).values(part);
    await db.insert(folderState).values(part.map((r) => ({
      messageId: r.id, desiredFolder: r.nativeLocator.folder, observedFolder: r.nativeLocator.folder,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    })));
  }

  const c = counter(db);
  let marked = 0;
  for (let runs = 0; runs < 100; runs++) {
    c.on = true;
    const r = await readStateRetroPass(db, { accountId, mailboxId: mb!.id });
    c.on = false;
    marked += r.marked;
    if (!r.capped) break;
  }
  expect(marked).toBe(letters);

  const ids = rows.map((r) => r.id);
  const unread = await db.select({ id: messages.id }).from(messages)
    .where(eq(messages.unread, true));
  expect(unread).toHaveLength(0);
  const flags = await db.select().from(flagState).where(inArray(flagState.messageId, ids));
  expect(flags).toHaveLength(letters);
  for (const f of flags) expect(f).toMatchObject({ desiredSeen: true, observedSeen: false, reconcileStatus: "pending" });
  // One update row per letter, in the pass's own walk (id order), at contiguous seqs.
  const log = await db.select().from(changeLog).where(eq(changeLog.accountId, accountId)).orderBy(asc(changeLog.seq));
  expect(log.map((l) => `${l.op}:${l.entityId}`)).toEqual([...ids].sort().map((id) => `update:${id}`));
  const seqs = log.map((l) => Number(l.seq));
  expect(seqs[seqs.length - 1]! - seqs[0]!).toBe(seqs.length - 1);
  return c.n;
}

const sets = (n: number) => Math.ceil(n / DECISION_BATCH_MAX);

describe("the read-retro pass grows with sets, not with letters", () => {
  it(`letter sets of two sizes cost at most ${PER_SET_CEILING} statements a set`, async () => {
    const small = await retroCost(200);
    const large = await retroCost(2000);
    const perSet = (large - small) / (sets(2000) - sets(200));
    console.log(`read retro: 200 -> ${small}, 2000 -> ${large}, ${perSet.toFixed(2)} a set`);
    expect(perSet).toBeLessThanOrEqual(PER_SET_CEILING);
  }, 240_000);
});
