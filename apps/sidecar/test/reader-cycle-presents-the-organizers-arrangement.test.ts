import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, count, eq, isNull } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, MoveManyResult,
  NativeLocator, OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import { formatClaim, type LeaseIo, type RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import {
  formatProfileMessage, makeProfileDoc, type ProfileIo, type RawProfileMessage,
} from "@trafficflow/core/adapters/organizer-profile";
import { changeLog, folderState, mailboxProfileMirror, mailboxes, routingDecisions, rules } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { authorizeOrganizerTakeover } from "../src/organize-here.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * A READING DESKTOP PRESENTS THE ORGANIZER'S ARRANGEMENT AND ROUTES NOTHING. The engine's own
 * reader arm, over an adapter that CARRIES `profileIo` (without one the arm is skipped and every
 * assertion below would pass for nothing): each cycle caches the host's document, the local feed
 * serves it as `mailbox_profile`, and the rules table, the folder state and the wire stay still.
 */

let nowMs = Date.parse("2026-09-26T08:00:00.000Z");
const now = (): Date => new Date(nowMs);
const ADDRESS = "owner@trafficflow.test";
const HOST = "local-host-install";
const LET_IN = "letin@sender.test";

class MetaWorld {
  claims: RawClaimMessage[] = [];
  profileReads = 0;
  moves = 0;
  private profiles: RawProfileMessage[] = [];

  /** The host takes the mailbox, and has published one decision: B is let in. */
  hostOrganizes(): void {
    this.claims = [{
      ref: 1,
      raw: formatClaim({
        authorizedAt: new Date(nowMs - 1_000), capabilities: ["requests"],
        installId: HOST, kind: "local", displayName: "Host",
        heartbeat: new Date(nowMs), claimedAt: new Date(nowMs - 60_000), nonce: "host",
      }),
    }];
    const doc = makeProfileDoc({
      screener: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null,
      rules: [{ kind: "sender", match: LET_IN, destination: "INBOX", priority: 0, enabled: true, provenance: "promoted" }],
    }, { updatedAt: new Date(nowMs - 30_000), producer: { kind: "local", version: "dev" } });
    this.profiles = [{ ref: 9, raw: formatProfileMessage(doc, { installId: HOST }), generation: 4_100 }];
  }

  readonly lease: LeaseIo = {
    ensureMetaFolder: async (): Promise<void> => undefined,
    listClaims: async (): Promise<RawClaimMessage[]> => this.claims.map((c) => ({ ...c })),
    appendClaim: async (raw: string): Promise<void> => { this.claims.push({ ref: 100 + this.claims.length, raw }); },
    removeClaims: async (refs: readonly unknown[]): Promise<void> => {
      const gone = new Set(refs);
      this.claims = this.claims.filter((c) => !gone.has(c.ref));
    },
    uidValidity: (): number => 4_100,
  };

  readonly profile: ProfileIo = {
    ensureMetaFolder: async (): Promise<void> => undefined,
    listProfileMessages: async (): Promise<RawProfileMessage[]> => {
      this.profileReads += 1;
      return this.profiles.map((p) => ({ ...p }));
    },
    appendProfile: async (): Promise<void> => { throw new Error("a reader wrote the settings document"); },
    removeProfiles: async (): Promise<void> => { throw new Error("a reader removed the settings document"); },
  };
}

function rigAdapter(meta: MetaWorld): (cfg: ImapConfig) => MailboxAdapter {
  const empty: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
  const adapter: MailboxAdapter & Record<string, unknown> = {
    leaseIo: () => meta.lease,
    profileIo: () => meta.profile,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { ...empty }; },
    async move(locator: NativeLocator, toFolder: string): Promise<NativeLocator> {
      meta.moves += 1;
      return { folder: toFolder, ref: locator.ref };
    },
    async moveMany(locators: readonly NativeLocator[], toFolder: string): Promise<MoveManyResult> {
      meta.moves += locators.length;
      return { outcome: "batched", gone: [], moved: new Map(locators.map((l) => [l.ref, { folder: toFolder, ref: l.ref }])) };
    },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  } as MailboxAdapter & Record<string, unknown>;
  return () => adapter;
}

describe("a reading desktop's cycle", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    nowMs = Date.parse("2026-09-26T08:00:00.000Z");
  });

  async function boot(meta: MetaWorld): Promise<Sidecar> {
    const dataDir = await freshDataDir("ohmail-reader-arrangement-");
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: ADDRESS, pass: "not-dialled-password-password" } },
      address: ADDRESS,
      machineName: "reading guest",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 24 * 3600 * 1000,
      adapterFactory: rigAdapter(meta),
      now,
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    await sidecar.db.update(mailboxes)
      .set({ organizeConsentedAt: new Date(nowMs), organizerRole: "organizer" })
      .where(isNull(mailboxes.organizeConsentedAt));
    await sidecar.start();
    nowMs += 5_000;
    return sidecar;
  }

  const tally = async (s: Sidecar) => ({
    rules: (await s.db.select({ n: count() }).from(rules))[0]!.n,
    pending: (await s.db.select({ n: count() }).from(folderState).where(eq(folderState.reconcileStatus, "pending")))[0]!.n,
    decisions: (await s.db.select({ n: count() }).from(routingDecisions))[0]!.n,
  });

  it("caches the host's document, serves it, and changes nothing it could route by", async () => {
    const meta = new MetaWorld();
    const sidecar = await boot(meta);
    meta.hostOrganizes();
    const before = await tally(sidecar);

    for (let cycle = 0; cycle < 3; cycle++) {
      await sidecar.syncMailbox(sidecar.world.mailboxId);
      nowMs += 6 * 60 * 1000;
    }
    expect(sidecar.organizerState().organizing, "the host's claim did not make this install a reader").toBe(false);
    expect(meta.profileReads, "the reader arm never read the document — the double measured nothing").toBeGreaterThan(0);

    const [cached] = await sidecar.db.select().from(mailboxProfileMirror)
      .where(eq(mailboxProfileMirror.mailboxId, sidecar.world.mailboxId));
    expect(cached, "the reader cycle cached no document").toBeDefined();
    const rings = await sidecar.db.select().from(changeLog).where(and(
      eq(changeLog.accountId, sidecar.world.accountId), eq(changeLog.entityType, "mailbox_profile"),
    ));
    // Two: the stand-down, and the first cached copy; the later cycles re-read the same document.
    expect(rings.length, "the cached document was never announced on the local feed").toBe(2);

    const res = await sidecar.handle(new Request("http://sidecar/sync/snapshot", {
      headers: { authorization: `Bearer ${sidecar.sessionToken}` },
    }));
    expect(res.status).toBe(200);
    const page = await res.json() as { changes: Array<{ type: string; id: string; entity: { rules: Array<{ match: string }> } }> };
    const served = page.changes.filter((c) => c.type === "mailbox_profile");
    expect(served.map((c) => c.id)).toEqual([sidecar.world.mailboxId]);
    expect(served[0]!.entity.rules.map((r) => r.match)).toEqual([LET_IN]);

    // A reader routes nothing: the organizer's rules never became local rows, nothing moved.
    expect(await tally(sidecar)).toEqual(before);
    expect(before.rules).toBe(0);
    expect(meta.moves).toBe(0);

    // THE PROMOTION: the host lets go, the person asks this install to organize, the next cycle
    // takes it — and the arrangement leaves the feed, because the local rules decide from here.
    meta.claims = [];
    const asked = await authorizeOrganizerTakeover(sidecar.db, {
      mailboxId: sidecar.world.mailboxId, now: now(), intent: "takeover",
    });
    expect(asked.outcome).toBe("authorized");
    await sidecar.syncMailbox(sidecar.world.mailboxId);
    expect(sidecar.organizerState().organizing, "the takeover did not promote this install").toBe(true);
    const after = await sidecar.db.select().from(changeLog).where(and(
      eq(changeLog.accountId, sidecar.world.accountId), eq(changeLog.entityType, "mailbox_profile"),
    ));
    expect(after.length, "the promotion was never announced").toBe(3);
    const again = await sidecar.handle(new Request("http://sidecar/sync/snapshot", {
      headers: { authorization: `Bearer ${sidecar.sessionToken}` },
    }));
    const next = await again.json() as { changes: Array<{ type: string }> };
    expect(next.changes.filter((c) => c.type === "mailbox_profile")).toHaveLength(0);
  });
});
