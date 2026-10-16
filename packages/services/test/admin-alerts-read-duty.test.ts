import { describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxes } from "@trafficflow/db";
import { writeHeartbeat } from "@trafficflow/db/cloud";
import { adminAlertReading, adminAlerts } from "../src/admin-service.js";

/**
 * THE BOARD READS DUTY AS THE PAGER DOES, AND NAMES WHAT IT DID NOT READ (ALERT-CONSOLE-HAS-NO-
 * PARKED-READER). The console evaluated with no parked set, so its sync_lag counted parked
 * accounts' mailboxes and said the parked set could not be read; and a rule it could not read
 * (the storage cap) read as nothing wrong. Both drivers' parked reader now reaches the console,
 * and every unread rule comes back with its reason.
 */

const NOW = new Date("2026-09-30T08:00:00.000Z");
const HOUR = 3_600_000;
type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function account(db: Db, name: string): Promise<string> {
  const [a] = await db.insert(accounts).values({ name }).returning();
  return a!.id;
}

async function staleMailbox(db: Db, accountId: string): Promise<void> {
  await db.insert(mailboxes).values({
    accountId, provider: "imap", status: "connected", lastSyncAt: new Date(NOW.getTime() - 3 * HOUR),
    createdAt: new Date(NOW.getTime() - 10 * 24 * HOUR), address: `duty-${Math.random().toString(36).slice(2, 8)}@example.test`,
  });
}

async function leader(db: Db): Promise<void> {
  await writeHeartbeat(db, {
    shardIndex: 0, instanceId: "wkr", shards: 1, mailboxes: 2, expected: 2, accounts: 2, quarantined: 0,
    degraded: false, aiCircuitOpenSince: null, lastCycleAt: new Date(NOW.getTime() - 10_000),
    startedAt: new Date(NOW.getTime() - HOUR),
  }, new Date(NOW.getTime() - 10_000));
}

describe("the console's alert read takes the host's parked reader", () => {
  it("a parked account's stale mailbox is off the board's count, and the exclusion is stated", async () => {
    const db = await makeTestDb();
    await leader(db);
    const parked = await account(db, "Parked");
    const onDuty = await account(db, "On duty");
    await staleMailbox(db, parked);
    await staleMailbox(db, onDuty);
    const reader = async (ids: readonly string[]) => new Set(ids.filter((id) => id === parked));

    const alerts = await adminAlerts(db as never, NOW, { parkedAccounts: reader });
    const lag = alerts.find((a) => a.kind === "sync_lag");
    expect(lag?.count, "only the on-duty account's mailbox is behind").toBe(1);
    expect(lag?.detail).toContain("further stale mailbox(es) belong to accounts this deployment has PARKED");
    expect(lag?.detail).not.toContain("Which accounts are parked could not be read");

    const unstated = (await adminAlerts(db as never, NOW)).find((a) => a.kind === "sync_lag");
    expect(unstated?.count, "control: without the reader both mailboxes count").toBe(2);
  });

  it("names the rules it did not read, with the reason, instead of reading them as zero", async () => {
    const db = await makeTestDb();
    await leader(db);
    const { unread } = await adminAlertReading(db as never, NOW, { parkedAccounts: null });
    expect(unread).toContainEqual({ kind: "storage_at_cap", reason: "no_reader" });
    expect(unread.map((u) => u.kind)).not.toContain("sync_lag");
  });
});
