import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSidecar, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ═══ REMOVING THE SEED MUST NOT HAND ITS SERVER TO THE MAILBOX THAT SURVIVES ═══════════════
 *
 * `attachLocal(row, isSeed)` gates four things and each is a fact about the CONFIGURATION: the
 * dial (`config.imap`), the environment password, and the process's submission server. It used to
 * be asked as `row.id === world.mailboxId`, and `world.mailboxId` answers a different question —
 * `identity.ts` says so in as many words: when the seed address has no row THE OLDEST LIVE ONE
 * STANDS IN, so the shell's single-mailbox surfaces keep answering for a working install.
 *
 * So: add a second mailbox, remove the seed, relaunch. `world.mailboxId` became the survivor,
 * `isSeed` came back true for it, and it was handed the REMOVED mailbox's host and user.
 * `credentialIsForeign(row.meta, mbImap.host)` then compared the survivor's own credential against
 * a server it had never been proved against, answered `foreign-host`, and withheld the password —
 * a mailbox that had been organizing seconds earlier came back dialling nothing, and the window
 * has no gesture that repairs it (the local door form reconfigures the whole install).
 *
 * ── HOW IT WAS FOUND, AND WHY THE WALK MISSED IT ────────────────────────────────────────────
 *
 * A review found it by reading. The driven walk over the real sidecar and the built window bundle
 * had this exact sequence as one of its nine steps and reported it GREEN — because the fixture
 * gave both mailboxes ONE hostname and differed them by username, and `credentialIsForeign`
 * compares HOSTS. With one host the comparison could not fail. Green against the wrong dataset.
 * The fixture gives each mailbox its own server now, and it reproduces `foreign-host` before this
 * fix and `ready` after it.
 *
 * THE TWO MAILBOXES HERE ARE ON DIFFERENT SERVERS FOR THAT REASON. A case that shared a host
 * would pass against the defect.
 */

const A = { user: "seed@a.test", host: "imap-a.test" };
/**
 * THE SAME ADDRESS ON A CORRECTED SERVER — what re-adding a removed mailbox usually is.
 *
 * Not named `A_MOVED`: the prose gate reads that shape as an internal identifier, and it is right to —
 * a two-character name beside `A` says nothing about what makes this fixture different, which is
 * the HOST.
 */
const A_MOVED = { user: "seed@a.test", host: "imap-corrected.test" };
const B = { user: "second@b.test", host: "imap-b.test" };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/**
 * One adapter per mailbox, keyed on the identity the runtime was BUILT for.
 *
 * It REFUSES an unknown pair rather than serving a default, which is the assertion the whole file
 * rests on: a runtime handed the process configuration instead of its own credential dials a
 * `(host, user)` no mailbox in this test owns, and that has to be an error rather than a silently
 * working double.
 */
function dispatcher() {
  const dialled: Array<{ host: string; user: string }> = [];
  const factory = (cfg: { host?: string; auth?: { user?: string; pass?: string } }): unknown => {
    const host = (cfg.host ?? "").trim().toLowerCase();
    const user = (cfg.auth?.user ?? "").trim().toLowerCase();
    dialled.push({ host, user });
    const known = [A, A_MOVED, B].some((w) => w.host === host && w.user === user);
    if (!known) {
      throw new Error(
        `this engine dialled ${JSON.stringify(`${user}@${host}`)}, which is no mailbox in this `
        + "test — a mailbox must dial from its own credential, never from the process configuration",
      );
    }
    const claims: Array<{ ref: number; raw: string }> = [];
    let uid = 1;
    return {
      leaseIo: () => ({
        async ensureMetaFolder(): Promise<void> {},
        async listClaims() { return claims.map((c) => ({ ...c })); },
        async appendClaim(raw: string): Promise<void> { claims.push({ ref: uid++, raw }); },
        async removeClaims(refs: readonly unknown[]): Promise<void> {
          const gone = new Set(refs);
          for (let i = claims.length - 1; i >= 0; i--) {
            if (gone.has(claims[i]!.ref)) claims.splice(i, 1);
          }
        },
        /** The uid generation, because `makeLeaseIo` always names one — see `lease-io-doubles.test.ts`. */
        uidValidity: () => 4_100,
      }),
      leasePeekIo: () => ({ async listClaims() { return claims.map((c) => ({ ...c })); } }),
      async connect(): Promise<void> {},
      async close(): Promise<void> {},
      async capabilities() {
        return { move: true, uidplus: true, condstore: true, qresync: false,
          idle: true, specialUse: true, sentFolder: null };
      },
      async ensureFolders(): Promise<void> {},
      async changesSince() {
        return { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
      },
      async move() { return { folder: "INBOX", ref: "1:1" }; },
      async setFlags(): Promise<void> {},
      async scanSentRecipients(): Promise<string[]> { return []; },
      async watch(): Promise<() => Promise<void>> { return async () => {}; },
    };
  };
  return { factory, dialled };
}

async function boot(dataDir: string, factory: (c: never) => unknown): Promise<Sidecar> {
  const s = await createSidecar({
    dataDir,
    imap: {
      host: A.host, port: 993, secure: true,
      auth: { user: A.user, pass: "the-seed-password" },
    },
    address: A.user,
    machineName: "this machine",
    // Long enough that no timer fires on its own — every pass is one a case asked for.
    pollIntervalMs: 60 * 60 * 1000,
    leaseStaleAfterMs: 60_000,
    keks: { 1: Buffer.alloc(32, 7) },
    adapterFactory: factory,
    log: () => {},
  } as never);
  cleanups.push(async () => { await s.stop().catch(() => undefined); });
  await s.start();
  return s;
}

const auth = (s: Sidecar): HeadersInit => ({
  authorization: `Bearer ${s.sessionToken}`,
  "content-type": "application/json",
});

describe("re-adding the address the settings file still names", () => {
  it("dials the credential the create just proved, not the stale configuration", async () => {
    /* ── THE CASE `identity.ts` DOCUMENTS AS EXPECTED, AND IT WAS BROKEN FOR ONE ROUND ────────
     *
     * Remove the seed while another mailbox remains — no sign-out, so `config.json` goes on naming
     * it — then add that address again from Settings. The same-login refusal cannot see it: that
     * scan is over rows with `status <> 'disabled'` and the old seed is a TOMBSTONE, which is why
     * `identity.ts`'s case 5 calls this an expected path rather than a collision.
     *
     * The add route attached the new runtime with `isSeedRow(dto.address)`, which answered TRUE
     * for exactly this row — so it dialled `config.imap`, the settings file the removal never
     * rewrote, instead of the credential the create had just proven. `credentialIsForeign` then
     * compared the freshly proven host against the stale one and withheld the password: a mailbox
     * that had just passed a live probe came up dialling nothing, at that launch and every one
     * after it.
     *
     * The route sites pass `false` outright now. MUTATION: `isSeedRow(dto.address)` at
     * `POST /local/mailboxes`'s attach, and this reds.
     *
     * THE RE-ADD USES A DIFFERENT HOST FOR THE SAME ADDRESS, which is the point — a person
     * re-adding a mailbox is very often correcting the server, and it is the only way to tell a
     * credential dial from a configuration dial apart. */
    const dataDir = await freshDataDir("ohmail-seed-readd-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

    const first = dispatcher();
    let s = await boot(dataDir, first.factory as (c: never) => unknown);

    // A second mailbox, so removing the seed does not empty the install.
    const addB = await s.handle(new Request("http://local/local/mailboxes", {
      method: "POST",
      headers: auth(s),
      body: JSON.stringify({
        provider: "imap",
        address: B.user,
        imap: { host: B.host, port: 993, secure: true, user: B.user, pass: "the-second-password" },
      }),
    }));
    expect(addB.status).toBe(201);

    const seedId = s.world.mailboxId;
    const gone = await s.handle(new Request(`http://local/local/mailboxes/${seedId}`, {
      method: "DELETE", headers: auth(s),
    }));
    expect(gone.status).toBeLessThan(300);

    /* AND NOW THE SAME ADDRESS COMES BACK, on a corrected server. `config.imap` still says
       `A.host`; the credential this create proves says `A_MOVED.host`.

       THE MARK IS TAKEN FIRST. Launch one legitimately dialled `seed@example.test` — that WAS the
       seed — so a filter over the whole record would find the stale host and fail against the
       fixed code. Only the dials this create causes are the ones under test. */
    const before = first.dialled.length;
    const readd = await s.handle(new Request("http://local/local/mailboxes", {
      method: "POST",
      headers: auth(s),
      body: JSON.stringify({
        provider: "imap",
        address: A.user,
        imap: { host: A_MOVED.host, port: 993, secure: true, user: A.user, pass: "the-corrected-password" },
      }),
    }));
    expect(readd.status, await readd.clone().text()).toBe(201);

    /* THE DIAL THE ATTACH BUILT. `A_MOVED.host` is what the create proved; `A.host` is what the stale
       settings file says, and a dial naming it here is the defect. */
    const forReadd = first.dialled.slice(before).filter((d) => d.user === A.user);
    expect(forReadd, "the re-add built no adapter at all").not.toEqual([]);
    expect(forReadd.some((d) => d.host === A_MOVED.host),
      "the re-added mailbox was not dialled on the server its credential names").toBe(true);
    expect(forReadd.some((d) => d.host === A.host),
      "the re-added mailbox was dialled on the STALE configured server").toBe(false);
  });
});

describe("a relaunch after the seed was removed", () => {
  it("hands the SURVIVING mailbox its own server, not the removed one's", async () => {
    const dataDir = await freshDataDir("ohmail-seed-removed-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));

    /* ── LAUNCH ONE: the seed, plus a mailbox added through the door the pane presses ───────── */
    const first = dispatcher();
    let s = await boot(dataDir, first.factory as (c: never) => unknown);

    const added = await s.handle(new Request("http://local/local/mailboxes", {
      method: "POST",
      headers: auth(s),
      body: JSON.stringify({
        provider: "imap",
        address: B.user,
        imap: { host: B.host, port: 993, secure: true, user: B.user, pass: "the-second-password" },
      }),
    }));
    expect(added.status, await added.clone().text()).toBe(201);
    const bId = ((await added.json()) as { id: string }).id;

    /* AND THE SEED GOES. `DELETE /local/mailboxes/:id` — the route the pane's Remove calls. */
    const seedId = s.world.mailboxId;
    expect(seedId).not.toBe(bId);
    const removed = await s.handle(new Request(`http://local/local/mailboxes/${seedId}`, {
      method: "DELETE", headers: auth(s),
    }));
    expect(removed.status).toBeLessThan(300);
    await s.stop();

    /* ── LAUNCH TWO: the SAME data directory and the SAME settings, which still name the seed ──
     *
     * That is the whole situation. Nothing rewrites the shell's settings file on a removal, so
     * `config.address` and `config.imap` go on describing a mailbox this install no longer has —
     * and the surviving row must be dialled from its own credential regardless. */
    const second = dispatcher();
    s = await boot(dataDir, second.factory as (c: never) => unknown);

    /* THE DIAL. Every `(host, user)` this launch built an adapter for must be a real pair; the
       dispatcher throws otherwise, and a throw inside the attach would have surfaced as a boot
       failure rather than as this assertion — so both are checked. */
    expect(second.dialled, "the relaunch built no adapter at all").not.toEqual([]);
    for (const d of second.dialled) {
      expect([A, B].some((w) => w.host === d.host && w.user === d.user),
        `the relaunch dialled ${d.user}@${d.host}, which is neither mailbox`).toBe(true);
    }
    /* AND NEVER THE REMOVED MAILBOX'S SERVER WITH THE SURVIVOR'S ROW BEHIND IT. The pair is what
       identifies a mailbox, so the survivor's dial must carry B's host — a dial naming A's host on
       this launch is the defect, whatever the username beside it. */
    expect(second.dialled.some((d) => d.host === B.host && d.user === B.user),
      "the surviving mailbox was not dialled on its own server").toBe(true);
    expect(second.dialled.some((d) => d.host === A.host),
      "the relaunch dialled the REMOVED mailbox's server").toBe(false);

    /* AND THE PASSWORD IS USABLE. `credentialState` is the boot contract's own answer for the row
       the shell's single-mailbox surfaces speak for — which after the removal IS the survivor.
       `foreign-host` here means a credential was withheld because it names a server this launch
       was not configured for, which is exactly what the old `isSeed` produced. */
    expect(await s.credentialState(),
      "the surviving mailbox's password was withheld against the removed mailbox's server")
      .toBe("ready");

    /* THE ROW ITSELF SURVIVED, unremoved and unresurrected: one live mailbox, and it is B. */
    const live = (await s.db.execute(
      "select id, address from mailboxes where status <> 'disabled'" as never,
    )).rows as Array<{ id: string; address: string }>;
    expect(live.map((r) => r.address)).toEqual([B.user]);
    expect(live[0]!.id).toBe(bId);
  });
});
