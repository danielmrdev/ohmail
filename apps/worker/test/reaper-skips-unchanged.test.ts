import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mailboxes, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import type { ChangeBatch, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { makeDrizzleRepo, type DrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { runSyncCycle } from "../src/sync.js";
import { TOMBSTONE_MAX_PER_CYCLE } from "../src/junk-filing.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * THE REAPER RUNS ONLY WHEN A REMOVED INSTANCE COULD HAVE MADE A VICTIM (PERF-026). Its candidate
 * read is the whole mailbox (`instancelessCandidates`, 64-90 ms on the large store) and it ran on every
 * idle drain. Skipped on a batch the adapter marks `unchanged` — an empty batch removes no instance —
 * while THIS connection's last reap took less than its limit; a new connection reaps first.
 */
const ACCOUNT = "00000000-0000-4000-8000-00000000fe26";

async function rig(): Promise<{
  cycle: (adapter: MailboxAdapter) => Promise<unknown>;
  reaps: number[];
  answer: number[];
  adapter: (unchanged: () => boolean) => MailboxAdapter;
}> {
  const db = (await makeTestDb()) as unknown as Tx;
  const [mb] = await db.insert(mailboxes).values({
    accountId: ACCOUNT, provider: "imap", address: `reap-${randomUUID().slice(0, 8)}@x.test`,
  }).returning();
  const mailboxId = mb!.id;
  /** One entry per reap, the limit it was asked with; `answer` is what the next reaps report. */
  const reaps: number[] = [];
  const answer: number[] = [];
  const counting = (r: DrizzleRepo): DrizzleRepo => new Proxy(r, {
    get(target, prop, recv) {
      const value = Reflect.get(target, prop, recv) as unknown;
      if (prop === "tombstoneInstanceless") {
        return async (_a: string, _m: string, limit: number): Promise<number> => {
          reaps.push(limit);
          return answer.shift() ?? 0;
        };
      }
      if (prop === "transaction" && typeof value === "function") {
        return (fn: (x: DrizzleRepo) => Promise<unknown>): unknown =>
          (value as (f: (x: DrizzleRepo) => Promise<unknown>) => unknown).call(target, (tx) => fn(counting(tx)));
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as DrizzleRepo;
  const repo = counting(makeDrizzleRepo(db as never));
  const fleet = new FakeAdapterFleet();
  const adapter = (unchanged: () => boolean): MailboxAdapter => {
    const inner = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId: ACCOUNT, mailboxId, onConnectionError: () => { /* nothing dials here */ } },
    );
    return new Proxy(inner, {
      get(target, prop, recv) {
        if (prop === "changesSince") {
          return async (...args: unknown[]): Promise<ChangeBatch> => {
            const b = await (target.changesSince as (...a: unknown[]) => Promise<ChangeBatch>).apply(target, args);
            return unchanged() ? { ...b, unchanged: true } : b;
          };
        }
        const value = Reflect.get(target, prop, recv) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  };
  const cycle = (a: MailboxAdapter): Promise<unknown> => runSyncCycle({
    writeAuthority: FIXTURE_LEASE,
    repo, adapter: a, accountId: ACCOUNT, mailboxId, storageCap: UNMETERED_STORAGE_CAP,
    role: "organizer", trustedAuthservIds: new Set<string>(),
  });
  return { cycle, reaps, answer, adapter };
}

describe("the reaper on an unchanged pass", () => {
  it("reaps on a changed pass, skips an unchanged one, and reaps again when the server moves", async () => {
    const { cycle, reaps, adapter } = await rig();
    let unchanged = false;
    const a = adapter(() => unchanged);
    await cycle(a);
    expect(reaps, "the positive control: an ordinary pass reaps").toEqual([TOMBSTONE_MAX_PER_CYCLE]);
    unchanged = true;
    await cycle(a);
    await cycle(a);
    expect(reaps, "an unchanged pass still read the whole mailbox for victims").toHaveLength(1);
    unchanged = false;
    await cycle(a);
    expect(reaps).toHaveLength(2);
  });

  it("keeps reaping while the last reap took its whole limit", async () => {
    const { cycle, reaps, answer, adapter } = await rig();
    let unchanged = false;
    const a = adapter(() => unchanged);
    answer.push(TOMBSTONE_MAX_PER_CYCLE, TOMBSTONE_MAX_PER_CYCLE, 3);
    await cycle(a);
    unchanged = true;
    await cycle(a);
    await cycle(a);
    expect(reaps, "victims were left behind a full reap and the next pass skipped them").toHaveLength(3);
    await cycle(a);
    expect(reaps).toHaveLength(3);
  });

  it("reaps first on a new connection, whatever the pass says", async () => {
    const { cycle, reaps, adapter } = await rig();
    await cycle(adapter(() => true));
    expect(reaps).toHaveLength(1);
  });
});
