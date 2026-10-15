import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ImapBoundExceeded,
  type ChangeBatch, type FetchedPart, type ImapCapabilities, type MailboxAdapter, type NativeLocator,
  type SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, LeasePeekIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { isNull } from "drizzle-orm";
import { mailboxes } from "@trafficflow/db";
import { createSidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * The desktop's and the phone's engine name the ceiling that ended a cycle, as the hosted
 * worker's line does: `mailbox_start_failed` (the launch's first drain) and `sync_cycle_failed`
 * carry `ceiling` and `ceilingLimit` for one of our read ceilings, and null for any other failure.
 */

class MemoryMeta implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
  }
  uidValidity(): number | bigint | null { return 4_100; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(installId)).map((c) => ({ ...c }));
  }
}

/** A connection whose every read pass fails with `failure`. */
function failingAdapter(failure: unknown) {
  const meta = new MemoryMeta();
  return (): MailboxAdapter & { leaseIo(): LeaseIo; leasePeekIo(): LeasePeekIo } => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: async () => meta.listClaims() }),
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { throw failure; },
    async move(_l: NativeLocator, toFolder: string): Promise<NativeLocator> { return { folder: toFolder, ref: "7:41" }; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart in this rig"); },
    async send(): Promise<SendResult> { throw new Error("no send in this rig"); },
  });
}

describe("the local engine's failed cycle names the ceiling", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  async function firstFailure(failure: unknown): Promise<{ launch: Record<string, unknown>; cycle: Record<string, unknown> }> {
    const dataDir = await freshDataDir("ohmail-ceiling-log-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const events: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const s = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "pw" } },
      address: "owner@trafficflow.test",
      machineName: "the machine under test",
      pollIntervalMs: 40,
      leaseStaleAfterMs: 60_000,
      keks: { 1: Buffer.alloc(32, 5) },
      adapterFactory: failingAdapter(failure),
      log: (event, detail) => { events.push({ event, detail: (detail ?? {}) as Record<string, unknown> }); },
    });
    cleanups.push(async () => { await s.stop().catch(() => undefined); });
    await s.db.update(mailboxes)
      .set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
      .where(isNull(mailboxes.organizeConsentedAt));
    await s.start().catch(() => undefined);
    await vi.waitFor(() => {
      expect(events.some((e) => e.event === "sync_cycle_failed")).toBe(true);
    }, { timeout: 10_000, interval: 20 });
    const launch = events.find((e) => e.event === "mailbox_start_failed");
    expect(launch, "the launch's first drain failed and said nothing").toBeDefined();
    return { launch: launch!.detail, cycle: events.find((e) => e.event === "sync_cycle_failed")!.detail };
  }

  it("a cycle that met cycle_deadline reports the bound and its limit", async () => {
    const { launch, cycle } = await firstFailure(new ImapBoundExceeded("cycle_deadline", 300_000, 347_382, "INBOX"));
    for (const detail of [launch, cycle]) {
      expect(detail.ceiling).toBe("cycle_deadline");
      expect(detail.ceilingLimit).toBe(300_000);
    }
  });

  it("THE CONTROL: a failure of another class names none", async () => {
    const { launch, cycle } = await firstFailure(new Error("socket said something odd"));
    for (const detail of [launch, cycle]) {
      expect(detail.ceiling).toBeNull();
      expect(detail.ceilingLimit).toBeNull();
    }
  });
});
