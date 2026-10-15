import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, LeasePeekIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { eq, isNull } from "drizzle-orm";
import { StaticKeyProvider } from "@trafficflow/core";
import { mailboxCredentials, mailboxes } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A DESKTOP THAT CANNOT READ ITS OWN STORED PASSWORD IS IN AN OUTAGE, AND SAYS SO
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A previously synced install relaunches under a key that does not open its sealed credential —
 * a replaced keystore entry, a dropped key version, a host that started without one. `start()`
 * returned before dialling, no detector fired, `outageSince` stayed null, and
 * `GET /local/mailboxes/connections` answered `reachable: true`: Settings said "Up to date" over
 * a mailbox that was not syncing. The failure-looks-like-healthy shape, from the one direction
 * nothing watched.
 *
 * The rig is the REAL pipeline and not a double of it: two launches of a real engine on one
 * on-disk store, the credential sealed by the first launch and read back by the second, the
 * verdict taken from the route the Settings pane polls. Only the IMAP socket is a double, and it
 * is the one thing this subject never reaches — a launch that cannot read its password does not
 * dial at all.
 *
 * ── MUTATION-WATCH (edit the source, watch, restore) ──────────────────────────────────────
 *
 *  · drop `noteCredentialUnreadable()` from `start()`'s non-ready arm → the outage case reddens
 *    with `reachable: true` and a null stamp, which is the defect.
 *  · leave `credentialBlocked` null in that call → the row reddens on the diagnosis, and the
 *    pane would say "Can't reach the mail server" about a server it never dialled.
 *  · make the second read unconditional rather than once → the confirmed case reddens.
 *
 * ── AND THE STATE BESIDE IT: NO STORED PASSWORD AT ALL ────────────────────────────────────
 *
 * The second `describe` is the same class reached from the other side — a mailbox that never had
 * a password on this install (sign out with two mailboxes, reconnect only the primary). Nothing
 * is stored, so there is nothing to be unreadable and nothing to retry, and `start()` returned in
 * silence: `reachable` is the negation of an observed death, a runtime that opened no socket has
 * not observed one, and the row read "Up to date". It is `needsCredential` — not an outage.
 *
 *  · drop `needsCredential = true` from `start()`'s no-password arm → the first case reddens on
 *    `reachable: true`, which is the defect.
 *  · drop `&& !needsCredential` from the connection getter → the same case reddens the same way.
 */

const HOUR = 60 * 60 * 1000;
const EMPTY_CURSOR = { folders: {} };
const ADDRESS = "owner@trafficflow.test";
const HOST = "imap.invalid";

/** A per-install key, as the shell's keystore hands it over. */
const kek = (fill: number): Buffer => Buffer.alloc(32, fill);

/** `ohmail/_meta`, in memory — empty, because nothing here reaches the lease. */
class MemoryMeta implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }
  uidValidity(): number | bigint | null { return 4_100; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(installId)).map((c) => ({ ...c }));
  }
}

/** Every dial this install made, the password it dialled with, and every command sent down a
    connection nobody had opened — the TypeError's shape on the real adapter. */
interface Dials { readonly passwords: string[]; unopened: number }

function adapterFactory(dials: Dials, meta: MemoryMeta) {
  return (cfg: ImapConfig): MailboxAdapter & { leaseIo(): LeaseIo; leasePeekIo(): LeasePeekIo } => {
    /**
     * A COMMAND ON A CONNECTION NOBODY OPENED FAILS, exactly as the real adapter's `assertUsable`
     * makes it fail — imapflow's `NoConnection`, which is what the NEXT command throws. A double
     * that served a drain over an unopened socket is the lenient one: the whole subject here is a
     * launch that never dialled, so a server-facing verb that answers anyway measures nothing.
     */
    let live = false;
    const assertLive = (): void => {
      if (live) return;
      dials.unopened += 1;
      const err = new Error("Connection not available") as Error & { code: string };
      err.code = "NoConnection";
      throw err;
    };
    return {
      leaseIo: () => ({
        ensureMetaFolder: async () => { assertLive(); await meta.ensureMetaFolder(); },
        listClaims: async () => { assertLive(); return meta.listClaims(); },
        appendClaim: async (raw: string) => { assertLive(); await meta.appendClaim(raw); },
        removeClaims: async (refs: readonly unknown[]) => { assertLive(); await meta.removeClaims(refs); },
        /* NOT behind `assertLive`, and that is the production shape: the generation is read off
           the client's selected mailbox, which a dead socket leaves UNKNOWN rather than throwing. */
        uidValidity: () => (live ? meta.uidValidity() : null),
        findOwnRecords: async (installId: string) => { assertLive(); return meta.findOwnRecords(installId); },
      }),
      leasePeekIo: () => ({ listClaims: async () => { assertLive(); return meta.listClaims(); } }),
      async connect(): Promise<void> {
        (dials.passwords as string[]).push((cfg.auth as { pass?: string }).pass ?? "");
        live = true;
      },
      async close(): Promise<void> { live = false; },
      async capabilities(): Promise<ImapCapabilities> {
        assertLive();
        return {
          move: true, uidplus: true, condstore: true, qresync: false,
          idle: true, specialUse: true, sentFolder: null,
        };
      },
      async ensureFolders(): Promise<void> { assertLive(); },
      async changesSince(): Promise<ChangeBatch> {
        assertLive();
        return { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: EMPTY_CURSOR };
      },
      async move(_l: NativeLocator, toFolder: string): Promise<NativeLocator> {
        assertLive();
        return { folder: toFolder, ref: "7:41" };
      },
      async setFlags(): Promise<void> { assertLive(); },
      async scanSentRecipients(): Promise<string[]> { assertLive(); return []; },
      async watch(): Promise<() => Promise<void>> { assertLive(); return async () => {}; },
      async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart in this rig"); },
      /* PRESENT BECAUSE THE REAL ADAPTER HAS IT, and refusing: nothing here sends, and a double
         missing a capability production always has is the lenient one wearing a defect's clothes. */
      async send(): Promise<SendResult> { throw new Error("no send in this rig"); },
    };
  };
}

describe("a stored credential this launch cannot read", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  interface Booted {
    s: Sidecar;
    dials: Dials;
    /** This mailbox's `ohmail/_meta`, so the claim the heal wrote can be read back. */
    meta: MemoryMeta;
    events: Array<{ event: string; detail: Record<string, unknown> }>;
  }

  /**
   * One launch on `dataDir`. `pass` omitted is the steady state after a first run: the shell
   * carries no password and the sealed row is the only one there is.
   */
  async function launch(
    dataDir: string, keks: Record<number, Buffer>, pass?: string, host: string = HOST,
    pollIntervalMs: number = 60 * HOUR, heartbeatTimeoutMs?: number, clock?: () => Date,
  ): Promise<Booted> {
    const dials: Dials = { passwords: [], unopened: 0 };
    const meta = new MemoryMeta();
    const events: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const s = await createSidecar({
      dataDir,
      imap: {
        host, port: 993, secure: true,
        auth: { user: ADDRESS, ...(pass === undefined ? {} : { pass }) },
      },
      address: ADDRESS,
      machineName: "the machine that was relaunched",
      // Long enough that no timer fires on its own: every pass is one a case asked for — except
      // the ONE case whose subject is what the poll does on its own while the mailbox is blocked.
      pollIntervalMs,
      leaseStaleAfterMs: 60_000,
      keks,
      adapterFactory: adapterFactory(dials, meta),
      ...(heartbeatTimeoutMs === undefined ? {} : { heartbeatTimeoutMs }),
      ...(clock === undefined ? {} : { now: clock }),
      log: (event, detail) => { events.push({ event, detail: (detail ?? {}) as Record<string, unknown> }); },
    });
    cleanups.push(async () => { await s.stop().catch(() => undefined); });
    /* SOMEBODY AGREED TO LET THIS MACHINE ORGANIZE. A fresh mailbox is a consent-less reader, and
       a reader may not press "Sync now" (the route answers 409) — which is the door two cases
       below ask for the next read through. Both columns, because they are two different readers:
       the gate reads the consent, every service write door reads the role. */
    await s.db.update(mailboxes)
      .set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
      .where(isNull(mailboxes.organizeConsentedAt));
    return { s, dials, meta, events };
  }

  /** What the Settings pane polls, through the route it polls. */
  async function connections(b: Booted): Promise<Record<string, unknown>> {
    const res = await b.s.handle(new Request("http://local/local/mailboxes/connections", {
      method: "GET",
      headers: { authorization: `Bearer ${b.s.sessionToken}` },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<Record<string, unknown>> };
    const row = body.items.find((i) => i.mailboxId === b.s.world.mailboxId);
    expect(row, "the engine reported no row for its own seed mailbox").toBeDefined();
    return row!;
  }

  /** A first launch that seals the password, then goes away — the install that used to work. */
  async function sealed(dataDir: string, keks: Record<number, Buffer>): Promise<void> {
    const first = await launch(dataDir, keks, "the-one-the-user-typed");
    const rows = await first.s.db.select().from(mailboxCredentials);
    expect(rows.length, "the first launch did not seal a password, so nothing is under test")
      .toBe(1);
    await first.s.stop();
  }

  it("reports an outage rather than a mailbox that is up to date", async () => {
    const dataDir = await freshDataDir("ohmail-unreadable-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    await sealed(dataDir, { 1: kek(7) });

    // The keystore entry was replaced. The row is intact and this key does not open it.
    const b = await launch(dataDir, { 1: kek(9) });
    await b.s.start();

    expect(await b.s.credentialState(), "the rig did not produce an unreadable credential")
      .toBe("unreadable");
    expect(b.dials.passwords, "a launch with no usable password dialled the mail server anyway")
      .toEqual([]);

    const row = await connections(b);
    expect(row.reachable, "a mailbox that is not syncing reported itself reachable")
      .toBe(false);
    expect(row.unreachableSince, "the outage has no clock, so Settings can say nothing about it")
      .toEqual(expect.any(String));
    expect(row.signInRefused, "no server answered this launch, so none refused it")
      .toBe(false);
    /* AND IT IS NOT THE STATE BESIDE IT. A row IS stored here and it is this key that cannot open
       it; collapsing the two would tell somebody to enter a password the install already has. */
    expect(row.needsCredential, "an unreadable stored password was reported as no password")
      .toBe(false);
  });

  it("keeps the sealed row — an unreadable credential is not discarded", async () => {
    const dataDir = await freshDataDir("ohmail-unreadable-keep-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    await sealed(dataDir, { 1: kek(7) });

    const b = await launch(dataDir, { 1: kek(9) });
    await b.s.start();

    const rows = await b.s.db.select().from(mailboxCredentials);
    expect(rows.length, "the launch threw the password away, so the right key can never open it")
      .toBe(1);
  });

  /**
   * "Sync now", through the route the pane presses. It skips the backoff WAIT and nothing else,
   * so it is how a case asks for the next read without waiting out the ladder — the same thing
   * the poll does on its own cadence, at a moment the test chooses.
   */
  const press = async (b: Booted): Promise<Response> => b.s.handle(new Request(
    `http://local/mailboxes/${encodeURIComponent(b.s.world.mailboxId)}/resync`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${b.s.sessionToken}`, "content-type": "application/json" },
      body: "{}",
    },
  ));

  it("says WHY, and waits for a second read before telling anybody to sign in again", async () => {
    const dataDir = await freshDataDir("ohmail-unreadable-twice-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    await sealed(dataDir, { 1: kek(7) });

    const b = await launch(dataDir, { 1: kek(9) });
    await b.s.start();

    const first = await connections(b);
    expect(first.credentialBlocked, "the row said an outage and never said what stopped it")
      .toEqual({ state: "unreadable", confirmed: false });

    // A SECOND, FRESH READ of the same row. Only now is the failure deterministic, and only now
    // may a person be told to do something about it.
    expect((await press(b)).status).toBe(202);
    await vi.waitFor(async () => {
      expect((await connections(b)).credentialBlocked)
        .toEqual({ state: "unreadable", confirmed: true });
    }, { timeout: 5_000, interval: 25 });

    expect(b.dials.passwords, "a mailbox with no usable password was dialled anyway")
      .toEqual([]);
  });

  it("the poll retries the READ and drains nothing over a connection nobody opened", async () => {
    const dataDir = await freshDataDir("ohmail-unreadable-poll-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    await sealed(dataDir, { 1: kek(7) });

    const b = await launch(dataDir, { 1: kek(9) }, undefined, HOST, 40);
    await b.s.start();

    /* THE POLL IS ARMED — without it nothing re-reads the row and the mailbox stays dark until
       the app is quit. `mailbox_login_unavailable` is written once at the launch and again by the
       read that confirms it; the ladder is what keeps the third from arriving straight away. */
    await vi.waitFor(() => {
      expect(b.events.filter((e) => e.event === "mailbox_login_unavailable").length)
        .toBeGreaterThanOrEqual(2);
    }, { timeout: 5_000, interval: 20 });

    /* …AND NOTHING IS DRAINED OVER A CONNECTION THAT WAS NEVER OPENED. A drain on top of the
       read would fail on every tick — `sync_cycle_failed` for ever, and the failing-cycle bound
       advanced by a mailbox that has no socket — for a state the connection record already
       states in full. */
    await new Promise((r) => { setTimeout(r, 300); });
    expect(b.events.filter((e) => e.event === "sync_cycle_failed").length, "the poll drained a "
      + "mailbox with no connection, once per tick, for a fact already on the row")
      .toBe(0);
    expect(b.dials.passwords, "the ladder was skipped and the server dialled anyway").toEqual([]);
  });

  it("a password that opens on a later read heals the mailbox without a relaunch", async () => {
    const dataDir = await freshDataDir("ohmail-unreadable-heal-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    await sealed(dataDir, { 1: kek(7) });

    const b = await launch(dataDir, { 1: kek(9) }, undefined, HOST, 60 * HOUR, 40);
    await b.s.start();
    expect((await connections(b)).reachable).toBe(false);

    // The password is re-sealed under the key this launch HAS — what re-entering it produces.
    const sealedAgain = await new StaticKeyProvider({ 1: kek(9) }).encrypt("the-second-password");
    await b.s.db.update(mailboxCredentials)
      .set({ secretEnc: sealedAgain.ciphertext, keyVersion: sealedAgain.keyVersion })
      .where(eq(mailboxCredentials.mailboxId, b.s.world.mailboxId));

    expect((await press(b)).status).toBe(202);
    await vi.waitFor(async () => {
      const row = await connections(b);
      expect(row.credentialBlocked, "the block outlived the password that cleared it").toBeNull();
      expect(row.reachable, "the mailbox healed and the row still reported an outage").toBe(true);
    }, { timeout: 5_000, interval: 25 });

    expect(b.dials.passwords, "the mailbox dialled with something other than the re-sealed password")
      .toEqual(["the-second-password"]);
    /* AND THE DERIVED KEY MOVED WITH IT. The request-channel signing key is HKDF over the
       password this mailbox dials with, and the gate writes whether it HAS one into the claim's
       capabilities. Left behind, it would be `null` — every request record from a reader would
       refuse as a forgery, with the log naming an attack. */
    const claims = await b.meta.listClaims();
    expect(claims.length, "the healed launch never reached the lease gate").toBe(1);
    expect(String(claims[0]!.raw), "the claim says this install cannot take requests, so the "
      + "signing key was derived from the password the launch could NOT read")
      .toMatch(/X-Ohmail-Capabilities:.*requests/);
    /* AND THE THIRD DEATH DETECTOR IS ARMED. `start()` returned before `armHeartbeat()` when the
       password could not be used, so a mailbox healed on a later read would run without the NOOP
       probe — the one detector a half-open link produces no other evidence for. This rig's adapter
       implements no `noop`, so the probe reports itself unaskable: that line is the heartbeat
       having RUN, which is the fact under test. */
    await vi.waitFor(() => {
      expect(b.events.filter((e) => e.event === "mailbox_heartbeat_unavailable").length)
        .toBeGreaterThanOrEqual(1);
    }, { timeout: 5_000, interval: 20 });
  });

  it("THE PATH BESIDE IT — a credential proved against another server is the same outage", async () => {
    const dataDir = await freshDataDir("ohmail-foreign-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    await sealed(dataDir, { 1: kek(7) });

    // The same key: the row opens. It was proved against a server this launch is no longer
    // configured for, so the password is withheld and nothing is dialled — and that, too, used
    // to read as a mailbox that was up to date.
    const b = await launch(dataDir, { 1: kek(7) }, undefined, "imap-elsewhere.invalid");
    await b.s.start();

    expect(await b.s.credentialState()).toBe("foreign-host");
    const row = await connections(b);
    expect(row.reachable).toBe(false);
    expect(row.credentialBlocked).toEqual({ state: "foreign-host", confirmed: false });
    expect(b.dials.passwords, "one server's password was offered to another")
      .toEqual([]);
  });

  /* ── AND THE MAILBOX ROW THE WEB SHELL'S STRIP READS SAYS IT (LOCAL-DOOR-CREDENTIAL-BLOCK) ──
     `GET /mailboxes` used to carry the outage clock from the first read, so the strip said
     "unreachable since" at once and `err_connect` ("not available") from 120 s — about a server
     nothing dialled. The overlay's arm order puts the block above the outage: confirmed, a closed
     detail; unconfirmed, nothing, and never a clock. Mutations watched red: the credential arm
     moved below the outage arm; the clock left on an unconfirmed block. */
  const mailboxRow = async (b: Booted): Promise<Record<string, unknown>> => {
    const res = await b.s.handle(new Request("http://local/mailboxes", {
      method: "GET", headers: { authorization: `Bearer ${b.s.sessionToken}` },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<Record<string, unknown>> };
    return body.items.find((i) => i.id === b.s.world.mailboxId)!;
  };

  it("the mailbox row names a confirmed block, never carries an outage clock, and still does at 130 s", async () => {
    const dataDir = await freshDataDir("ohmail-unreadable-row-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    await sealed(dataDir, { 1: kek(7) });
    let at = Date.parse("2026-09-29T02:00:00.000Z");
    const b = await launch(dataDir, { 1: kek(9) }, undefined, HOST, 60 * HOUR, undefined, () => new Date(at));
    await b.s.start();

    const first = await mailboxRow(b);
    expect(first.status, "a block one read old was already told as a failure").toBe("connected");
    expect(first.unreachableSince ?? null, "the strip was handed an outage clock by the first read").toBeNull();

    expect((await press(b)).status).toBe(202);
    await vi.waitFor(async () => {
      expect((await connections(b)).credentialBlocked).toEqual({ state: "unreadable", confirmed: true });
    }, { timeout: 5_000, interval: 25 });
    at += 130_000;
    const row = await mailboxRow(b);
    expect([row.status, row.errorCode, row.errorDetail], "the confirmed block is not on the row")
      .toEqual(["error", "connect", "MAILBOX_CREDENTIAL_UNREADABLE"]);
    expect(row.unreachableSince ?? null, "an outage clock rode beside the block").toBeNull();
  });

  it("a credential proved against another server is named as that, once confirmed", async () => {
    const dataDir = await freshDataDir("ohmail-foreign-row-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    await sealed(dataDir, { 1: kek(7) });
    const b = await launch(dataDir, { 1: kek(7) }, undefined, "imap-elsewhere.invalid");
    await b.s.start();
    expect((await press(b)).status).toBe(202);
    await vi.waitFor(async () => {
      expect((await connections(b)).credentialBlocked).toEqual({ state: "foreign-host", confirmed: true });
    }, { timeout: 5_000, interval: 25 });
    const row = await mailboxRow(b);
    expect([row.status, row.errorCode, row.errorDetail]).toEqual(["error", "connect", "MAILBOX_CREDENTIAL_FOREIGN_HOST"]);
  });

  it("POSITIVE CONTROL — a launch that CAN read its password is untouched", async () => {
    const dataDir = await freshDataDir("ohmail-readable-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    await sealed(dataDir, { 1: kek(7) });

    const b = await launch(dataDir, { 1: kek(7) });
    await b.s.start();

    expect(await b.s.credentialState()).toBe("ready");
    expect(b.dials.passwords, "the sealed password is what a relaunch dials with")
      .toEqual(["the-one-the-user-typed"]);

    const row = await connections(b);
    expect(row.reachable, "a healthy launch was reported as an outage").toBe(true);
    expect(row.unreachableSince).toBeNull();
  });

  /**
   * NO STORED PASSWORD AT ALL — the state, and it is neither reachable nor an outage.
   *
   * Nested so the rig above is the rig here: one `launch`, one `connections`, one adapter that
   * refuses every command on a socket nobody opened. See this file's header for the mutations.
   */
  describe("a mailbox this install has no password for", () => {
    it("names the state rather than reporting a mailbox that is up to date", async () => {
      const dataDir = await freshDataDir("ohmail-nocred-");
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

      // Nothing was ever sealed here and the shell carries no password: the secondary of a
      // two-mailbox install where only the primary was reconnected.
      const b = await launch(dataDir, { 1: kek(7) });
      await b.s.start();

      expect(await b.s.credentialState(), "the rig produced a password after all").toBe("absent");
      expect(b.dials.passwords, "a launch with no password dialled the mail server").toEqual([]);

      const row = await connections(b);
      expect(row.needsCredential, "the state has no name, so no surface can say it").toBe(true);
      expect(row.reachable, "a mailbox nothing had ever read reported itself reachable")
        .toBe(false);
      /* NOT AN OUTAGE: there is no first observation of death to name, nothing is being
         re-dialled, and "unreachable since" would be a duration with no start. */
      expect(row.unreachableSince, "a mailbox that was never dialled was given an outage clock")
        .toBeNull();
      /* NOT THE STORED-ROW BLOCK EITHER: no row exists, so there is nothing that will not open. */
      expect(row.credentialBlocked, "no password was stored and one was reported unreadable")
        .toBeNull();
      expect(row.signInRefused, "no server answered this launch, so none refused it").toBe(false);
    });

    /* AND THE MAILBOX ROW THE STRIP READS SAYS IT: the rail read "Connected. The first sync has
       not finished yet." over this state (the first-run door that entered over a refused seal).
       Now the row carries the block the hosted organizer writes for the same fact, with the
       runtime's clock; `local-overlay-arm-order.test.ts` drives its place among the arms. */
    it("the mailbox row carries the no-password block, never an error or an outage clock", async () => {
      const dataDir = await freshDataDir("ohmail-nocred-row-");
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
      const b = await launch(dataDir, { 1: kek(7) });
      await b.s.start();
      const row = await mailboxRow(b);
      expect([row.status, row.errorCode ?? null, row.unreachableSince ?? null]).toEqual(["connected", null, null]);
      expect(row.syncBlockedReason, "the strip reads this row as a mailbox that is connected").toBe("awaiting_credentials");
      expect(typeof row.syncBlockedSince).toBe("string");
    });

    it("says it once and dials nothing — with no password there is nothing to retry", async () => {
      const dataDir = await freshDataDir("ohmail-nocred-quiet-");
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

      const b = await launch(dataDir, { 1: kek(7) }, undefined, HOST, 40);
      await b.s.start();
      await new Promise((r) => { setTimeout(r, 300); });

      expect(b.dials.passwords, "an empty password was offered to the mail server, which is how "
        + "a provider locks an account").toEqual([]);
      expect(b.events.filter((e) => e.event === "stored_login_absent").length,
        "the state was announced on a cadence rather than stated once").toBe(1);
      expect(b.events.filter((e) => e.event === "sync_cycle_failed").length,
        "a mailbox with no connection was drained once per tick").toBe(0);
    });

    it("POSITIVE CONTROL — a launch WITH a password is reachable and needs nothing", async () => {
      const dataDir = await freshDataDir("ohmail-nocred-positive-");
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

      const b = await launch(dataDir, { 1: kek(7) }, "the-one-the-user-typed");
      await b.s.start();

      expect(b.dials.passwords, "the password this launch holds is what it dialled with")
        .toEqual(["the-one-the-user-typed"]);
      const row = await connections(b);
      expect(row.needsCredential, "a mailbox with a password was told to ask for one").toBe(false);
      expect(row.reachable, "a mailbox that dialled and drained was reported unreachable")
        .toBe(true);
    });
  });

  /**
   * THE FIRST CONNECT: a launch with no password, then the door's seal, then the engine the door
   * starts next. The seal is the first write on a runtime that never dialled, so it re-dials
   * nothing and no forced cycle drains over the adapter nobody opened (the TypeError every set-up
   * logged); the relaunch's own launch is the cycle, and it drains to quiet. Mutation: delete the
   * `launchSkipped` arm in `credentialReplaced`, or the guard in `syncUntilQuiet` or `detach`.
   */
  describe("a mailbox whose launch was skipped for want of a password", () => {
    /** The door's seal as the first connect sends it: the whole transport and the password. */
    const seal = async (b: Booted, pass: string): Promise<Response> => b.s.handle(new Request(
      `http://local/local/mailboxes/${encodeURIComponent(b.s.world.mailboxId)}`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${b.s.sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          imap: { host: HOST, port: 993, secure: true, user: ADDRESS, pass, smtpHost: "" },
        }),
      },
    ));
    const count = (b: Booted, event: string): number =>
      b.events.filter((e) => e.event === event).length;
    /** The first-sync answer the connection record carries — what the phone's row renders. */
    const firstSyncOf = (b: Booted): unknown =>
      b.s.connectionStates()[b.s.world.mailboxId]?.firstSync;

    it("the seal re-dials nothing, and the relaunch after it drains to quiet", async () => {
      const dataDir = await freshDataDir("ohmail-skipped-seal-");
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
      const first = await launch(dataDir, { 1: kek(7) });
      await first.s.start();
      expect((await seal(first, "the-one-the-user-typed")).status).toBe(200);
      await new Promise((r) => { setTimeout(r, 300); });

      expect(count(first, "mailbox_relogin_cycle_failed"), "the seal drained a mailbox that "
        + "had never dialled").toBe(0);
      expect(count(first, "mailbox_relogin_skipped"), "the skipped cycle was not named").toBe(1);
      expect(first.dials.unopened, "a command went down a connection nobody opened").toBe(0);
      expect(firstSyncOf(first), "a drain over nothing reported a first sync that produced "
        + "nothing readable").toBe("pending");
      await first.s.stop();

      // The door's next step: the engine is replaced, and its launch dials the sealed password.
      const next = await launch(dataDir, { 1: kek(7) });
      await next.s.start();
      expect(next.dials.passwords, "the relaunch did not dial the sealed password")
        .toEqual(["the-one-the-user-typed"]);
      expect(next.events.some((e) => e.event === "sync_drain" && e.detail.drained === true),
        "the relaunch's first drain did not run to quiet").toBe(true);
      expect(count(next, "mailbox_relogin_cycle_failed")).toBe(0);
      expect(next.dials.unopened).toBe(0);
    });

    /**
     * AND NOTHING READS REACHABLE THAT NO DIAL HAS REACHED (FIX-026 row 96). The seal re-reads the
     * row and clears `needsCredential`, the launch stays skipped, and `reachable` used to follow
     * the first flag alone: "Up to date" over a runtime nothing had dialled. Mutation: drop
     * `&& !launchSkipped` from the getter, or answer `dialled: true`.
     */
    it("a seal on a skipped launch leaves it undialled and unreachable, never an outage", async () => {
      const dataDir = await freshDataDir("ohmail-skipped-dialled-");
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
      const first = await launch(dataDir, { 1: kek(7) });
      await first.s.start();
      const before = await connections(first);
      expect(before.needsCredential, "control: the skipped launch names its state").toBe(true);
      expect(before.dialled, "the route did not say the runtime is undialled").toBe(false);
      expect((await seal(first, "the-one-the-user-typed")).status).toBe(200);
      await new Promise((r) => { setTimeout(r, 300); });
      expect(count(first, "mailbox_relogin_skipped"), "control: the launch stayed skipped").toBe(1);
      const after = await connections(first);
      expect(after.needsCredential, "control: a stored password is not asked for again").toBe(false);
      expect(after.reachable, "a runtime nothing has dialled reads reachable after the seal").toBe(false);
      expect(after.dialled).toBe(false);
      expect(after.unreachableSince, "a runtime nobody dialled was given an outage clock").toBeNull();
      await first.s.stop();
      // The door's next launch dials it, and the record says so.
      const next = await launch(dataDir, { 1: kek(7) });
      await next.s.start();
      const dialledNow = await connections(next);
      expect(dialledNow.dialled).toBe(true);
      expect(dialledNow.reachable, "POSITIVE CONTROL: a launch that dialled is reachable").toBe(true);
    });

    it("a press drains nothing over the connection nobody opened", async () => {
      const dataDir = await freshDataDir("ohmail-skipped-press-");
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
      const b = await launch(dataDir, { 1: kek(7) });
      await b.s.start();
      expect((await press(b)).status).toBe(202);
      await new Promise((r) => { setTimeout(r, 300); });

      expect(b.dials.unopened, "the press drained over an adapter nothing had connected").toBe(0);
      expect(firstSyncOf(b)).toBe("pending");
      expect(b.dials.passwords, "a press with no password dialled the server").toEqual([]);
    });

    it("a stop gives back no claim through the connection nobody opened", async () => {
      const dataDir = await freshDataDir("ohmail-skipped-stop-");
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
      const b = await launch(dataDir, { 1: kek(7) });
      await b.s.start();
      await b.s.stop();

      expect(b.dials.unopened, "the stop released a claim over an unopened connection").toBe(0);
      expect(count(b, "organizer_claim_release_failed")).toBe(0);
    });

    it("POSITIVE CONTROL — a seal on a mailbox that DID dial still re-dials and cycles", async () => {
      const dataDir = await freshDataDir("ohmail-skipped-positive-");
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
      const b = await launch(dataDir, { 1: kek(7) }, "the-one-the-user-typed");
      await b.s.start();
      expect((await seal(b, "the-one-the-user-typed")).status).toBe(200);
      await new Promise((r) => { setTimeout(r, 300); });

      expect(count(b, "mailbox_relogin_skipped"), "a mailbox that dialled was told it had "
        + "nothing to re-open").toBe(0);
      expect(count(b, "mailbox_relogin_cycle_failed")).toBe(0);
      expect(b.dials.unopened).toBe(0);
    });
  });
});
