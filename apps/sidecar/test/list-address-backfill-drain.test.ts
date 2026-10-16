import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import {
  accountSettings, folderState, listAddresses, mailboxFolders, messageBodies, messageInstances, messages,
} from "@trafficflow/db";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { createSidecar, type Sidecar } from "../src/engine.js";

/**
 * THE LIST-ADDRESS BACKFILL RUNS IN A STANDALONE DRAIN, BEFORE THE RETRO (mail 0150). The store an
 * update finds already holds the person's post to `list@`, a stored message whose `List-Post` names
 * `list@`, and a company claim under `list@` the gate held. The first drain records `list@` as a list
 * address and stamps the store, and the correspondent retro that runs after it in the same drain
 * leaves the claim at the gate: the post is no consent for a name anyone on the list can write. A
 * reader records too — its store becomes the organizer's when it is promoted.
 */

class MemoryMetaFolder implements LeaseIo {
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
}

/** A mailbox with nothing new in it. */
function quietMailbox() {
  const meta = new MemoryMetaFolder();
  const empty: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
  return (_cfg: ImapConfig): MailboxAdapter & { leaseIo(): LeaseIo } => ({
    leaseIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { ...empty }; },
    async move(locator: NativeLocator, to: string): Promise<NativeLocator> { return { ...(locator as object), folder: to } as NativeLocator; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  });
}

const LIST = "list@lists.test";

describe("a standalone drain reads the list addresses before its retro", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  async function boot(organize: boolean, seed: (s: Sidecar) => Promise<void>): Promise<Sidecar> {
    const dataDir = await freshDataDir("ohmail-list-address-");
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test",
      machineName: "list host",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: quietMailbox(),
      log: () => {},
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    if (organize) await grantOrganizeConsent(sidecar);
    await seed(sidecar);
    await sidecar.start();
    return sidecar;
  }

  let uid = 40;
  /** A stored row: `folder`, its sender, the headers its body kept, and what it claims. */
  async function stored(sidecar: Sidecar, o: {
    folder: string; from: string; name?: string; to?: string; headers?: Record<string, string[]>; claim?: string;
  }): Promise<string> {
    const w = sidecar.world;
    const at = new Date(Date.now() + 60_000);
    const [m] = await sidecar.db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `lb-${uid}`, dedupKey: `lb:${uid}@test`,
      subject: o.claim ? "Ihre Karte" : "Spring meeting", fromAddress: o.from, fromName: o.name ?? null,
      messageIdHeader: `m-${uid}@test`, date: at, arrivedAt: at,
      toAddresses: o.to ? [{ name: null, address: o.to }] : [], ccAddresses: [],
      senderCheck: o.claim ? "impersonation" : null, senderCheckBrand: o.claim ?? null,
      nativeLocator: { folder: o.folder, ref: `9:${uid}` },
    }).returning();
    await sidecar.db.insert(messageInstances).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageId: m!.id, folder: o.folder, uidvalidity: 9n, uid: uid++, isPrimary: true,
    });
    await sidecar.db.insert(folderState).values({
      messageId: m!.id, desiredFolder: o.folder, observedFolder: o.folder, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    await sidecar.db.insert(messageBodies).values({ messageId: m!.id, text: "x", headers: o.headers ?? {} });
    return m!.id;
  }

  async function seedTheUpdate(sc: Sidecar): Promise<string> {
    await sc.db.insert(mailboxFolders).values({ mailboxId: sc.world.mailboxId, folder: "Sent", uidvalidity: 9n, uidnext: 100n })
      .onConflictDoNothing();
    await stored(sc, { folder: "Sent", from: "owner@trafficflow.test", to: LIST });
    await stored(sc, { folder: "INBOX", from: "member@elsewhere.test", headers: { "list-post": [`<mailto:${LIST}>`] } });
    return stored(sc, { folder: "ohmail/Screener", from: LIST, name: "PostFinance", claim: "PostFinance" });
  }

  const listed = async (s: Sidecar) => (await s.db.select({ a: listAddresses.address }).from(listAddresses)).map((r) => r.a);
  const stamp = async (s: Sidecar) => (await s.db.select({ at: accountSettings.listAddressesScannedAt }).from(accountSettings)
    .where(eq(accountSettings.accountId, s.world.accountId)))[0]?.at ?? null;
  const desiredOf = async (s: Sidecar, id: string): Promise<string> =>
    (await s.db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;

  it("ACCEPTANCE 1j: the drain records the list address and stamps, and its retro leaves the claim held", async () => {
    let claim = "";
    const sidecar = await boot(true, async (sc) => { claim = await seedTheUpdate(sc); });
    await sidecar.syncUntilQuiet();
    expect(await listed(sidecar)).toEqual([LIST]);
    expect(await stamp(sidecar)).not.toBeNull();
    expect(await desiredOf(sidecar, claim), "the retro released a claim under a list address").toBe("ohmail/Screener");
  }, 60_000);

  it("CONTROL: a reader's drain records and stamps too, and moves nothing", async () => {
    let claim = "";
    const sidecar = await boot(false, async (sc) => { claim = await seedTheUpdate(sc); });
    await sidecar.syncUntilQuiet();
    expect(await listed(sidecar)).toEqual([LIST]);
    expect(await stamp(sidecar)).not.toBeNull();
    expect(await desiredOf(sidecar, claim)).toBe("ohmail/Screener");
  }, 60_000);
});
