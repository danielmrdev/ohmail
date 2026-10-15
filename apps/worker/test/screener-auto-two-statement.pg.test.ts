import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { PgDialect } from "drizzle-orm/pg-core";
import { eq, type SQL } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, folderState, mailboxes, messageBodies, messages, rules, type Tx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { screenerAutoApplyPass } from "../src/screener-auto.js";

/**
 * THE HELD PAGE AND THE CANDIDATE STATEMENT ARE TWO STATEMENTS IN ONE TRANSACTION, and what a second
 * connection commits between them is what the second one decides on. The held page takes no lock;
 * the candidate statement locks `folder_state` and re-reads every predicate, so a row moved out of
 * the Screener in the gap is not re-filed, and a rule added in the gap keeps its sender's row. Real
 * Postgres: PGlite has one connection and `FOR UPDATE` is a no-op there. Each arm has its B-then-A
 * twin (the change committed before the walk) and the untouched page is the control that rows move.
 */

const AVAILABLE = await realPgAvailable();
const SCREENER = "ohmail/Screener";
const STRONG_BULK = { "list-unsubscribe": ["<https://x.test/u>"], "list-id": ["<news.shop.test>"] };
const HELD_TEXT = /^select fs\.message_id from "folder_state" fs/i;

type Db = ReturnType<typeof drizzle<typeof schema>>;

/** `db`, whose transactions run `between` right after the held page returns, inside the same transaction. */
function withGap(db: Db, between: () => Promise<void>): Tx {
  const text = (s: SQL): string => new PgDialect().sqlToQuery(s).sql.trim();
  const wrapTx = (tx: object): object => new Proxy(tx, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop !== "execute" || typeof v !== "function") return v;
      return async (s: SQL) => {
        const out = await (v as (s: SQL) => Promise<unknown>).call(target, s);
        if (HELD_TEXT.test(text(s))) await between();
        return out;
      };
    },
  });
  return new Proxy(db, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop !== "transaction" || typeof v !== "function") return v;
      return (cb: (tx: object) => Promise<unknown>, ...rest: unknown[]) =>
        (v as (...a: unknown[]) => Promise<unknown>).call(target, (tx: object) => cb(wrapTx(tx)), ...rest);
    },
  }) as unknown as Tx;
}

describe.skipIf(!AVAILABLE)("screener auto-apply — what lands between the held page and the candidates", () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let otherSql: ReturnType<typeof postgres>;
  let otherDb: Db;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
    otherSql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    otherDb = brandDialect(drizzle(otherSql, { schema }), "pg");
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await otherSql?.end({ timeout: 5 });
  });

  /** An opted-in account with `n` strong-bulk rows (or plain kept rows) held at the gate, each from its own sender. */
  async function seed(n: number, headers: Record<string, string[]> = STRONG_BULK): Promise<{ accountId: string; ids: string[]; senders: string[] }> {
    const accountId = randomUUID();
    const tag = accountId.slice(0, 8);
    await db.insert(accounts).values({ id: accountId, name: `gap-${tag}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `gap-${tag}@example.test`, status: "connected",
    }).returning();
    await db.insert(accountSettings).values({ accountId, screenerAutoApplyAt: new Date() });
    const ids: string[] = [];
    const senders: string[] = [];
    for (let i = 0; i < n; i++) {
      const from = `news${i}.${tag}@shop.test`;
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id, bodyHash: `gap-${tag}-${i}`, dedupKey: `gap:${tag}:${i}`,
        subject: `newsletter ${i}`, fromAddress: from, nativeLocator: { folder: SCREENER, ref: `1:${i}` },
      }).returning();
      await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers });
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER, lastSetBy: "us",
        reconcileStatus: "reconciled", conflict: false,
      });
      ids.push(m!.id);
      senders.push(from);
    }
    return { accountId, ids, senders };
  }

  const markOf = async (id: string): Promise<number | null> =>
    (await db.select().from(folderState).where(eq(folderState.messageId, id)).limit(1))[0]!.screenerFloorVersion;
  const desiredOf = async (id: string): Promise<string> =>
    (await db.select().from(folderState).where(eq(folderState.messageId, id)).limit(1))[0]!.desiredFolder;
  const moveOut = (id: string) => otherDb.update(folderState)
    .set({ desiredFolder: "INBOX", lastSetBy: "external" }).where(eq(folderState.messageId, id));
  const ruleFor = (accountId: string, sender: string) => otherDb.insert(rules).values({
    accountId, kind: "sender", match: sender, destination: "INBOX", priority: 0, provenance: "user", enabled: true,
  });

  it("the control: with nothing in the gap every held strong-bulk row leaves the Screener", async () => {
    const w = await seed(3);
    const r = await screenerAutoApplyPass(withGap(db, async () => {}), { accountId: w.accountId });
    expect(r).toMatchObject({ ran: true, moved: 3 });
    for (const id of w.ids) expect(await desiredOf(id)).not.toBe(SCREENER);
  });

  it("a row moved out of the Screener between the two statements is not re-filed", async () => {
    const w = await seed(3);
    let fired = 0;
    const r = await screenerAutoApplyPass(withGap(db, async () => {
      if (fired++ === 0) await moveOut(w.ids[1]!);
    }), { accountId: w.accountId });
    expect(fired, "the gap never opened, so this proves nothing").toBeGreaterThan(0);
    expect(r.moved).toBe(2);
    expect(await desiredOf(w.ids[1]!), "the pass filed over the move another writer committed").toBe("INBOX");
  });

  it("…and the same move committed before the walk (B then A) leaves it out as well", async () => {
    const w = await seed(3);
    await moveOut(w.ids[1]!);
    const r = await screenerAutoApplyPass(db as unknown as Tx, { accountId: w.accountId });
    expect(r.moved).toBe(2);
    expect(await desiredOf(w.ids[1]!)).toBe("INBOX");
  });

  it("a rule for a held sender added between the two statements keeps that sender's row", async () => {
    const w = await seed(3);
    let fired = 0;
    const r = await screenerAutoApplyPass(withGap(db, async () => {
      if (fired++ === 0) await ruleFor(w.accountId, w.senders[2]!);
    }), { accountId: w.accountId });
    expect(fired).toBeGreaterThan(0);
    expect(r.moved).toBe(2);
    expect(await desiredOf(w.ids[2]!), "the user's rule was read before it existed").toBe(SCREENER);
  });

  it("…and the same rule committed before the walk (B then A) keeps it as well", async () => {
    const w = await seed(3);
    await ruleFor(w.accountId, w.senders[2]!);
    const r = await screenerAutoApplyPass(db as unknown as Tx, { accountId: w.accountId });
    expect(r.moved).toBe(2);
    expect(await desiredOf(w.ids[2]!)).toBe(SCREENER);
  });

  it("a kept row moved out between the two statements is not marked; the rows that stayed are", async () => {
    const w = await seed(3, {});
    let fired = 0;
    const r = await screenerAutoApplyPass(withGap(db, async () => {
      if (fired++ === 0) await moveOut(w.ids[1]!);
    }), { accountId: w.accountId });
    expect(fired, "the gap never opened, so this proves nothing").toBeGreaterThan(0);
    expect(r).toMatchObject({ moved: 0, kept: 2, marked: 2 });
    expect(await markOf(w.ids[1]!), "a row the candidate statement no longer returned was marked").toBeNull();
    expect(await markOf(w.ids[0]!)).not.toBeNull();
    expect(await desiredOf(w.ids[1]!)).toBe("INBOX");
  });

  it("…and the same move committed before the walk (B then A) leaves it unmarked as well", async () => {
    const w = await seed(3, {});
    await moveOut(w.ids[1]!);
    const r = await screenerAutoApplyPass(db as unknown as Tx, { accountId: w.accountId });
    expect(r).toMatchObject({ kept: 2, marked: 2 });
    expect(await markOf(w.ids[1]!)).toBeNull();
  });
});
