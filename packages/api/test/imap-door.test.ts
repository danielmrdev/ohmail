import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
/* The counter lives in the HOSTED schema, whose barrel a local install never imports — so the
   table comes from `/cloud` beside the two functions that write it, not from the root. */
import { acquireImapSlot, authThrottle, imapAdmissionKey, releaseImapSlot } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { eq } from "drizzle-orm";
import {
  IMAP_DOOR_DEADLINE_MS, isImapDoorTimeout, withinDoorBudget,
} from "../src/imap-door.js";
import { JUNK_READ_TIMEOUT_MS } from "../src/junk-window.js";
import { MAX_PROBES_PER_ADDRESS, makeImapProbe, probeAdmissionKey } from "../src/imap-probe.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * ═══ AN API-SIDE IMAP DOOR ENDS ITS SOCKET BEFORE IT GIVES THE SLOT BACK ════════════════════
 *
 * Two failures, one mechanism. A door with no wall clock lets a server that accepts a command and
 * never answers hold the socket, the mailbox's admission slot and the invocation for as long as it
 * likes — and the `finally` written to release them issues a graceful LOGOUT, which the driver
 * queues BEHIND the hung command. So the teardown waits in the same queue as the hang.
 *
 * The probe had the other half: it gave the slot back while an abandoned socket might still be
 * live, because awaiting a polite close of a connection that is not answering is the wait the
 * deadline exists to remove. Destroying the socket is what makes waiting affordable.
 *
 * The BUDGET's value has its own case below; the BEHAVIOUR is driven at a short budget, because
 * "refuses within its budget and hands the slot back" is the same property at 60 ms and at 20 s.
 */

const NOW = new Date("2026-09-10T12:00:00.000Z");

async function seed(): Promise<{ deps: ApiDeps; db: Awaited<ReturnType<typeof makeTestDb>>; mailboxId: string; accountId: string }> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `door-${randomUUID().slice(0, 8)}@example.invalid`,
  }).returning({ id: mailboxes.id });
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, transport: "imap", secretEnc: "enc", keyVersion: 1,
    meta: { host: "imap.example.invalid", port: 993, secure: true, user: "u" },
  });
  const deps = {
    db,
    keyProvider: { decrypt: async () => "not-printed" },
    services: { imapAdmission: { acquire: acquireImapSlot, release: releaseImapSlot } },
    now: () => NOW,
  } as unknown as ApiDeps;
  return { deps, db, mailboxId: mb!.id, accountId };
}

/** The shared counter's own reading for one key — 0 when the row was never written. */
async function slotsHeld(db: Awaited<ReturnType<typeof makeTestDb>>, key: string): Promise<number> {
  const [row] = await db.select({ failures: authThrottle.failures })
    .from(authThrottle).where(eq(authThrottle.key, key));
  return row?.failures ?? 0;
}

const never = (): Promise<never> => new Promise<never>(() => { /* the server that never answers */ });

beforeEach(() => vi.restoreAllMocks());

describe("the door budget", () => {
  it("refuses 504 within the budget, DESTROYS the socket, and hands the slot back", async () => {
    const { deps, db, mailboxId } = await seed();
    const key = imapAdmissionKey(mailboxId);
    expect(await slotsHeld(db, key)).toBe(0);

    vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined);
    const close = vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
    const forceClose = vi.spyOn(ImapAdapter.prototype, "forceClose").mockImplementation(() => { /* destroyed */ });
    const list = vi.spyOn(ImapAdapter.prototype, "listFolderPage").mockImplementation(never);

    // WITHIN the budget, not merely eventually: the point of the clock. The door's own clock
    // decides, faked — the read is on the wire, open one tick short of the budget, refused at it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let err: unknown;
    try {
      let settled = false;
      const door = withinDoorBudget(
        deps, mailboxId, (adapter) => adapter.listFolderPage("INBOX", { limit: 10 }),
        { budgetMs: 60 },
      ).then(() => null, (e: unknown) => e).finally(() => { settled = true; });
      while (list.mock.calls.length === 0) await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(59);
      expect(settled, "the door answered before its budget ran out").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled, "the door outlived its budget").toBe(true);
      err = await door;
    } finally {
      vi.useRealTimers();
    }

    expect(isImapDoorTimeout(err)).toBe(true);
    expect((err as { httpStatus?: number }).httpStatus).toBe(504);
    // The socket is DESTROYED, never asked politely — a LOGOUT queues behind the hang.
    expect(forceClose).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    // …and the slot is back at baseline. A leaked slot shrinks this mailbox's budget until the
    // admission window rolls, which reads to the customer as every later read being busy.
    expect(await slotsHeld(db, key)).toBe(0);
  });

  it("a read that ANSWERS closes politely and also hands the slot back — the positive control", async () => {
    const { deps, db, mailboxId } = await seed();
    const key = imapAdmissionKey(mailboxId);

    vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined);
    const close = vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
    const forceClose = vi.spyOn(ImapAdapter.prototype, "forceClose").mockImplementation(() => { /* unused */ });

    const got = await withinDoorBudget(deps, mailboxId, async () => "read", { budgetMs: 5_000 });

    expect(got).toBe("read");
    expect(close).toHaveBeenCalledTimes(1);
    expect(forceClose).not.toHaveBeenCalled();
    expect(await slotsHeld(db, key)).toBe(0);
  });

  it("a DIAL that lands after we gave up on it is destroyed rather than left holding its slot", async () => {
    const { deps, db, mailboxId } = await seed();
    const key = imapAdmissionKey(mailboxId);

    let releaseConnect: (() => void) | undefined;
    vi.spyOn(ImapAdapter.prototype, "connect")
      .mockImplementation(() => new Promise<void>((resolve) => { releaseConnect = () => resolve(); }));
    vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
    const forceClose = vi.spyOn(ImapAdapter.prototype, "forceClose").mockImplementation(() => { /* destroyed */ });

    const err = await withinDoorBudget(deps, mailboxId, async () => "unreached", { budgetMs: 40 })
      .then(() => null, (e: unknown) => e);
    expect(isImapDoorTimeout(err)).toBe(true);

    // The dial comes up AFTER the refusal, holding both slots, with nobody else able to close it.
    releaseConnect?.();
    await new Promise((r) => setTimeout(r, 30));
    expect(forceClose).toHaveBeenCalledTimes(1);
    expect(await slotsHeld(db, key)).toBe(0);
  });

  it("is ONE literal: the junk window's name for the budget IS the budget", () => {
    expect(JUNK_READ_TIMEOUT_MS).toBe(IMAP_DOOR_DEADLINE_MS);
    expect(Number.isFinite(IMAP_DOOR_DEADLINE_MS)).toBe(true);
    expect(IMAP_DOOR_DEADLINE_MS).toBeGreaterThan(0);
    // Under the serverless host's 60 s invocation ceiling, or the platform answers first and the
    // stated degrade never reaches the caller.
    expect(IMAP_DOOR_DEADLINE_MS).toBeLessThan(60_000);
  });
});

describe("the probe's admission slot", () => {
  /**
   * A dialer that never comes up, recording what the probe did to it and in what order. The
   * ORDER is the property: the slot may not go back while the socket may still be live.
   */
  function stalledDialer(order: string[]) {
    return () => ({
      connect: never,
      close: async (): Promise<void> => { order.push("close"); },
      forceClose: (): void => { order.push("forceClose"); },
    });
  }

  it("destroys the abandoned socket BEFORE the slot goes back, and the slot returns to baseline", async () => {
    const { deps, db, accountId } = await seed();
    const address = `probe-${randomUUID().slice(0, 8)}@example.invalid`;
    const key = probeAdmissionKey(accountId, address);
    const namespaced = imapAdmissionKey(key);
    const order: string[] = [];

    const admission = {
      acquire: acquireImapSlot,
      release: async (...args: Parameters<typeof releaseImapSlot>): Promise<void> => {
        order.push("release");
        await releaseImapSlot(...args);
      },
    };
    (deps as unknown as { services: Record<string, unknown> }).services = { imapAdmission: admission };

    // ABOVE the ladder's own 250 ms floor: below it the walk breaks before dialling a rung, so a
    // shorter budget would prove the refusal without ever reaching the socket it is about.
    const probe = makeImapProbe(deps, { deadlineMs: 400, adapterFactory: stalledDialer(order) });
    const verdict = await probe({
      accountId, address,
      imap: { host: "imap.example.invalid", port: 993, secure: true, user: "u", pass: "p" },
    });

    expect(verdict).toEqual({ verdict: "refuse", code: "timeout" });
    // The destroy runs on the abandoned rung, and the release only after it.
    expect(order.indexOf("forceClose")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("release")).toBeGreaterThan(order.indexOf("forceClose"));
    expect(order.at(-1)).toBe("release");
    expect(await slotsHeld(db, namespaced)).toBe(0);
  });

  it("an ordinary probe still admits, answers ok and gives its slot back", async () => {
    const { deps, db, accountId } = await seed();
    const address = `probe-${randomUUID().slice(0, 8)}@example.invalid`;
    const namespaced = imapAdmissionKey(probeAdmissionKey(accountId, address));

    const probe = makeImapProbe(deps, {
      maxPerAddress: MAX_PROBES_PER_ADDRESS,
      adapterFactory: () => ({
        connect: async (): Promise<void> => { /* the server that answers */ },
        close: async (): Promise<void> => { /* polite */ },
      }),
    });
    const verdict = await probe({
      accountId, address,
      imap: { host: "imap.example.invalid", port: 993, secure: true, user: "u", pass: "p" },
    });

    expect(verdict).toMatchObject({ verdict: "ok" });
    expect(await slotsHeld(db, namespaced)).toBe(0);
  });
});
