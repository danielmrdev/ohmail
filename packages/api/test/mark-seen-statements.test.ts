import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { changeLog, flagState, messageStates, messages, DECISION_BATCH_MAX } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { MARK_SEEN_MAX_IDS } from "@trafficflow/services";
import { makeDeps, seedMailbox, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * WHAT "MARK ALL READ" COSTS IN STATEMENTS, counted at the store's own client on the real
 * `PATCH /messages` route, in the requests a client sends (`MARK_SEEN_MAX_IDS` ids each). The
 * route wrote each message alone — its update, its read intent and its change row, six statements
 * a message in one transaction holding the account's change counter. The writes now go in sets
 * of DECISION_BATCH_MAX, so two sizes give the slope per SET, and every fact per letter is read.
 */

/** Statements one further set may cost, request overhead included: a ceiling that may only fall. */
const PER_SET_CEILING = 8;

interface Doors { query: (...a: unknown[]) => Promise<unknown>; exec: (...a: unknown[]) => Promise<unknown> }
interface PgliteClient extends Doors { transaction: (cb: (tx: Doors) => Promise<unknown>) => Promise<unknown> }

/** Counts every statement the store is handed while `on` — PGlite's doors, or SQLite's prepare. */
function counter(db: unknown): { on: boolean; n: number; stop: () => void } {
  const c = { on: false, n: 0, stop: () => {} };
  if (dialect(db as never).name === "sqlite") {
    const proto = (createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: { prototype: { prepare: (...a: unknown[]) => unknown } };
    }).DatabaseSync.prototype;
    const prepare = proto.prepare;
    proto.prepare = function (this: unknown, ...a: unknown[]) { if (c.on) c.n += 1; return prepare.apply(this, a); };
    c.stop = () => { proto.prepare = prepare; };
    return c;
  }
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

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/**
 * `letters` unread-or-read messages, and a resurfaced pin on every tenth of the FIRST half — so
 * the later requests clear no pin at all, which is the empty set whose seq must not be NaN.
 */
async function markAllCost(letters: number): Promise<number> {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW });
  const mailboxId = await seedMailbox(db, { accountId: s.accountId });
  const rows = Array.from({ length: letters }, (_x, i) => ({
    id: randomUUID(), accountId: s.accountId, mailboxId, bodyHash: `h${i}`, dedupKey: `ms:${randomUUID()}`,
    subject: `Note ${i}`, snippet: "", fromAddress: `sender-${i}@corp.test`, unread: i % 3 !== 0,
    date: new Date(Date.UTC(2026, 6, 1) + i * 60_000), nativeLocator: { folder: "INBOX", ref: `1:${i}` },
  }));
  for (let i = 0; i < rows.length; i += 250) await db.insert(messages).values(rows.slice(i, i + 250) as never);
  const pinned = rows.filter((_r, i) => i < letters / 2 && i % 10 === 0);
  if (pinned.length > 0) {
    await db.insert(messageStates).values(pinned.map((r) => ({
      accountId: s.accountId, messageId: r.id, state: "resurfaced", bubbleUpAt: null,
    })) as never);
  }
  const ids: string[] = rows.map((r) => r.id);

  const c = counter(db);
  const headers: string[] = [];
  for (let i = 0; i < ids.length; i += MARK_SEEN_MAX_IDS) {
    const body = JSON.stringify({ ids: ids.slice(i, i + MARK_SEEN_MAX_IDS), unread: false });
    c.on = true;
    const res = await H(req("PATCH", "/messages", { bearer: s.token, body }), deps);
    c.on = false;
    expect(res.status).toBe(200);
    headers.push(res.headers.get("x-sync-seq") ?? "(none)");
    // The seq a client resumes from is the last row this request appended — never NaN, never the first.
    const [top] = await db.select({ seq: changeLog.seq }).from(changeLog)
      .where(eq(changeLog.accountId, s.accountId)).orderBy(desc(changeLog.seq)).limit(1);
    expect(headers[headers.length - 1]).toBe(String(top!.seq));
  }
  c.stop();

  // Every letter read, each read intent against its OWN prior state.
  const unread = await db.select({ id: messages.id }).from(messages)
    .where(and(eq(messages.accountId, s.accountId), eq(messages.unread, true)));
  expect(unread).toHaveLength(0);
  const flags = new Map((await db.select().from(flagState).where(inArray(flagState.messageId, ids)))
    .map((f) => [f.messageId, f]));
  for (const r of rows) {
    expect(flags.get(r.id)).toMatchObject({ desiredSeen: true, observedSeen: !r.unread,
      reconcileStatus: r.unread ? "pending" : "reconciled" });
  }

  // Per request: one update row per letter in the order sent, then its cleared pins; seqs contiguous.
  const log = await db.select().from(changeLog)
    .where(eq(changeLog.accountId, s.accountId)).orderBy(asc(changeLog.seq));
  const pinIds = new Map((await db.select({ id: messageStates.id, m: messageStates.messageId }).from(messageStates)
    .where(eq(messageStates.accountId, s.accountId))).map((p) => [p.id, p.m]));
  const expected: string[] = [];
  for (let i = 0; i < ids.length; i += MARK_SEEN_MAX_IDS) {
    const part = ids.slice(i, i + MARK_SEEN_MAX_IDS);
    expected.push(...part.map((id) => `message:${id}`));
    const cleared = log.filter((l) => l.entityType === "message_state" && part.includes(pinIds.get(l.entityId)!));
    expected.push(...cleared.map((l) => `message_state:${pinIds.get(l.entityId)}`));
  }
  expect(log.map((l) => `${l.entityType}:${l.entityType === "message_state" ? pinIds.get(l.entityId) : l.entityId}`))
    .toEqual(expected);
  expect(log.filter((l) => l.entityType === "message_state")).toHaveLength(pinned.length);
  const seqs = log.map((l) => Number(l.seq));
  expect(seqs[seqs.length - 1]! - seqs[0]!).toBe(seqs.length - 1);
  return c.n;
}

const sets = (n: number) => Math.ceil(n / DECISION_BATCH_MAX);

describe("PATCH /messages — mark all read grows with sets, not with letters", () => {
  it(`letter sets of two sizes cost at most ${PER_SET_CEILING} statements a set`, async () => {
    const small = await markAllCost(200);
    const large = await markAllCost(2000);
    const perSet = (large - small) / (sets(2000) - sets(200));
    console.log(`mark all read: 200 -> ${small}, 2000 -> ${large}, ${perSet.toFixed(2)} a set`);
    expect(perSet).toBeLessThanOrEqual(PER_SET_CEILING);
  }, 240_000);
});
