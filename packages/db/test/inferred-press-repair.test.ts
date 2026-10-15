import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { applyScreenerDecision } from "../src/screener-apply.js";
import { applyInferredPressRepair, planInferredPressRepair } from "../src/inferred-press-repair.js";
import { accounts, changeLog, learningSignals, rules } from "../src/schema.js";
import type { Tx } from "../src/change-log.js";
import { carryDialect } from "../src/dialect/index.js";

/**
 * THE 0.25.9 REPAIR, ONLY: a Screener rule a person moved to the Ohbox before 0.25.9 is theirs.
 * The person's press is written here as that door wrote it (destination, `updated_at`, the backlog
 * re-armed, provenance untouched). Every other shape the measurement named is left exactly as it
 * stands: a Screener Ohbox decision, a later Screener decision, the seed, a held release, a priority
 * edit, a graduation, a "Not junk" rescue after a screen-out.
 */

let clock = Date.parse("2026-09-20T10:00:00.000Z");
const tick = () => new Date((clock += 3_600_000));

async function account() {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `ipr-${accountId.slice(0, 8)}` });
  const decide = (address: string, folder: string, scope: "sender" | "domain" = "sender") =>
    db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx as object) as unknown as Tx, {
      accountId, scope, address, appliedFolder: folder, decision: folder === "ohmail/Screened" ? "no" : "yes",
      triggeringActionId: `screener:${randomUUID()}`, now: tick(), decidedBy: "person", overExisting: "converge",
    }));
  /** The pre-0.25.9 person door: the place moves, the backlog re-arms, the provenance stays. */
  const press = async (id: string, set: { destination?: string; priority?: number }, retro = true) => {
    const now = tick();
    await db.update(rules).set({
      ...set, updatedAt: now,
      ...(retro && set.destination ? { retroRequestedAt: now, retroDoneAt: null, retroCursor: null, retroMoved: 0 } : {}),
    }).where(eq(rules.id, id));
  };
  const insert = async (v: Partial<typeof rules.$inferInsert> & { match: string }) => {
    const [r] = await db.insert(rules).values({
      accountId, kind: "sender", destination: "INBOX", priority: 0, enabled: true, provenance: "promoted", ...v,
    }).returning({ id: rules.id });
    return r!.id;
  };
  const of = async (match: string) => db.select().from(rules)
    .where(and(eq(rules.accountId, accountId), eq(rules.match, match)));
  const plan = async () => (await planInferredPressRepair(db, accountId)).ruleIds.sort();
  return { db, accountId, decide, press, insert, of, plan };
}
const addr = () => `${randomUUID().slice(0, 8)}@letter.example`;

describe("the inferred-press repair", () => {
  it("a Screener News rule a person moved to the Ohbox becomes theirs, nothing else written", async () => {
    const w = await account();
    const a = addr();
    await w.decide(a, "ohmail/News");
    const [r] = await w.of(a);
    await w.press(r!.id, { destination: "INBOX" });
    const before = (await w.of(a))[0]!;
    expect(await w.plan()).toEqual([r!.id]);
    const deltas = () => w.db.select().from(changeLog).where(eq(changeLog.entityId, r!.id));
    const n0 = (await deltas()).length;

    const res = await applyInferredPressRepair(w.db, w.accountId);
    expect(res).toEqual({ planned: 1, written: 1 });
    const after = (await w.of(a))[0]!;
    expect(after.provenance).toBe("manual");
    expect({ ...after, provenance: before.provenance }, "metadata only: every other column as it was").toEqual(before);
    const after0 = await deltas();
    expect(after0.length, "the mirrors learn it: one rule delta").toBe(n0 + 1);
    expect(after0.at(-1)!.op).toBe("update");

    expect(await applyInferredPressRepair(w.db, w.accountId), "a second apply writes nothing").toEqual({ planned: 0, written: 0 });
  });

  it("with also-move off, and a domain rule: both repaired", async () => {
    const w = await account();
    const a = addr();
    await w.decide(a, "ohmail/News");
    const [r] = await w.of(a);
    await w.press(r!.id, { destination: "INBOX" }, false);
    const d = `${randomUUID().slice(0, 8)}.example`;
    await w.decide(`one@${d}`, "ohmail/News", "domain");
    const [dr] = await w.of(d);
    await w.press(dr!.id, { destination: "INBOX" });
    expect(await w.plan()).toEqual([r!.id, dr!.id].sort());
    expect((await applyInferredPressRepair(w.db, w.accountId)).written).toBe(2);
  });

  it("leaves every shape that is not a person's move to the Ohbox", async () => {
    const w = await account();
    const untouched: string[] = [];
    // B — a Screener Ohbox decision, untouched.
    const b = addr(); await w.decide(b, "INBOX"); untouched.push(b);
    // C — a Screener News decision, then a Screener Ohbox decision (the twin retarget).
    const c = addr(); await w.decide(c, "ohmail/News"); await w.decide(c, "INBOX"); untouched.push(c);
    // D/E/F — the sent-mail seed: re-armed by a person, released at the gate, pressed with move off.
    for (const how of ["rearm", "release", "press"] as const) {
      const s = addr(); const at = tick();
      const id = await w.insert({ match: s, provenance: "seeded-from-sent", releaseHeldAt: at, retroRequestedAt: at });
      if (how === "rearm") await w.press(id, { destination: "INBOX" });
      else if (how === "press") await w.press(id, { destination: "INBOX" }, false);
      else { const now = tick(); await w.db.update(rules).set({ releaseHeldAt: now, retroRequestedAt: now, updatedAt: now }).where(eq(rules.id, id)); }
      untouched.push(s);
    }
    // G/H — a Screener Ohbox rule re-armed by a person, and one given a priority.
    const g = addr(); await w.decide(g, "INBOX"); await w.press((await w.of(g))[0]!.id, { destination: "INBOX" }); untouched.push(g);
    const h = addr(); await w.decide(h, "INBOX"); await w.press((await w.of(h))[0]!.id, { priority: 3 }); untouched.push(h);
    // A graduation: the Screener's News rule stands and approvals graduated an Ohbox rule beside it.
    const k = addr(); await w.decide(k, "ohmail/News");
    await w.db.insert(learningSignals).values({ accountId: w.accountId, triggeringActionId: `approval:${randomUUID()}`,
      kind: "approval", senderAddress: k, destination: "INBOX", label: "positive" });
    await w.insert({ match: k }); untouched.push(k);
    // A "Not junk" rescue after a screen-out: the screen-out's rule still stands.
    const j = addr(); await w.decide(j, "ohmail/Screened"); await w.insert({ match: j }); untouched.push(j);
    // The sent-mail seed's rule at the Ohbox over a sender with a Screener News decision whose
    // rule is gone: not the ruled shape, which is a PROMOTED rule only.
    const s2 = addr(); await w.decide(s2, "ohmail/News");
    await w.db.delete(rules).where(eq(rules.match, s2));
    await w.insert({ match: s2, provenance: "seeded-from-sent" }); untouched.push(s2);
    // A Screener News rule a person moved somewhere other than the Ohbox: `people_only` never
    // refiles a rule there, so nothing is owed.
    const rcpt = addr(); await w.decide(rcpt, "ohmail/News");
    await w.press((await w.of(rcpt))[0]!.id, { destination: "ohmail/Receipts" }); untouched.push(rcpt);

    const snapshot = async () => (await Promise.all(untouched.map((m) => w.of(m)))).flat()
      .sort((x, y) => x.id.localeCompare(y.id));
    const before = await snapshot();
    expect(await w.plan()).toEqual([]);
    expect(await applyInferredPressRepair(w.db, w.accountId)).toEqual({ planned: 0, written: 0 });
    expect(await snapshot()).toEqual(before);
  });

  it("the approval term alone: an approval into the Ohbox keeps a moved rule inferred", async () => {
    const w = await account();
    const a = addr();
    await w.decide(a, "ohmail/News");
    const [r] = await w.of(a);
    await w.press(r!.id, { destination: "INBOX" });
    await w.db.insert(learningSignals).values({ accountId: w.accountId, triggeringActionId: `approval:${randomUUID()}`,
      kind: "approval", senderAddress: a, destination: "INBOX", label: "positive" });
    expect(await w.plan()).toEqual([]);
  });

  it("the twin term alone: a twin still at the Screener's place keeps the Ohbox rule inferred", async () => {
    const w = await account();
    const a = addr();
    await w.decide(a, "ohmail/News");
    await w.insert({ match: a });
    expect(await w.plan()).toEqual([]);
  });

  it("no Screener decision at all: a promoted Ohbox rule is not the reporter's shape", async () => {
    const w = await account();
    await w.insert({ match: addr() });
    expect(await w.plan()).toEqual([]);
  });

  it("the UPDATE writes only a row still promoted: a writer between the plan and the write wins", async () => {
    const w = await account();
    const a = addr();
    await w.decide(a, "ohmail/News");
    const [r] = await w.of(a);
    await w.press(r!.id, { destination: "INBOX" });
    expect(await w.plan()).toEqual([r!.id]);
    /* The concurrent writer, placed inside the repair's own transaction just before its UPDATE runs
       (the plan has read the row as promoted by then): the sent-mail seed re-infers the rule. */
    let raced = false;
    const racing = (t: object): object => new Proxy(t, {
      get(target, key, recv) {
        const v = Reflect.get(target, key, recv);
        if (key !== "update" || raced) return v;
        return (table: unknown) => (table !== rules ? (v as (x: unknown) => unknown).call(target, table) : {
          set: (values: object) => ({
            where: (cond: unknown) => ({
              returning: async (sel: object) => {
                raced = true;
                const tx = target as unknown as Tx;
                await tx.update(rules).set({ provenance: "seeded-from-sent" }).where(eq(rules.id, r!.id));
                return tx.update(rules).set(values).where(cond as never).returning(sel as never);
              },
            }),
          }),
        });
      },
    });
    const db = new Proxy(w.db as object, {
      get(target, key, recv) {
        const v = Reflect.get(target, key, recv);
        return key === "transaction"
          ? (fn: (t: object) => Promise<unknown>) => (v as (f: (t: object) => Promise<unknown>) => Promise<unknown>)
            .call(target, (t) => fn(racing(t)))
          : v;
      },
    }) as unknown as Tx;
    const res = await applyInferredPressRepair(db, w.accountId);
    expect(raced, "the race arm ran").toBe(true);
    expect(res).toEqual({ planned: 1, written: 0 });
    expect((await w.of(a))[0]!.provenance).toBe("seeded-from-sent");
  });
});
