import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import { accounts, drafts, mailboxes, outboundSends, parkedAccountsOf, UNMETERED } from "@trafficflow/db";
import { alertState, apiFaults } from "../src/cloud.js";
import { OUTLIVED_REQUEST_ERROR_CLASS, recordApiFault } from "../src/api-faults.js";
import {
  escalates, evaluateAlerts, raisedPeak, runAlertPass, writeHeartbeat, type Alert, type AlertSink,
} from "../src/alerts.js";

/**
 * The page schedule an operator lives with (2026-09-25): a false `sync_lag:critical` about
 * parked accounts mailed hourly for three days, a re-opened fault paged at once, and a count
 * that moved every pass re-paged each cadence. Each case names the rule it holds.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;

const NOW = new Date("2026-09-25T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms: number): Date => new Date(NOW.getTime() + ms);
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

async function seedAccount(db: Db): Promise<string> {
  const [acct] = await db.insert(accounts).values({ name: "Schedule" }).returning();
  return acct!.id;
}

async function seedHeartbeat(db: Db): Promise<void> {
  await writeHeartbeat(db, {
    shardIndex: 0, instanceId: "wkr-test", shards: 1,
    mailboxes: 1, expected: 1, accounts: 1, quarantined: 0, degraded: false,
    aiCircuitOpenSince: null, lastCycleAt: NOW, startedAt: ago(HOUR),
  }, NOW);
}

async function seedMailbox(db: Db, accountId: string, lastSyncAt: Date): Promise<string> {
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", status: "connected", lastSyncAt, createdAt: ago(10 * 24 * HOUR),
    address: `sched-${Math.random().toString(36).slice(2, 8)}@example.test`,
  }).returning();
  return mb!.id;
}

/** One pending send created an hour ago: `sends_stuck`, critical, a signature that stays put. */
async function seedStuckSend(db: Db, accountId: string, tag: string): Promise<void> {
  const mailboxId = await seedMailbox(db, accountId, NOW);
  const [draft] = await db.insert(drafts).values({ accountId, mailboxId }).returning();
  await db.insert(outboundSends).values({
    accountId, idempotencyKey: `idem-${tag}`, draftId: draft!.id,
    mintedMessageId: `<${tag}@app.ohmail.app>`, status: "pending", createdAt: ago(HOUR),
  });
}

const setSend = (db: Db, tag: string, status: "pending" | "sent") =>
  db.update(outboundSends).set({ status }).where(eq(outboundSends.idempotencyKey, `idem-${tag}`));

interface Notice { key: string; resolvedAt: string }

/** Records pages and resolution notices; `notifyResolved` is optional on the sink contract. */
function spySink(): AlertSink & { pages: string[][]; resolved: Notice[][] } {
  const pages: string[][] = [];
  const resolved: Notice[][] = [];
  return {
    name: "spy", pages, resolved,
    async notify(alerts: readonly Alert[]) { pages.push(alerts.map((a) => a.key)); return true; },
    async notifyResolved(notices: readonly Notice[]) {
      resolved.push(notices.map((n) => ({ key: n.key, resolvedAt: n.resolvedAt })));
      return true;
    },
  } as AlertSink & { pages: string[][]; resolved: Notice[][] };
}

const paged = (r: { notified: Alert[] }, key: string): boolean => r.notified.some((a) => a.key === key);

describe("an account the roster parks is never on duty for the pager", () => {
  it("the roster's reader, handed to the pass, takes a parked account's stale mailbox off the page", async () => {
    const db = await makeTestDb();
    const parked = await seedAccount(db);
    const onDuty = await seedAccount(db);
    await seedHeartbeat(db);
    await seedMailbox(db, parked, ago(3 * 24 * HOUR));
    await seedMailbox(db, onDuty, NOW);
    const reader = parkedAccountsOf({
      access: async (id: string) => (id === parked ? { ok: false, reason: "payment_required" } : { ok: true }),
    } as never);
    const alerts = await evaluateAlerts(db, { now: NOW, parkedAccounts: reader });
    expect(alerts.some((a) => a.kind === "sync_lag"), "a parked account's mailbox is not behind").toBe(false);
    expect(parkedAccountsOf(UNMETERED), "an unmetered host parks nobody and says so").toBeNull();
  });

  it("'not receiving mail' is said only where duty was measured", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedHeartbeat(db);
    await seedMailbox(db, a, ago(3 * HOUR));
    const unstated = (await evaluateAlerts(db, { now: NOW })).find((x) => x.key === "sync_lag:critical")!;
    expect(unstated.detail, "no reader was stated, so parked accounts may be in the count")
      .not.toContain("not receiving mail");
    const measured = (await evaluateAlerts(db, { now: NOW, parkedAccounts: null }))
      .find((x) => x.key === "sync_lag:critical")!;
    expect(measured.detail, "a host that parks nobody measured every mailbox on duty")
      .toContain("not receiving mail");
  });
});

describe("a standing critical pages three times, then daily", () => {
  it("an unchanged critical is not due at the fourth hour, and is due again after a day", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedStuckSend(db, a, "hourly");
    const sink = spySink();
    const pass = (ms: number) => runAlertPass(db, { now: at(ms), sinks: [sink], shards: [] });

    expect(paged(await pass(0), "sends_stuck"), "the first page").toBe(true);
    expect(paged(await pass(HOUR + MIN), "sends_stuck"), "the first hourly reminder").toBe(true);
    expect(paged(await pass(2 * HOUR + 2 * MIN), "sends_stuck"), "the second hourly reminder").toBe(true);
    expect(paged(await pass(3 * HOUR + 3 * MIN), "sends_stuck"), "three pages, then it holds").toBe(false);
    expect(paged(await pass(4 * HOUR + 4 * MIN), "sends_stuck")).toBe(false);
    expect(paged(await pass(2 * HOUR + 2 * MIN + 24 * HOUR + MIN), "sends_stuck"), "the daily reminder").toBe(true);
  });

  it("a critical re-opened ten minutes after it resolved keeps its send history", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedStuckSend(db, a, "flap");
    const sink = spySink();
    const pass = (ms: number) => runAlertPass(db, { now: at(ms), sinks: [sink], shards: [] });

    expect(paged(await pass(0), "sends_stuck")).toBe(true);
    await setSend(db, "flap", "sent");
    expect((await pass(5 * MIN)).resolved).toEqual(["sends_stuck"]);
    await setSend(db, "flap", "pending");
    expect(paged(await pass(15 * MIN), "sends_stuck"), "a flap is not a new page").toBe(false);
    const [row] = await db.select().from(alertState).where(eq(alertState.alertKey, "sends_stuck"));
    expect(row!.notifyCount, "the history survived the flap").toBe(1);
    expect(new Date(row!.openedAt).toISOString(), "the occurrence continues").toBe(NOW.toISOString());
  });

  it("a re-open past the flap floor is a new occurrence and pages at once", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedStuckSend(db, a, "reopen");
    const sink = spySink();
    const pass = (ms: number) => runAlertPass(db, { now: at(ms), sinks: [sink], shards: [] });

    await pass(0);
    await setSend(db, "reopen", "sent");
    await pass(5 * MIN);
    await setSend(db, "reopen", "pending");
    expect(paged(await pass(5 * MIN + HOUR + MIN), "sends_stuck")).toBe(true);
  });

  it("sync_lag's worst age doubling re-pages inside the hour; the same bucket does not", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedMailbox(db, a, ago(3 * HOUR + 50 * MIN));
    const sink = spySink();
    const pass = (ms: number) => runAlertPass(db, { now: at(ms), sinks: [sink], shards: [], parkedAccounts: null });

    expect(paged(await pass(0), "sync_lag:critical")).toBe(true);
    expect(paged(await pass(5 * MIN), "sync_lag:critical"), "3h55m is still the 2h bucket").toBe(false);
    expect(paged(await pass(15 * MIN), "sync_lag:critical"), "4h05m crossed into the 4h bucket").toBe(true);
    expect(paged(await pass(20 * MIN), "sync_lag:critical")).toBe(false);
  });

  it("a fault count that moves every pass keeps its signature until it doubles", async () => {
    const db = await makeTestDb();
    const route = "entitlements:/v1/access";
    const fault = (n: number) => Promise.all(Array.from({ length: n }, (_, i) => recordApiFault(db, {
      at: ago(MIN), route, method: "GET", status: 504, errorClass: "EntitlementsCallTimeout",
      requestId: `r-${Math.random().toString(36).slice(2)}-${i}`, arm: "api",
    })));
    const sig = async (): Promise<string | undefined> =>
      (await evaluateAlerts(db, { now: NOW })).find((x) => x.kind === "api_fault_rate")?.signature;
    await fault(150);
    const at150 = await sig();
    await fault(10);
    expect(await sig(), "160 faults is the same state as 150").toBe(at150);
    await fault(100);
    expect(await sig(), "260 faults is a doubling").not.toBe(at150);
  });
});

describe("one resolved mail per key that paged, once the resolution holds", () => {
  it("is sent after the flap floor, once, and never for a key that never paged", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedStuckSend(db, a, "resolved");
    const sink = spySink();
    const pass = (ms: number) => runAlertPass(db, { now: at(ms), sinks: [sink], shards: [] });

    await pass(0);
    await setSend(db, "resolved", "sent");
    await pass(5 * MIN);
    await pass(30 * MIN);
    expect(sink.resolved, "inside the flap floor nothing is said yet").toEqual([]);
    await pass(5 * MIN + HOUR + MIN);
    expect(sink.resolved.flat().map((n) => n.key)).toEqual(["sends_stuck"]);
    expect(sink.resolved.flat()[0]!.resolvedAt).toBe(at(5 * MIN).toISOString());
    await pass(3 * HOUR);
    expect(sink.resolved, "one resolved mail, not one per pass").toHaveLength(1);
  });

  it("a key that fired while no sink could deliver is never told it resolved", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    await seedStuckSend(db, a, "silent");
    const sink = spySink();
    await runAlertPass(db, { now: NOW, sinks: [], shards: [] });
    await setSend(db, "silent", "sent");
    await runAlertPass(db, { now: at(5 * MIN), sinks: [sink], shards: [] });
    await runAlertPass(db, { now: at(2 * HOUR), sinks: [sink], shards: [] });
    expect(sink.resolved).toEqual([]);
  });
});

/**
 * The 2026-09-28 sequence on `entitlements:/v1/access`: the window's count climbed 13, 25, 35 and
 * fell back inside forty minutes, and every doubling crossed, either way, paged again — five mails
 * for one incident. Both drivers run this pass, so they take turns here.
 */
describe("a page goes out on escalation only", () => {
  const ROUTE = "entitlements:/v1/access";
  const KEY = `api_fault_rate:api:${ROUTE}`;
  const faultsAt = (db: Db, when: Date, n: number) => Promise.all(Array.from({ length: n }, (_, i) =>
    recordApiFault(db, {
      at: when, route: ROUTE, method: "POST", status: 504, errorClass: "EntitlementsCallTimeout",
      requestId: null, arm: "api",
    }).then(() => i)));

  it("13, 25, 35 and back down: one page per higher doubling, none on the fall, one resolved mail", async () => {
    const db = await makeTestDb();
    const sink = spySink();
    const pages = (): number => sink.pages.filter((p) => p.includes(KEY)).length;
    // Ten-minute steps, so each pass's window holds exactly the rows written just before it.
    const counts = [13, 25, 35, 25, 13, 0];
    const seen: number[] = [];
    for (const [k, n] of counts.entries()) {
      if (n > 0) await faultsAt(db, at(k * 10 * MIN - MIN), n);
      await runAlertPass(db, {
        now: at(k * 10 * MIN), sinks: [sink], shards: [], driver: k % 2 === 0 ? "worker" : "api",
      });
      seen.push(pages());
    }
    expect(seen, "13 pages, 25 and 35 each cross a higher doubling, the fall pages nothing")
      .toEqual([1, 2, 3, 3, 3, 3]);
    expect(sink.resolved, "nothing is said until the resolution holds").toEqual([]);
    await runAlertPass(db, { now: at(50 * MIN + HOUR + MIN), sinks: [sink], shards: [], driver: "worker" });
    await runAlertPass(db, { now: at(50 * MIN + HOUR + 2 * MIN), sinks: [sink], shards: [], driver: "api" });
    expect(sink.resolved.flat().map((n) => n.key), "one resolved mail for the firing").toEqual([KEY]);
  });

  it("a re-open inside the flap floor pages only past the highest doubling already sent", async () => {
    const db = await makeTestDb();
    const sink = spySink();
    const pages = (): number => sink.pages.filter((p) => p.includes(KEY)).length;
    await faultsAt(db, at(-MIN), 40);
    await runAlertPass(db, { now: NOW, sinks: [sink], shards: [] });
    await runAlertPass(db, { now: at(15 * MIN), sinks: [sink], shards: [] });
    await faultsAt(db, at(19 * MIN), 20);
    await runAlertPass(db, { now: at(20 * MIN), sinks: [sink], shards: [] });
    expect(pages(), "20 after 40 is a fall inside one firing").toBe(1);
    await faultsAt(db, at(29 * MIN), 70);
    await runAlertPass(db, { now: at(30 * MIN), sinks: [sink], shards: [] });
    expect(pages(), "70 is past the 32 already sent").toBe(2);
  });

  it("a reminder at a lower count keeps the peak, so a climb back below it pages nothing", async () => {
    const db = await makeTestDb();
    const sink = spySink();
    const pages = (): number => sink.pages.filter((p) => p.includes(KEY)).length;
    // 40 at the start, then 20 every nine minutes: the key fires throughout, never past 32.
    await faultsAt(db, at(-MIN), 40);
    for (let m = 8; m <= 53; m += 9) await faultsAt(db, at(m * MIN), 20);
    for (let m = 0; m <= 54; m += 9) await runAlertPass(db, { now: at(m * MIN), sinks: [sink], shards: [] });
    expect(pages(), "one page at 40").toBe(1);
    const reminder = await runAlertPass(db, { now: at(61 * MIN + 30_000), sinks: [sink], shards: [] });
    expect(reminder.notified.map((a) => a.count), "the hourly reminder goes out at 20").toEqual([20]);
    await faultsAt(db, at(62 * MIN), 20);
    await faultsAt(db, at(71 * MIN), 15);
    const back = await runAlertPass(db, { now: at(72 * MIN), sinks: [sink], shards: [] });
    expect(back.firing.find((a) => a.key === KEY)?.count).toBe(35);
    expect(pages(), "35 is not past the 32 the first page reached").toBe(2);
  });
});

describe("the peak a firing has paged", () => {
  const alert = (severity: "warning" | "critical", count: number, levels?: number[]): Alert => ({
    key: "k", kind: "api_fault_rate", severity, title: "t", detail: "d", count, oldestSeconds: null,
    ...(levels ? { levels } : {}),
  });

  it("a first page records its own badness, and only a worse one escalates past it", () => {
    const peak = raisedPeak(null, alert("warning", 13));
    expect(peak, "warning (1), one step per doubling (8)").toBe("peak|1|8");
    expect(escalates(peak, alert("warning", 15)), "same doubling").toBe(false);
    expect(escalates(peak, alert("warning", 4)), "a fall").toBe(false);
    expect(escalates(peak, alert("warning", 16)), "the next doubling").toBe(true);
    expect(escalates(peak, alert("critical", 4)), "a higher severity at a lower count").toBe(true);
  });

  it("the peak never falls, position by position", () => {
    const high = raisedPeak(null, alert("critical", 1, [8, 2]));
    const after = raisedPeak(high, alert("critical", 1, [2, 5]));
    expect(after, "a reminder at a lower level keeps the higher one").toBe("peak|2|8|5");
    expect(escalates(after, alert("critical", 1, [4, 5]))).toBe(false);
    expect(escalates(after, alert("critical", 1, [4, 6])), "a second dimension").toBe(true);
  });

  it("a value that states no peak escalates nothing, so a deploy pages no standing alert", () => {
    for (const legacy of [null, "critical|1", "faults|32", "peak|", "peak|x|1", "never"]) {
      expect(escalates(legacy, alert("critical", 1_000)), String(legacy)).toBe(false);
    }
  });
});

describe("a credit-check call that outlived its request is not a 5xx the API served", () => {
  const ROUTE = "entitlements:/v1/access";
  const rowsOf = (db: Db, errorClass: string, n: number) =>
    Promise.all(Array.from({ length: n }, () => recordApiFault(db, {
      at: ago(MIN), route: ROUTE, method: "POST", status: 504, errorClass, requestId: null,
      arm: "api",
    })));
  const fires = async (db: Db): Promise<boolean> =>
    (await evaluateAlerts(db, { now: NOW })).some((x) => x.key === `api_fault_rate:api:${ROUTE}`);

  it("thirty of them page nobody, and they are still on the record", async () => {
    const db = await makeTestDb();
    await rowsOf(db, OUTLIVED_REQUEST_ERROR_CLASS, 30);
    expect(await fires(db), "a refresh nobody waited on answered no request").toBe(false);
    expect(await db.select().from(apiFaults), "the rows are kept for the board").toHaveLength(30);
  });

  it("control: the same count of calls a request waited on still pages", async () => {
    const db = await makeTestDb();
    await rowsOf(db, "EntitlementsCallTimeout", 30);
    expect(await fires(db)).toBe(true);
  });
});
