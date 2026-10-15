import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountSettings, accountSyncState, accounts, folderState, mailboxes, messageBodies, messages,
  messageStates, recordChange, recordRuleDelta, rules, type Tx,
} from "@trafficflow/db";
import {
  newScreenerAutoWalk, screenerAutoApplyPass, type ScreenerAutoWalk,
} from "../src/screener-auto.js";

/**
 * THE AUTO-APPLY WALK READS WHAT CHANGED. A settled queue costs no candidate page; a new held row,
 * whatever its id, is read on the next cycle; a change that can re-admit a kept row, a roster move,
 * a pruned log or the hourly backstop makes the walk full again. The equality arm drives the same
 * events through a world with marks and a world without (the full walk every cycle, the previous
 * behaviour) and asks for the same moved set after every cycle.
 */

const SCREENER = "ohmail/Screener";
const STRONG_BULK = { "list-unsubscribe": ["<https://x.test/u>"], "list-id": ["<news.shop.test>"] };

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
const candidatePages = (seen: string[], from: number): number =>
  seen.slice(from).filter((s) => /for update of "folder_state"/i.test(s)).length;

interface World { accountId: string; mailboxId: string; tag: string }

describe("the auto-apply walk reads only what changed", () => {
  let db: Tx;
  let seen: string[];

  beforeAll(async () => {
    db = (await makeTestDb()) as unknown as Tx;
    seen = recordStatements(db);
  });

  async function world(tag: string, role: "organizer" | "reader" = "organizer"): Promise<World> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `walk-${tag}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `${tag}-${accountId.slice(0, 6)}@example.test`, organizerRole: role,
    }).returning();
    await db.insert(accountSettings).values({ accountId, screenerAutoApplyAt: new Date() });
    return { accountId, mailboxId: mb!.id, tag };
  }

  /** A held row as ingest writes one: message, body, folder state and its `create` change together. */
  async function held(w: World, key: string, o: { from?: string; bulk?: boolean; id?: string; noAi?: boolean } = {}): Promise<string> {
    return db.transaction(async (tx) => {
      const [m] = await tx.insert(messages).values({
        ...(o.id ? { id: o.id } : {}),
        accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h", dedupKey: `walk:${w.tag}:${key}`,
        subject: key, fromAddress: o.from ?? `${key}@sender.test`, noAi: o.noAi ?? false,
        nativeLocator: { folder: SCREENER, ref: `1:${key}` },
      }).returning();
      await tx.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: o.bulk ? STRONG_BULK : {} });
      await tx.insert(folderState).values({
        messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER, lastSetBy: "us",
        reconcileStatus: "reconciled", conflict: false,
      });
      await recordChange(tx as unknown as Parameters<typeof recordChange>[0], {
        accountId: w.accountId, entityType: "message", entityId: m!.id, op: "create", meta: null,
      });
      return m!.id;
    });
  }

  /** The keys of every row this world no longer holds at the gate. */
  async function movedKeys(w: World): Promise<string[]> {
    const rows = await db.select({ key: messages.subject, desired: folderState.desiredFolder })
      .from(folderState).innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(eq(messages.accountId, w.accountId));
    return rows.filter((r) => r.desired !== SCREENER).map((r) => r.key).sort();
  }

  const pass = (w: World, walk?: ScreenerAutoWalk, extra: { writesPerCycle?: number; fullEveryMs?: number } = {}) =>
    screenerAutoApplyPass(db, { accountId: w.accountId, ...(walk ? { walk } : {}), ...extra });

  it("a settled queue of kept rows costs no candidate page on the next cycle", async () => {
    const w = await world("settled");
    for (let i = 0; i < 250; i++) await held(w, `kept${i}`);
    for (let i = 0; i < 3; i++) await held(w, `bulk${i}`, { bulk: true });
    const walk = newScreenerAutoWalk();

    const first = await pass(w, walk);
    expect(first).toMatchObject({ mode: "full", moved: 3, examined: 253 });

    const before = seen.length;
    const second = await pass(w, walk);
    expect(second).toMatchObject({ mode: "incremental", moved: 0, examined: 0 });
    expect(candidatePages(seen, before), "an unchanged queue was paged again").toBe(0);

    // A full walk costs no candidate page either: every kept row carries its floor mark (mail 0141).
    const full = seen.length;
    expect(await pass(w)).toMatchObject({ mode: "full", examined: 0 });
    expect(candidatePages(seen, full)).toBe(0);

    // The control: with neither mark the same queue is paged in full every cycle.
    await db.update(folderState).set({ screenerFloorVersion: null })
      .where(inArray(folderState.messageId, db.select({ id: messages.id }).from(messages).where(eq(messages.accountId, w.accountId))));
    const at = seen.length;
    expect(await pass(w)).toMatchObject({ mode: "full", examined: 250 });
    expect(candidatePages(seen, at)).toBe(3);
  });

  it("a new held row is read on the next cycle, even with an id below every earlier one", async () => {
    const w = await world("arrival");
    for (let i = 0; i < 120; i++) await held(w, `kept${i}`);
    const walk = newScreenerAutoWalk();
    await pass(w, walk);
    const low = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
    await held(w, "late", { bulk: true, id: low });
    const r = await pass(w, walk);
    expect(r).toMatchObject({ mode: "incremental", examined: 1, moved: 1 });
    expect(await movedKeys(w)).toEqual(["late"]);
  });

  it("a rule disabled, a roster move, a pruned log and the hour each make the walk full", async () => {
    const w = await world("readmit");
    const [rule] = await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "ruled@sender.test", destination: "INBOX",
      priority: 0, provenance: "promoted", enabled: true,
    }).returning();
    await held(w, "ruled", { bulk: true, from: "ruled@sender.test" });
    const walk = newScreenerAutoWalk();
    expect(await pass(w, walk)).toMatchObject({ mode: "full", moved: 0 });
    expect(await pass(w, walk)).toMatchObject({ mode: "incremental", examined: 0 });

    await db.transaction(async (tx) => {
      await tx.update(rules).set({ enabled: false }).where(eq(rules.id, rule!.id));
      await recordRuleDelta(tx as unknown as Parameters<typeof recordRuleDelta>[0], w.accountId, [rule!.id], "update");
    });
    expect(await pass(w, walk), "a disabled rule did not re-open the queue").toMatchObject({ mode: "full", moved: 1 });

    // An exclusion lifted with no change row at all — only the hourly walk can see it.
    await held(w, "quiet", { bulk: true, noAi: true });
    expect(await pass(w, walk)).toMatchObject({ mode: "incremental", moved: 0 });
    await db.update(messages).set({ noAi: false }).where(eq(messages.subject, "quiet"));
    expect(await pass(w, walk)).toMatchObject({ mode: "incremental", moved: 0 });
    expect(await pass(w, walk, { fullEveryMs: 0 })).toMatchObject({ mode: "full", moved: 1 });

    // Retention compacted past the mark: the changes since it may be gone, so the walk is full once.
    await held(w, "after-mark");
    const [state] = await db.select().from(accountSyncState).where(eq(accountSyncState.accountId, w.accountId));
    await db.update(accountSyncState).set({ prunedThroughSeq: state!.nextSeq }).where(eq(accountSyncState.accountId, w.accountId));
    expect(await pass(w, walk)).toMatchObject({ mode: "full" });
    expect(await pass(w, walk)).toMatchObject({ mode: "incremental" });
  });

  it("another account's changes stay out of this account's walk", async () => {
    const mine = await world("mine");
    const theirs = await world("theirs");
    for (let i = 0; i < 5; i++) await held(mine, `kept${i}`);
    // Sequences are per account: theirs must run past mine for a leak to be visible at all.
    for (let i = 0; i < 8; i++) await held(theirs, `kept${i}`);
    const walk = newScreenerAutoWalk();
    expect(await pass(mine, walk)).toMatchObject({ mode: "full", examined: 5 });
    const [rule] = await db.insert(rules).values({
      accountId: theirs.accountId, kind: "sender", match: "x@sender.test", destination: "INBOX",
      priority: 0, provenance: "promoted", enabled: true,
    }).returning();
    await db.transaction((tx) => recordRuleDelta(tx as unknown as Parameters<typeof recordRuleDelta>[0], theirs.accountId, [rule!.id], "delete"));
    await held(theirs, "their-bulk", { bulk: true });
    const before = seen.length;
    expect(await pass(mine, walk)).toMatchObject({ mode: "incremental", examined: 0 });
    expect(candidatePages(seen, before), "another account's held row was paged here").toBe(0);
  });

  it("a reader mailbox promoted to organizer is walked in full", async () => {
    const w = await world("promote", "reader");
    await held(w, "bulk", { bulk: true });
    const walk = newScreenerAutoWalk();
    expect(await pass(w, walk)).toMatchObject({ mode: "full", moved: 0 });
    await db.update(mailboxes).set({ organizerRole: "organizer" }).where(eq(mailboxes.id, w.mailboxId));
    expect(await pass(w, walk)).toMatchObject({ mode: "full", moved: 1 });
  });

  it("a capped walk leaves the mark, so the rest is read next cycle", async () => {
    const w = await world("capped");
    for (let i = 0; i < 5; i++) await held(w, `bulk${i}`, { bulk: true });
    const walk = newScreenerAutoWalk();
    expect(await pass(w, walk, { writesPerCycle: 2 })).toMatchObject({ mode: "full", moved: 2, capped: true });
    expect(await pass(w, walk, { writesPerCycle: 2 })).toMatchObject({ mode: "full", moved: 2, capped: true });
    expect(await pass(w, walk, { writesPerCycle: 2 })).toMatchObject({ mode: "full", moved: 1, capped: false });
    for (let i = 0; i < 3; i++) await held(w, `late${i}`, { bulk: true });
    expect(await pass(w, walk, { writesPerCycle: 2 })).toMatchObject({ mode: "incremental", moved: 2, capped: true });
    expect(await pass(w, walk, { writesPerCycle: 2 })).toMatchObject({ mode: "incremental", moved: 1, capped: false });
    expect(await pass(w, walk, { writesPerCycle: 2 })).toMatchObject({ mode: "incremental", examined: 0 });
  });

  it("moves exactly what the full walk moves, cycle by cycle, over the same events", async () => {
    const withMarks = await world("eq-a");
    const fullEvery = await world("eq-b");
    const walk = newScreenerAutoWalk();
    const both = async (fn: (w: World) => Promise<unknown>) => { await fn(withMarks); await fn(fullEvery); };
    const ruleOf = new Map<string, string>();
    const stateOf = new Map<string, string>();

    await both(async (w) => {
      for (let i = 0; i < 40; i++) await held(w, `kept${i}`);
      for (let i = 0; i < 6; i++) await held(w, `bulk${i}`, { bulk: true });
      await held(w, "ruled", { bulk: true, from: "ruled@sender.test" });
      const [r] = await db.insert(rules).values({
        accountId: w.accountId, kind: "sender", match: "ruled@sender.test", destination: "INBOX",
        priority: 0, provenance: "promoted", enabled: true,
      }).returning();
      ruleOf.set(w.tag, r!.id);
      const triaged = await held(w, "triaged", { bulk: true });
      const [st] = await db.insert(messageStates).values({ accountId: w.accountId, messageId: triaged, state: "reply_later" }).returning();
      stateOf.set(w.tag, st!.id);
    });
    const events: Array<(w: World) => Promise<unknown>> = [
      async () => undefined,
      async (w) => { await held(w, "late-bulk", { bulk: true, id: `00000000-0000-4000-8000-${randomUUID().slice(-12)}` }); await held(w, "late-kept"); },
      (w) => db.transaction(async (tx) => {
        await tx.update(rules).set({ enabled: false }).where(eq(rules.id, ruleOf.get(w.tag)!));
        await recordRuleDelta(tx as unknown as Parameters<typeof recordRuleDelta>[0], w.accountId, [ruleOf.get(w.tag)!], "update");
      }),
      (w) => db.transaction(async (tx) => {
        await tx.update(messageStates).set({ state: "none" }).where(eq(messageStates.id, stateOf.get(w.tag)!));
        await recordChange(tx as unknown as Parameters<typeof recordChange>[0], {
          accountId: w.accountId, entityType: "message_state", entityId: stateOf.get(w.tag)!, op: "update", meta: null,
        });
      }),
      async () => undefined,
    ];
    for (const [i, event] of events.entries()) {
      await both(event);
      await pass(withMarks, walk);
      await pass(fullEvery);
      expect(await movedKeys(withMarks), `cycle ${i}: the moved sets differ`).toEqual(await movedKeys(fullEvery));
    }
    expect(await movedKeys(withMarks)).toEqual(
      ["bulk0", "bulk1", "bulk2", "bulk3", "bulk4", "bulk5", "late-bulk", "ruled", "triaged"],
    );
  });

  // The tail's clock stops a walk after its first page; the next call goes on at the cursor, so a
  // walk longer than the clock still reaches the end, leaves the mark, and moves what the unclocked
  // walk moves. Without the resume every call restarts at page one and never finishes.
  it("a walk the clock stops resumes at its cursor and still leaves the mark", async () => {
    const clocked = await world("clock");
    const plain = await world("clock-plain");
    for (const w of [clocked, plain]) {
      for (let i = 0; i < 230; i++) await held(w, `kept${i}`);
      for (let i = 0; i < 6; i++) await held(w, `bulk${i}`, { bulk: true });
    }
    await screenerAutoApplyPass(db, { accountId: plain.accountId, batch: 50 });
    const walk = newScreenerAutoWalk();
    const modes: string[] = [];
    for (let call = 0; call < 12; call++) {
      const r = await screenerAutoApplyPass(db, { accountId: clocked.accountId, walk, batch: 50, until: () => true });
      modes.push(`${r.mode}:${r.examined}`);
      if (r.mode === "incremental") break;
    }
    expect(modes.slice(0, 5), "a stopped walk restarted instead of resuming").toEqual(
      ["full:50", "full:50", "full:50", "full:50", "full:36"]);
    expect(modes[5], `the resumed walk never left its mark: ${modes.join(" ")}`).toBe("incremental:0");
    expect(await movedKeys(clocked)).toEqual(await movedKeys(plain));
    expect(await movedKeys(clocked)).toEqual(["bulk0", "bulk1", "bulk2", "bulk3", "bulk4", "bulk5"]);
  });
});
