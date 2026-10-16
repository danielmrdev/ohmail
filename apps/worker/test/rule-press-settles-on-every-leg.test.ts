import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { changeLog, mailboxes, organizerRequests, rules } from "@trafficflow/db";
import { RulesService, type ServiceContext } from "@trafficflow/services";
import {
  deriveRequestKey, type MetaRecordsList, type RequestReaderIo, type RequestOrganizerIo, type RawMetaMessage,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { applyMetaRequests, driveOutstandingRequests } from "../src/request-drain.js";

/**
 * A READER'S RULE ROW STATES ONLY WHAT EVERY HOLDER ITS PRESS WENT TO HAS CARRIED OUT. One reader
 * install, one organizer per held mailbox, one `ohmail/_meta` per mailbox; real doors throughout.
 * The rows under the key move in the cycle that finishes the press's last leg — never at the first
 * ack while another holder still runs the old rule. The clock ticks per call, as production's does,
 * so the press's one `decidedAt` is what ties its legs together.
 */
const ACCT = "00000000-0000-0000-0000-0000000000e6";
const t0 = new Date("2026-10-03T08:00:00.000Z");
const at = (m: number): Date => new Date(t0.getTime() + m * 60_000);
const READER = { installId: "reader-install", kind: "local" as const };
const DAY = 25 * 60;
const svc = new RulesService();
type TestDb = Awaited<ReturnType<typeof makeTestDb>>;

function sharedMeta() {
  const store = new Map<number, string>();
  let next = 1;
  const list = async (): Promise<MetaRecordsList> => {
    const records: RawMetaMessage[] = [...store.entries()].map(([ref, raw]) => ({ ref, raw }));
    return { records, count: records.length, bytes: records.reduce((n, r) => n + r.raw.length, 0) };
  };
  return {
    reader: { listMetaRecords: list, async append(raw: string) { store.set(next++, raw); } } as RequestReaderIo,
    organizer: {
      listMetaRecords: list, uidValidity: () => 7_000,
      async ack(raw: string) { store.set(next++, raw); },
      async remove(refs: readonly unknown[]) { for (const r of refs) if (typeof r === "number") store.delete(r); },
    } as RequestOrganizerIo,
  };
}

const ANN = { accountId: ACCT, kind: "sender", match: "ann@shop.example", priority: 0, enabled: true, provenance: "manual" };

/** One entry per held mailbox: whether its holder takes `rule.*`, and Ann's rule there (or none). */
async function world(holders: Array<{ rules?: boolean; has: string | null }>, readerRows: string[]) {
  const here = await makeTestDb();
  const log: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const legs: Array<{
    id: string; laptop: TestDb; readerCycle: (t: number) => Promise<unknown>;
    laptopCycle: (t: number) => Promise<unknown>; round: (t: number) => Promise<void>;
  }> = [];
  for (let i = 0; i < holders.length; i++) {
    const address = `held${i}@mailbox.example`;
    const key = deriveRequestKey({ auth: { user: address, pass: "the-shared-password" }, address })!;
    const id = randomUUID();
    const laptop = await makeTestDb();
    await here.insert(mailboxes).values({
      id, accountId: ACCT, provider: "imap", address, organizerRole: "reader", organizerState: "held",
      organizedByCapabilities: holders[i]!.rules === false ? "requests" : "requests,rules",
      organizedByKind: "local", organizedByName: `laptop${i}`,
    });
    await laptop.insert(mailboxes).values({ id, accountId: ACCT, provider: "imap", address });
    if (holders[i]!.has) await laptop.insert(rules).values({ ...ANN, destination: holders[i]!.has! });
    const m = sharedMeta();
    const readerCycle = (t: number) => driveOutstandingRequests(here, { mailboxId: id, accountId: ACCT, installId: READER.installId, adapter: { requestReaderIo: () => m.reader } as unknown as MailboxAdapter, requestKey: key }, READER, at(t), (event, detail) => { log.push({ event, detail }); });
    const laptopCycle = (t: number) => applyMetaRequests(laptop, { mailboxId: id, accountId: ACCT, installId: `laptop${i}`, adapter: { requestOrganizerIo: () => m.organizer } as unknown as MailboxAdapter, requestKey: key }, at(t), () => undefined);
    /** Send, apply on this holder, read the ack. */
    const round = async (t: number) => { await readerCycle(t); await laptopCycle(t + 1); await readerCycle(t + 2); };
    legs.push({ id, laptop, readerCycle, laptopCycle, round });
  }
  for (const d of readerRows) await here.insert(rules).values({ ...ANN, destination: d, updatedAt: at(0) });
  let clock = at(1);
  // Production's `now: () => new Date()`: every call is a fresh instant.
  const ctx = {
    db: here, accountId: ACCT, userId: null, requestId: "r",
    now: () => (clock = new Date(clock.getTime() + 1)),
  } as ServiceContext;
  const rowsOf = async (db: TestDb) => (await db.select({ d: rules.destination }).from(rules).where(eq(rules.accountId, ACCT))).map((r) => r.d).sort();
  const deletes = async () => (await here.select().from(changeLog)
    .where(and(eq(changeLog.accountId, ACCT), eq(changeLog.entityType, "rule"), eq(changeLog.op, "delete")))).length;
  const states = async () => (await here.select({ m: organizerRequests.mailboxId, kind: organizerRequests.kind, state: organizerRequests.state, why: organizerRequests.refusedReason })
    .from(organizerRequests).where(eq(organizerRequests.accountId, ACCT)))
    .map((r) => `${legs.findIndex((l) => l.id === r.m)}:${r.state}${r.why ? `(${r.why})` : ""}`).sort();
  const firstId = async () => (await here.select({ id: rules.id }).from(rules).where(eq(rules.accountId, ACCT)))[0]!.id;
  const unfinished = () => log.filter((l) => l.event === "reader_rule_settle_skipped" && l.detail.reason === "press_unfinished").length;
  return { here, legs, ctx, rowsOf, deletes, states, firstId, unfinished, setClock: (t: number) => { clock = at(t); } };
}
type World = Awaited<ReturnType<typeof world>>;

/** Holder 1's leg is sent and unanswered while holder 0 applies and its ack is read. */
async function firstAckWhileTheOtherIsSent(w: World) {
  await w.legs[1]!.readerCycle(2);
  await w.legs[0]!.round(3);
}

describe("two holders: the reader's row waits for the second", () => {
  it("delete: the row stays at the first ack and goes in the cycle that reads the last", async () => {
    const w = await world([{ has: "ohmail/News" }, { has: "ohmail/News" }], ["ohmail/News"]);
    await svc.remove(w.ctx, await w.firstId());
    await firstAckWhileTheOtherIsSent(w);
    expect(await w.states()).toEqual(["0:applied", "1:sent"]);
    expect(await w.rowsOf(w.here), "the row went while holder 1 still runs the rule").toEqual(["ohmail/News"]);
    expect(await w.rowsOf(w.legs[1]!.laptop)).toEqual(["ohmail/News"]);
    expect(w.unfinished(), "the early ack is logged once").toBe(1);
    await w.legs[1]!.laptopCycle(6); await w.legs[1]!.readerCycle(7);
    expect(await w.states()).toEqual(["0:applied", "1:applied"]);
    expect(await w.rowsOf(w.here)).toEqual([]);
    expect(await w.deletes()).toBe(1);
  });

  it("update: the row keeps the old destination until both holders file to the new one", async () => {
    const w = await world([{ has: "ohmail/News" }, { has: "ohmail/News" }], ["ohmail/News"]);
    await svc.update(w.ctx, await w.firstId(), { destination: "ohmail/Receipts" });
    await firstAckWhileTheOtherIsSent(w);
    expect(await w.rowsOf(w.legs[0]!.laptop)).toEqual(["ohmail/Receipts"]);
    expect(await w.rowsOf(w.here), "the row moved while holder 1 still files to News").toEqual(["ohmail/News"]);
    await w.legs[1]!.laptopCycle(6); await w.legs[1]!.readerCycle(7);
    expect(await w.rowsOf(w.here)).toEqual(["ohmail/Receipts"]);
  });

  it("create: the row appears only once both holders have made the rule", async () => {
    const w = await world([{ has: null }, { has: null }], []);
    await svc.create(w.ctx, { kind: "sender", match: "ann@shop.example", destination: "ohmail/Receipts" });
    await firstAckWhileTheOtherIsSent(w);
    expect(await w.rowsOf(w.here), "the row appeared while holder 1 has no such rule").toEqual([]);
    await w.legs[1]!.laptopCycle(6); await w.legs[1]!.readerCycle(7);
    expect(await w.rowsOf(w.here)).toEqual(["ohmail/Receipts"]);
  });

  it("CONTROL: an update leg refused no_such_rule does not finish it — only a delete's does", async () => {
    const w = await world([{ has: "ohmail/News" }, { has: null }], ["ohmail/News"]);
    await svc.update(w.ctx, await w.firstId(), { destination: "ohmail/Receipts" });
    await w.legs[1]!.round(2);
    await w.legs[0]!.round(5);
    expect(await w.states()).toEqual(["0:applied", "1:refused(no_such_rule)"]);
    expect(await w.rowsOf(w.here)).toEqual(["ohmail/News"]);
  });
});

describe("a delete leg refused no_such_rule finishes its leg", () => {
  for (const order of ["applied first", "refusal first"] as const) {
    it(`order ${order}: {applied, no_such_rule} — the row goes`, async () => {
      const w = await world([{ has: "ohmail/News" }, { has: null }], ["ohmail/News"]);
      await svc.remove(w.ctx, await w.firstId());
      const [a, b] = order === "applied first" ? [0, 1] : [1, 0];
      await w.legs[a]!.round(2);
      expect(await w.rowsOf(w.here), "the row moved before the last leg answered").toEqual(["ohmail/News"]);
      await w.legs[b]!.round(5);
      expect(await w.states()).toEqual(["0:applied", "1:refused(no_such_rule)"]);
      expect(await w.rowsOf(w.here)).toEqual([]);
      expect(await w.deletes()).toBe(1);
    });
  }

  it("{no_such_rule, no_such_rule} — every holder says nothing runs there, the row goes", async () => {
    const w = await world([{ has: null }, { has: null }], ["ohmail/News"]);
    await svc.remove(w.ctx, await w.firstId());
    await w.legs[0]!.round(2);
    expect(await w.rowsOf(w.here), "the row went before the second holder answered").toEqual(["ohmail/News"]);
    await w.legs[1]!.round(5);
    expect(await w.states()).toEqual(["0:refused(no_such_rule)", "1:refused(no_such_rule)"]);
    expect(await w.rowsOf(w.here)).toEqual([]);
    expect(await w.deletes()).toBe(1);
    // The first refusal is read while the second leg is still pending: one early skip, logged once.
    expect(w.unfinished()).toBe(1);
  });
});

describe("an expired leg holds; a holder refused at the press does not", () => {
  it("{applied, expired} keeps the row; a re-press then completes and the row goes", async () => {
    const w = await world([{ has: "ohmail/News" }, { has: "ohmail/News" }], ["ohmail/News"]);
    await svc.remove(w.ctx, await w.firstId());
    await w.legs[0]!.round(2);
    await w.legs[1]!.readerCycle(5);
    await w.legs[1]!.readerCycle(5 + DAY);
    expect(await w.states()).toEqual(["0:applied", "1:expired"]);
    expect(await w.rowsOf(w.here), "an expired leg let the row go").toEqual(["ohmail/News"]);
    expect(await w.rowsOf(w.legs[1]!.laptop)).toEqual(["ohmail/News"]);
    // The person presses Remove again: holder 0 has nothing under the key, holder 1 applies.
    w.setClock(DAY + 9);
    await svc.remove(w.ctx, await w.firstId());
    await w.legs[0]!.round(DAY + 10);
    await w.legs[1]!.round(DAY + 13);
    expect(await w.rowsOf(w.legs[1]!.laptop)).toEqual([]);
    expect(await w.rowsOf(w.here)).toEqual([]);
  });

  it("a holder that takes no rule request has no leg and holds nothing back", async () => {
    const w = await world([{ has: "ohmail/News" }, { rules: false, has: "ohmail/News" }], ["ohmail/News"]);
    const out = await svc.remove(w.ctx, await w.firstId()) as { travel: { refused: unknown[] } };
    expect(out.travel.refused).toHaveLength(1);
    await w.legs[0]!.round(2);
    expect(await w.states()).toEqual(["0:applied"]);
    expect(await w.rowsOf(w.here)).toEqual([]);
  });

  it("CONTROL: one holder, one applied leg — the row goes in the cycle that reads it", async () => {
    const w = await world([{ has: "ohmail/News" }], ["ohmail/News", "ohmail/Receipts"]);
    await svc.remove(w.ctx, await w.firstId());
    await w.legs[0]!.round(2);
    expect(await w.rowsOf(w.here)).toEqual([]);
    expect(await w.deletes(), "one delete per twin").toBe(2);
    expect(w.unfinished()).toBe(0);
  });
});

describe("a leg that leaves or answers late does not hold the row for ever", () => {
  /** Remove pressed with both holders running Ann's rule; holder 0 applies, holder 1's leg is sent. */
  async function halfApplied() {
    const w = await world([{ has: "ohmail/News" }, { has: "ohmail/News" }], ["ohmail/News"]);
    await svc.remove(w.ctx, await w.firstId());
    await w.legs[1]!.readerCycle(2);
    await w.legs[0]!.round(3);
    expect(await w.states()).toEqual(["0:applied", "1:sent"]);
    expect(await w.rowsOf(w.here)).toEqual(["ohmail/News"]);
    return w;
  }

  it("the other mailbox is removed before it answers; Remove again takes the row", async () => {
    const w = await halfApplied();
    // As mailbox erasure does: the mailbox's requests go, then the mailbox.
    await w.here.delete(organizerRequests).where(eq(organizerRequests.mailboxId, w.legs[1]!.id));
    await w.here.delete(mailboxes).where(eq(mailboxes.id, w.legs[1]!.id));
    w.setClock(20);
    await svc.remove(w.ctx, await w.firstId());
    await w.legs[0]!.round(21);
    expect(await w.rowsOf(w.here), "a removed rule no organizer runs is still listed").toEqual([]);
    expect(await w.deletes()).toBe(1);
    expect(await w.rowsOf(w.legs[0]!.laptop)).toEqual([]);
  });

  it("the other mailbox is disabled before it answers; Remove again takes the row", async () => {
    const w = await halfApplied();
    await w.here.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, w.legs[1]!.id));
    w.setClock(20);
    await svc.remove(w.ctx, await w.firstId());
    await w.legs[0]!.round(21);
    expect(await w.rowsOf(w.here)).toEqual([]);
    expect(await w.deletes()).toBe(1);
    expect(await w.rowsOf(w.legs[0]!.laptop)).toEqual([]);
  });

  it("the other holder applies after the reader expired its leg; Remove again takes the row", async () => {
    const w = await world([{ has: "ohmail/News" }, { has: "ohmail/News" }], ["ohmail/News"]);
    await svc.remove(w.ctx, await w.firstId());
    await w.legs[0]!.round(2);
    await w.legs[1]!.readerCycle(5);
    await w.legs[1]!.readerCycle(5 + DAY);
    // The organizer's clock reads 23 h 58 min after the press: inside its own stale window.
    await w.legs[1]!.laptopCycle(23 * 60 + 58);
    await w.legs[1]!.readerCycle(6 + DAY);
    expect(await w.rowsOf(w.legs[1]!.laptop)).toEqual([]);
    w.setClock(DAY + 9);
    await svc.remove(w.ctx, await w.firstId());
    await w.legs[0]!.round(DAY + 10);
    await w.legs[1]!.round(DAY + 13);
    expect(await w.rowsOf(w.here)).toEqual([]);
    expect(await w.deletes()).toBe(1);
    expect(await w.rowsOf(w.legs[0]!.laptop)).toEqual([]);
    expect(await w.rowsOf(w.legs[1]!.laptop)).toEqual([]);
  });

  /** Remove pressed, both legs sent, then holder 1's mailbox is set to `status`, then holder 0's round. */
  async function otherLegLeaves(status: "disabled" | "error") {
    const w = await world([{ has: "ohmail/News" }, { has: "ohmail/News" }], ["ohmail/News"]);
    await svc.remove(w.ctx, await w.firstId());
    await w.legs[0]!.readerCycle(2);
    await w.legs[1]!.readerCycle(2);
    await w.here.update(mailboxes).set({ status }).where(eq(mailboxes.id, w.legs[1]!.id));
    await w.legs[0]!.laptopCycle(3);
    await w.legs[0]!.readerCycle(4);
    expect(await w.states()).toEqual(["0:applied", "1:sent"]);
    return w;
  }

  it("a leg on a disabled mailbox is no leg — the row goes at the live holder's ack", async () => {
    const w = await otherLegLeaves("disabled");
    expect(await w.rowsOf(w.here)).toEqual([]);
    expect(w.unfinished()).toBe(0);
  });

  it("CONTROL: a mailbox in error is still live — its unanswered leg holds the row", async () => {
    const w = await otherLegLeaves("error");
    expect(await w.rowsOf(w.here)).toEqual(["ohmail/News"]);
    expect(w.unfinished()).toBe(1);
  });
});
