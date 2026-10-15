import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeTestDb } from "@trafficflow/db/testing";
import { dialect } from "@trafficflow/db/dialect";
import { HOT_PATH_INDEX_SPECS } from "@trafficflow/db/admin";
import { eq, inArray } from "drizzle-orm";
import {
  accountSettings, accounts, folderState, mailboxes, messageBodies, messages, type Tx,
} from "@trafficflow/db";
import {
  HELD_PAGE_PREDICATE, SCREENER_FLOOR_WITHDRAW_LIMIT, floorMarkSql, heldPageSql, newScreenerAutoWalk,
  screenerAutoApplyPass, staleFloorWithdrawSql,
} from "../src/screener-auto.js";

/**
 * THE AUTO-APPLY WALK PAGES OVER HELD IDS. A full walk reads one page of held ids by
 * `folder_state.message_id` from its cursor, then asks the candidate statement about exactly those.
 * Both statements have one text each: the held page's folder predicate and limit are literals (the
 * partial hot-path index is provable only against constants), the candidate statement takes its ids
 * as one array. The walk ends on a short held page; the cursor is the last held id. A kept row read
 * with no strong-bulk floor is MARKED (`screener_floor_version`) and no later walk reads it again.
 */

const SCREENER = "ohmail/Screener";

interface Doors { query: (...a: unknown[]) => Promise<unknown>; exec: (...a: unknown[]) => Promise<unknown> }
type Client = Doors & { transaction: (cb: (tx: Doors) => Promise<unknown>) => Promise<unknown> };

/** Every statement text the PGlite client runs, the ones inside a transaction included. */
function recordStatements(db: Tx): string[] {
  const client = (db as unknown as { $client: Client }).$client;
  const seen: string[] = [];
  const instrument = <T extends Doors>(t: T): T => {
    for (const door of ["query", "exec"] as const) {
      const inner = t[door].bind(t);
      t[door] = (...a: unknown[]) => { if (typeof a[0] === "string") seen.push(a[0]); return inner(...(a as [])); };
    }
    return t;
  };
  instrument(client);
  const innerTx = client.transaction.bind(client);
  client.transaction = (cb) => innerTx((tx) => cb(instrument(tx)));
  return seen;
}
const isCandidate = (s: string): boolean => /for update of "folder_state"/i.test(s);
const isHeld = (s: string): boolean => /^select fs\.message_id from "folder_state" fs/i.test(s.trim());

describe("the held page", () => {
  it("spells the folder predicate and the limit as literals, and carries two parameters", () => {
    const q = new PgDialect().sqlToQuery(heldPageSql({ accountId: randomUUID(), afterId: null, limit: 100 }));
    expect(q.sql).toContain("fs.desired_folder = 'ohmail/Screener' and fs.last_set_by = 'us'");
    // The index key, version then id: ordered by the id alone the planner walks the unique index.
    expect(q.sql).toMatch(/order by fs\.screener_floor_version, fs\.message_id limit 100$/);
    expect(q.sql).toContain("and fs.screener_floor_version is null");
    expect(q.params).toHaveLength(2);
    const later = new PgDialect().sqlToQuery(heldPageSql({ accountId: randomUUID(), afterId: randomUUID(), limit: 100 }));
    expect(later.sql, "the first page and a later one are two statements").toBe(q.sql);
  });

  it("names the same two values the hot-path index is partial on", () => {
    const spec = HOT_PATH_INDEX_SPECS.find((s) => s.name === "folder_state_screener_held_floor_idx");
    expect(spec, "the held page's index is not a hot-path spec").toBeDefined();
    expect(spec!.requiresColumn).toBe("screener_floor_version");
    const ddl = new PgDialect().sqlToQuery(spec!.ddl).sql;
    expect(ddl).toContain(`"desired_folder" = '${HELD_PAGE_PREDICATE.folder}'`);
    expect(ddl).toContain(`"last_set_by" = '${HELD_PAGE_PREDICATE.setBy}'`);
    expect(ddl).toContain(`on public.folder_state using btree ("screener_floor_version","message_id")`);
    expect(HOT_PATH_INDEX_SPECS.map((x) => x.name), "the old spec left the list").not.toContain("folder_state_screener_held_idx");
  });

  it("the mark writes one column at a literal version, over one array of ids", () => {
    const q = new PgDialect().sqlToQuery(floorMarkSql({ ids: [randomUUID(), randomUUID()], version: 3 }));
    expect(q.sql).toMatch(/^update "folder_state" set screener_floor_version = 3\s+where /);
    expect(q.sql.match(/ set (.*?)\s+where /)![1], "the SET list is one column").toBe("screener_floor_version = 3");
    expect(q.sql).not.toMatch(/updated_at/);
    expect(q.sql).toContain("is distinct from 3");
    expect(q.params).toHaveLength(1);
    expect(Array.isArray(q.params[0])).toBe(true);
    const w = new PgDialect().sqlToQuery(staleFloorWithdrawSql({ accountId: randomUUID(), version: 3 }));
    expect(w.sql).toContain("fs.desired_folder = 'ohmail/Screener' and fs.last_set_by = 'us'");
    expect(w.sql).toContain("(fs.screener_floor_version < 3 or fs.screener_floor_version > 3)");
    expect(w.sql).toContain(`limit ${SCREENER_FLOOR_WITHDRAW_LIMIT})`);
    expect(SCREENER_FLOOR_WITHDRAW_LIMIT).toBe(1000);
    expect(w.params).toHaveLength(1);
    expect(() => floorMarkSql({ ids: [], version: 0 })).toThrow();
  });

  it("refuses a limit that is not a page", () => {
    expect(() => heldPageSql({ accountId: randomUUID(), afterId: null, limit: 0 })).toThrow();
    expect(() => heldPageSql({ accountId: randomUUID(), afterId: null, limit: 1.5 })).toThrow();
  });
});

describe("the auto-apply walk over held pages", () => {
  let db: Tx;
  let seen: string[];

  beforeAll(async () => {
    db = (await makeTestDb()) as unknown as Tx;
    seen = recordStatements(db);
  });

  async function world(tag: string): Promise<{ accountId: string; mailboxId: string; tag: string }> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `held-${tag}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `${tag}-${accountId.slice(0, 6)}@example.test`, organizerRole: "organizer",
    }).returning();
    await db.insert(accountSettings).values({ accountId, screenerAutoApplyAt: new Date() });
    return { accountId, mailboxId: mb!.id, tag };
  }

  /** A kept stranger held at the gate: no list headers, so the floor keeps it. */
  async function held(
    w: { accountId: string; mailboxId: string; tag: string }, key: string, id?: string,
    o: { body?: boolean; noAi?: boolean; bulk?: boolean } = {},
  ): Promise<string> {
    const [m] = await db.insert(messages).values({
      ...(id ? { id } : {}),
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h", dedupKey: `held:${w.tag}:${key}`,
      subject: key, fromAddress: `${key}@sender.test`, nativeLocator: { folder: SCREENER, ref: `1:${key}` },
      ...(o.noAi ? { noAi: true } : {}),
    }).returning();
    if (o.body !== false) await body(m!.id, o.bulk === true);
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER, lastSetBy: "us",
      reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  }

  /** The body row: a strong-bulk floor (List-Unsubscribe + List-Id) when `bulk`, else none. */
  async function body(messageId: string, bulk: boolean): Promise<void> {
    await db.insert(messageBodies).values({
      messageId, text: "", html: null,
      headers: bulk ? { "list-unsubscribe": ["<https://u.example.test/x>"], "list-id": ["<l.example.test>"] } : {},
    });
  }

  async function versions(ids: readonly string[]): Promise<(number | null)[]> {
    const rows = await db.select({ id: folderState.messageId, v: folderState.screenerFloorVersion })
      .from(folderState).where(inArray(folderState.messageId, [...ids]));
    const by = new Map(rows.map((r) => [r.id, r.v]));
    return ids.map((id) => by.get(id) ?? null);
  }
  async function desired(id: string): Promise<string> {
    const [r] = await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id));
    return r!.d;
  }

  it("a full walk over kept rows spanning three pages reads three held pages and three candidate pages, then ends", async () => {
    const w = await world("full");
    for (let i = 0; i < 250; i++) await held(w, `kept${i}`);
    const at = seen.length;
    const r = await screenerAutoApplyPass(db, { accountId: w.accountId });
    expect(r).toMatchObject({ mode: "full", examined: 250, moved: 0, kept: 250, capped: false });
    const run = seen.slice(at);
    expect(run.filter(isHeld)).toHaveLength(3);
    expect(run.filter(isCandidate)).toHaveLength(3);
    expect(new Set(run.filter(isHeld)).size, "the held page is one statement text").toBe(1);
    expect(new Set(run.filter(isCandidate)).size, "a page of 100 ids and one of 50 are two texts").toBe(1);
  });

  it("a second full walk over the same kept rows reads one empty held page and no candidate statement", async () => {
    const w = await world("again");
    for (let i = 0; i < 250; i++) await held(w, `kept${i}`);
    const first = await screenerAutoApplyPass(db, { accountId: w.accountId });
    expect(first).toMatchObject({ mode: "full", kept: 250, marked: 250 });
    const at = seen.length;
    const second = await screenerAutoApplyPass(db, { accountId: w.accountId });
    expect(second).toMatchObject({ mode: "full", examined: 0, kept: 0, marked: 0 });
    const run = seen.slice(at);
    expect(run.filter(isHeld), "one held page, empty").toHaveLength(1);
    expect(run.filter(isCandidate), "no candidate statement").toHaveLength(0);
  });

  it("a row kept with NO body row is not marked, and moves once its strong-bulk body arrives", async () => {
    const w = await world("bodyless");
    const id = await held(w, "late", undefined, { body: false });
    const first = await screenerAutoApplyPass(db, { accountId: w.accountId });
    expect(first).toMatchObject({ kept: 1, marked: 0 });
    expect(await versions([id])).toEqual([null]);
    await body(id, true);
    const second = await screenerAutoApplyPass(db, { accountId: w.accountId });
    expect(second).toMatchObject({ moved: 1 });
    expect(await desired(id)).not.toBe(SCREENER);
  });

  it("a floor version bump withdraws the old marks and judges the rows again", async () => {
    const w = await world("bump");
    const plain: string[] = [];
    for (let i = 0; i < 5; i++) plain.push(await held(w, `plain${i}`));
    const r1 = await screenerAutoApplyPass(db, { accountId: w.accountId, floorVersion: 1 });
    expect(r1).toMatchObject({ marked: 5 });
    // A WRONG mark at 1 on a strong-bulk row — what a classifier change leaves behind.
    const bulk = await held(w, "bulk", undefined, { bulk: true });
    await db.update(folderState).set({ screenerFloorVersion: 1 }).where(eq(folderState.messageId, bulk));
    const r2 = await screenerAutoApplyPass(db, { accountId: w.accountId, floorVersion: 2 });
    expect(r2).toMatchObject({ moved: 1, marked: 5 });
    expect(await desired(bulk)).not.toBe(SCREENER);
    expect(await versions(plain)).toEqual([2, 2, 2, 2, 2]);
  });

  it("a sensitivity-kept strong-bulk row is not marked, and moves once the flag clears", async () => {
    const w = await world("sensitive");
    const id = await held(w, "flagged", undefined, { bulk: true, noAi: true });
    const r1 = await screenerAutoApplyPass(db, { accountId: w.accountId });
    expect(r1).toMatchObject({ kept: 1, sensitivityExcluded: 1, marked: 0 });
    expect(await versions([id])).toEqual([null]);
    await db.update(messages).set({ noAi: false }).where(eq(messages.id, id));
    const r2 = await screenerAutoApplyPass(db, { accountId: w.accountId });
    expect(r2).toMatchObject({ moved: 1 });
  });

  it("one account's walk marks its own rows only, with another account's held rows interleaved by id", async () => {
    const a = await world("markmine");
    const b = await world("marktheirs");
    const mine: string[] = [];
    const theirs: string[] = [];
    for (let i = 0; i < 60; i++) {
      const hex = (0x100 + i).toString(16).padStart(4, "0");
      mine.push(await held(a, `a${i}`, `00000001-${hex}-4000-8000-00000000000a`));
      theirs.push(await held(b, `b${i}`, `00000001-${hex}-4000-8000-00000000000b`));
    }
    const r = await screenerAutoApplyPass(db, { accountId: a.accountId });
    expect(r).toMatchObject({ marked: 60 });
    expect(await versions(theirs), "the other account's rows stay unjudged").toEqual(theirs.map(() => null));
    const bPage = (await dialect(db).exec(db, heldPageSql({ accountId: b.accountId, afterId: null, limit: 100 })))
      .map((x) => String(x[0]));
    expect(bPage).toEqual([...theirs].sort());
    const aPage = (await dialect(db).exec(db, heldPageSql({ accountId: a.accountId, afterId: null, limit: 100 })))
      .map((x) => String(x[0]));
    expect(aPage, "this account's held page is empty once its rows are judged").toEqual([]);
  });

  it("an exactly full last page is followed by one empty held page and no candidate statement", async () => {
    const w = await world("exact");
    for (let i = 0; i < 200; i++) await held(w, `kept${i}`);
    const at = seen.length;
    const r = await screenerAutoApplyPass(db, { accountId: w.accountId, walk: newScreenerAutoWalk() });
    expect(r).toMatchObject({ mode: "full", examined: 200, capped: false });
    const run = seen.slice(at);
    expect(run.filter(isHeld)).toHaveLength(3);
    expect(run.filter(isCandidate)).toHaveLength(2);
  });

  it("another account's held rows, interleaved by id, are never this account's page", async () => {
    const a = await world("mine");
    const b = await world("theirs");
    const mine: string[] = [];
    for (let i = 0; i < 60; i++) {
      const hex = i.toString(16).padStart(4, "0");
      mine.push(await held(a, `a${i}`, `00000000-${hex}-4000-8000-00000000000a`));
      await held(b, `b${i}`, `00000000-${hex}-4000-8000-00000000000b`);
    }
    const page = (await dialect(db).exec(db, heldPageSql({ accountId: a.accountId, afterId: null, limit: 100 })))
      .map((r) => String(r[0]));
    expect(page).toEqual([...mine].sort());
    const second = (await dialect(db).exec(db, heldPageSql({ accountId: a.accountId, afterId: mine[29]!, limit: 100 })))
      .map((r) => String(r[0]));
    expect(second).toEqual([...mine].sort().slice(30));
  });

  it("the incremental walk still asks about its own slice of changed ids and nothing else", async () => {
    const w = await world("incremental");
    for (let i = 0; i < 120; i++) await held(w, `kept${i}`);
    const walk = newScreenerAutoWalk();
    await screenerAutoApplyPass(db, { accountId: w.accountId, walk });
    const at = seen.length;
    const r = await screenerAutoApplyPass(db, { accountId: w.accountId, walk });
    expect(r).toMatchObject({ mode: "incremental", examined: 0 });
    expect(seen.slice(at).filter(isHeld), "an incremental walk read a held page").toHaveLength(0);
  });
});
