import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { formatClaim } from "@trafficflow/core/adapters/organizer-lease";
import { folderState, mailboxes, messageInstances, messages, organizerRequests, rules } from "@trafficflow/db";
import { freshDataDir } from "./_datadir.js";
import { createSidecar, type Sidecar } from "../src/engine.js";

/**
 * THE TAKEOVER PATH'S FIRST DECISION IS KEPT. Setup over a mailbox another install
 * holds: "Organize here instead", Agree, then the guided decision, pressed before the claim lands.
 * The door answered 409 (holder stopped) or queued a request to the holder the claim displaces
 * (holder live), so no rule was ever written and the held mail stayed at the gate. Now the door
 * writes the rule at the press, and the first organizing drain after the claim moves the held
 * mail by it (`ruleRetroPass`). To watch it fail: drop the `takeoverPending` arm of
 * `planAccountFanOut`.
 */

class MemoryMetaFolder implements LeaseIo {
  private nextUid = 1;
  readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
  }
  uidValidity(): number | bigint | null { return 4_100; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`)).map((c) => ({ ...c }));
  }
}

const EMPTY: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };

function mailbox(
  meta: MemoryMetaFolder, moves: Array<{ from: string; to: string }>,
  /** Holds every peek until it resolves — the first look still in flight. */
  peekGate: Promise<void> = Promise.resolve(),
  /** Holds the GATE's lease read — the claim not landed yet. Agreeing wakes the gate at once. */
  leaseGate: Promise<void> = Promise.resolve(),
) {
  return (_cfg: ImapConfig): MailboxAdapter & {
    leaseIo(): LeaseIo; leasePeekIo(): { listClaims(): Promise<RawClaimMessage[]> };
  } => ({
    leaseIo: () => new Proxy(meta, {
      get(target, key) {
        if (key === "listClaims") return async () => { await leaseGate; return target.listClaims(); };
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }),
    leasePeekIo: () => ({ listClaims: async () => { await peekGate; return meta.listClaims(); } }),
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { ...EMPTY }; },
    async move(locator: NativeLocator, to: string): Promise<NativeLocator> {
      moves.push({ from: (locator as { folder: string }).folder, to });
      return { ...(locator as object), folder: to } as NativeLocator;
    },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  });
}

const DAY = 24 * 60 * 60 * 1000;
const SENDER = "b@b.test";

describe("the takeover path's first decision is kept", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  /** A consent-less reader over a mailbox W-old claimed; `ageMs` 0 is a live holder. */
  async function boot(ageMs: number, leaseGate?: Promise<void>) {
    const meta = new MemoryMetaFolder();
    const at = new Date(Date.now() - ageMs);
    await meta.appendClaim(formatClaim({
      installId: "local:w-old", kind: "local", displayName: "W-old",
      heartbeat: at, claimedAt: at, nonce: "old", authorizedAt: null, capabilities: ["requests"],
    }));
    const moves: Array<{ from: string; to: string }> = [];
    const dataDir = await freshDataDir("ohmail-takeover-decide-");
    const sidecar: Sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test", machineName: "the new laptop",
      pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000,
      adapterFactory: mailbox(meta, moves, undefined, leaseGate), log: () => {},
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    await sidecar.start();
    // Two messages from the sender, held at the gate by W-old; this reader recorded them as `peer`.
    const held: string[] = [];
    for (const uid of [1, 2]) {
      const dedup = `mid:${uid}@b.test`;
      const [m] = await sidecar.db.insert(messages).values({
        accountId: sidecar.world.accountId, mailboxId: sidecar.world.mailboxId,
        messageIdHeader: dedup, bodyHash: `h-${uid}`, dedupKey: dedup, subject: `held ${uid}`,
        fromAddress: SENDER, date: new Date(Date.now() - uid * 1000),
        nativeLocator: { folder: "ohmail/Screener", ref: `1:${uid}` },
      }).returning();
      await sidecar.db.insert(messageInstances).values({
        accountId: sidecar.world.accountId, mailboxId: sidecar.world.mailboxId, messageId: m!.id,
        folder: "ohmail/Screener", uidvalidity: 1n, uid, isPrimary: true,
      });
      await sidecar.db.insert(folderState).values({
        messageId: m!.id, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
        lastSetBy: "peer", reconcileStatus: "reconciled", conflict: false,
      });
      held.push(m!.id);
    }
    const call = (method: string, path: string, body?: unknown) => sidecar.handle(new Request(`http://engine.invalid${path}`, {
      method, headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const row = async () => (await sidecar.db.select().from(mailboxes).where(eq(mailboxes.id, sidecar.world.mailboxId)))[0]!;
    /** The guided decision as the webapp sends it: Ohbox, sender scope. */
    const decide = () => call("POST", `/screener/${held[0]}`, { decision: "yes", dest: "INBOX", scope: "sender" });
    /** "Organize here instead", then Agree, on the desktop's own door: the press names the takeover. */
    const organize = async () => {
      const res = await call("POST", `/local/mailboxes/${sidecar.world.mailboxId}/organize`, {
        screening: { scope: "window" }, intent: "takeover",
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { outcome: string }).outcome).toBe("authorized");
    };
    /** An Agree that did not choose to take over — the door's own answer, unasserted. */
    const join = () => call("POST", `/local/mailboxes/${sidecar.world.mailboxId}/organize`, {
      screening: { scope: "window" }, intent: "join",
    });
    const ruleFor = async () => (await sidecar.db.select().from(rules).where(eq(rules.match, SENDER)));
    const desired = async () => (await sidecar.db.select({ id: folderState.messageId, d: folderState.desiredFolder })
      .from(folderState)).filter((r) => held.includes(r.id)).map((r) => r.d);
    const requests = async () => sidecar.db.select().from(organizerRequests);
    return { sidecar, moves, held, row, decide, organize, join, ruleFor, desired, requests, call };
  }

  it.each([["stopped", 12 * DAY], ["still renewing", 0]] as const)(
    "holder %s: the press before the claim lands is a rule at once, and no request goes to the holder",
    async (_label, age) => {
      /* THE CLAIM HELD BACK BY ITS LEASE READ: Agree now wakes the gate at once (PERF-026), so the
         window this case presses in is held open here, as a first sync in flight holds it. */
      let release!: () => void;
      const w = await boot(age, new Promise<void>((r) => { release = r; }));
      cleanups.push(() => release());
      await w.organize();
      expect((await w.row()).organizerRole, "the claim has not landed yet").toBe("reader");
      expect((await w.row()).takeoverAuthorizedAt).not.toBeNull();

      const res = await w.decide();
      const body = (await res.json()) as { mailboxes?: { filed: string[]; awaiting?: string[] } };
      expect(res.status, "the door took the decision").toBe(200);
      expect(body.mailboxes?.awaiting, "it says the move waits on the claim").toEqual([w.sidecar.world.mailboxId]);
      expect(body.mailboxes?.filed).toEqual([]);
      const [rule] = await w.ruleFor();
      expect(rule?.destination, "the decision is a rule the moment it is made").toBe("INBOX");
      expect(rule?.retroRequestedAt, "and the rule owes its held mail").not.toBeNull();
      expect(await w.requests(), "nothing is asked of the install the claim displaces").toHaveLength(0);
      expect(await w.desired(), "a reader moves nothing before the claim").toEqual(["ohmail/Screener", "ohmail/Screener"]);
    }, 60_000);

  it("after the claim lands, the held mail moves on the first organizing drain, with no second press", async () => {
    const w = await boot(12 * DAY);
    await w.organize();
    expect((await w.decide()).status).toBe(200);

    await w.sidecar.syncUntilQuiet();

    expect((await w.row()).organizerRole, "the claim landed").toBe("organizer");
    expect(await w.ruleFor(), "the rule survives the claim").toHaveLength(1);
    expect(await w.desired(), "the held mail is filed by the rule").toEqual(["INBOX", "INBOX"]);
    expect(w.moves.filter((m) => m.from === "ohmail/Screener" && m.to === "INBOX"),
      "and it reached the mail server").toHaveLength(2);
  }, 60_000);

  it("CONTROL: the same decision from the Screener after the claim files at once", async () => {
    const w = await boot(12 * DAY);
    await w.organize();
    await w.sidecar.syncUntilQuiet();
    expect((await w.row()).organizerRole).toBe("organizer");

    const res = await w.decide();
    const body = (await res.json()) as { mailboxes?: { filed: string[]; awaiting?: string[] } };
    expect(res.status).toBe(200);
    expect(body.mailboxes?.filed).toEqual([w.sidecar.world.mailboxId]);
    expect(body.mailboxes?.awaiting).toBeUndefined();
    expect(await w.desired()).toEqual(["INBOX", "INBOX"]);
  }, 60_000);

  /* THE ACCOUNT DOORS TAKE THE SAME ROAD: a rule, an away reply and a screening choice made
     before the claim lands are written here, with nothing asked of the displaced holder. */
  it.each([["stopped", 12 * DAY], ["still renewing", 0]] as const)(
    "holder %s: a rule, an away reply and a screening choice before the claim lands are written here",
    async (_label, age) => {
      /* THE CLAIM HELD BACK BY ITS LEASE READ: Agree now wakes the gate at once (PERF-026), so the
         window this case presses in is held open here, as a first sync in flight holds it. */
      let release!: () => void;
      const w = await boot(age, new Promise<void>((r) => { release = r; }));
      cleanups.push(() => release());
      await w.organize();
      expect((await w.row()).organizerRole, "the claim has not landed yet").toBe("reader");
      const rule = await w.call("POST", "/rules", { kind: "sender", match: "new@b.test", destination: "INBOX" });
      const away = await w.call("PUT", "/away-responder", { enabled: true, body: "Away until Monday.", audience: "everyone" });
      const screening = await w.call("PATCH", "/account/screening", { ohboxPolicy: "people_only" });
      expect([rule.status, away.status, screening.status], "each door wrote here").toEqual([201, 200, 200]);
      expect((await w.sidecar.db.select().from(rules).where(eq(rules.match, "new@b.test"))).length).toBe(1);
      expect(await w.requests(), "nothing is asked of the install the claim displaces").toHaveLength(0);
    }, 60_000);

  it("CONTROL: a reader nobody asked to organize is refused or asks the holder, as before", async () => {
    const stopped = await boot(12 * DAY);
    const refused = await stopped.decide();
    expect(refused.status, "a stopped holder and no takeover asked for: nothing can take it").toBe(409);
    expect(await stopped.ruleFor()).toHaveLength(0);

    const live = await boot(0);
    const queued = await live.decide();
    expect(queued.status, "a live holder takes it as a request").toBe(202);
    expect(await live.ruleFor()).toHaveLength(0);
    expect(await live.requests()).toHaveLength(1);
  }, 60_000);

  it("CONTROL: a join press over a live holder is refused, so the decision goes to the holder", async () => {
    const w = await boot(0);
    expect((await w.join()).status).toBe(409);
    const res = await w.decide();
    expect(res.status).toBe(202);
    expect(await w.ruleFor()).toHaveLength(0);
    expect(await w.requests()).toHaveLength(1);
  }, 60_000);
});

/**
 * THE CLAIM OVER A LIVE HOLDER FOLLOWS ONLY "ORGANIZE HERE INSTEAD". Setup's
 * How-far-back step offered Agree for 11-26 s before the claim question landed, and an Agree in
 * that window took a live organizer's mailbox: the door read the missing verb as a takeover. The
 * door now reads it as a join and refuses one over a row showing a live holder. To watch it fail:
 * make the route's `intent` `"takeover"` whatever the body says.
 */
describe("the organize door takes a live holder's mailbox only by name", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  /** `ageMs` null: no claim at all. 0: a holder renewing now. */
  async function boot(ageMs: number | null, opts: { holdFirstLook?: boolean } = {}) {
    const meta = new MemoryMetaFolder();
    if (ageMs !== null) {
      const at = new Date(Date.now() - ageMs);
      await meta.appendClaim(formatClaim({
        installId: "local:w-live", kind: "local", displayName: "W-live",
        heartbeat: at, claimedAt: at, nonce: "live", authorizedAt: null, capabilities: ["requests"],
      }));
    }
    let release: () => void = () => {};
    const gate = opts.holdFirstLook ? new Promise<void>((r) => { release = r; }) : Promise.resolve();
    const dataDir = await freshDataDir("ohmail-organize-door-");
    const sidecar: Sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test", machineName: "the second computer",
      pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000,
      adapterFactory: mailbox(meta, [], gate), log: () => {},
    });
    cleanups.push(async () => { release(); await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    const started = sidecar.start();
    if (!opts.holdFirstLook) await started;
    const call = (method: string, path: string, body?: unknown) => sidecar.handle(new Request(`http://engine.invalid${path}`, {
      method, headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const organize = (body: Record<string, unknown>) =>
      call("POST", `/local/mailboxes/${sidecar.world.mailboxId}/organize`, { screening: { scope: "window" }, ...body });
    const row = async () => (await sidecar.db.select().from(mailboxes).where(eq(mailboxes.id, sidecar.world.mailboxId)))[0]!;
    const listed = async () => ((await (await call("GET", "/mailboxes")).json()) as { items: Array<Record<string, unknown>> })
      .items.find((m) => m.id === sidecar.world.mailboxId)!;
    const liveClaimStands = () => meta.claims.some((c) => c.raw.includes("local:w-live"));
    return { sidecar, organize, row, listed, liveClaimStands, release, started, meta };
  }

  it("a press without the takeover verb over a live holder is refused, the holder named, nothing written", async () => {
    const w = await boot(0);
    expect((await w.row()).organizerState, "the first look saw the live holder").toBe("held");
    const res = await w.organize({});
    expect(res.status, "the door took a live organizer's mailbox on an Agree").toBe(409);
    expect(((await res.json()) as { holder?: { name?: string } }).holder?.name).toBe("W-live");
    const after = await w.row();
    expect(after.organizeConsentedAt, "no consent written").toBeNull();
    expect(after.takeoverAuthorizedAt, "no takeover stamp written").toBeNull();
    await w.sidecar.syncUntilQuiet();
    expect((await w.row()).organizerRole).toBe("reader");
    expect(w.liveClaimStands()).toBe(true);
  }, 60_000);

  it("\"Organize here instead\" names the takeover, and it is admitted", async () => {
    const w = await boot(0);
    const res = await w.organize({ intent: "takeover" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome: string }).outcome).toBe("authorized");
    expect((await w.row()).takeoverIntent).toBe("takeover");
  }, 60_000);

  it("a press before the first look lands is a join, and the fence yields to the live holder", async () => {
    const w = await boot(0, { holdFirstLook: true });
    expect((await w.listed()).organizerChecked, "the list says the look has not answered").toBe(false);
    const res = await w.organize({});
    expect(res.status, "the row cannot say yet, so the press is admitted").toBe(200);
    expect((await w.row()).takeoverIntent, "but only as a join").toBe("join");
    w.release();
    await w.started;
    await w.sidecar.syncUntilQuiet();
    expect((await w.row()).organizerRole, "a join yields to a live claim").toBe("reader");
    expect(w.liveClaimStands(), "the live organizer keeps its mailbox").toBe(true);
    expect((await w.listed()).organizerChecked, "the look answered").toBe(true);
  }, 60_000);

  it.each([["no holder", null], ["a stopped holder", 12 * DAY]] as const)(
    "CONTROL: %s — Agree still claims", async (_label, age) => {
      const w = await boot(age);
      const res = await w.organize({});
      expect(res.status).toBe(200);
      expect(((await res.json()) as { outcome: string }).outcome).toBe("authorized");
      await w.sidecar.syncUntilQuiet();
      expect((await w.row()).organizerRole).toBe("organizer");
    }, 60_000);
});
