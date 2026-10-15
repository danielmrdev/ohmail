import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mailboxes, messages, folderState } from "@trafficflow/db";
import { formatClaim, META_FOLDER, parseClaim } from "@trafficflow/core/adapters/organizer-lease";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";

/**
 * THE LOCAL HALF OF THE ORGANIZER LEASE — a desktop install standing down from a mailbox Cloud
 * holds, and refusing to auto-resume when Cloud lets go.
 *
 * The project's design notes §4, the two transitions that actually happen to a person:
 *
 *  · **"Local mailbox added to Cloud."** The desktop stands down on its next cycle and STOPS
 *    SYNCING ENTIRELY — it does not keep passively mirroring, because a read-only IMAP loop is
 *    half the dual-organizer bug surface: it still observes folders, still feeds `adopt_external`,
 *    still burns a connection. The local mirror is frozen, kept, never auto-deleted.
 *  · **"Cloud lapses."** The desktop does NOT auto-resume. Mail keeps flowing regardless —
 *    ohmail is not an MX — so auto-resume would defend against a harm that does not exist while
 *    creating a real one: a forgotten install on an office machine silently becoming the thing
 *    that moves someone's mail, triggered by a billing event, with a rules store frozen at
 *    stand-down.
 *
 * The second is the one worth being careful about, because the LEASE alone cannot enforce it.
 * Once Cloud releases its claim the folder is empty, and an empty folder correctly reads as
 * "nobody has ever organized this mailbox" — which organizes. What actually enforces it is the
 * STICKY local row: `status='disabled'` plus the reason, which only an explicit human action
 * clears. That is asserted here rather than assumed, because the two mechanisms are easy to
 * confuse and the confusion ships as a laptop that starts moving somebody's mail unasked.
 *
 * GreenMail, on a real socket, because the claim is a message and the folder path has to survive a
 * `.` hierarchy delimiter.
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
/** GreenMail's delimiter is `.`, so the canonical `ohmail/_meta` is `ohmail._meta`. */
const META_PATH = META_FOLDER.split("/").join(".");

function greenmail(): { host: string; port: number; secure: false; auth: { user: string; pass: string } } {
  return {
    host: IMAP_HOST, port: IMAP_PORT, secure: false,
    auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: "test" },
  };
}

function eml(o: { from: string; to: string; subject: string; messageId: string }): string {
  return [
    `Message-ID: <${o.messageId}>`, `From: ${o.from}`, `To: ${o.to}`, `Subject: ${o.subject}`,
    "Content-Type: text/plain; charset=utf-8", "", "Hello — we have not met before.",
  ].join("\r\n");
}

async function client(cfg: ReturnType<typeof greenmail>): Promise<ImapFlow> {
  const c = new ImapFlow({ ...cfg, logger: false });
  await c.connect();
  return c;
}

/** Put a fresh CLOUD claim in `ohmail/_meta`, as the worker's gate would. */
async function seedCloudClaim(cfg: ReturnType<typeof greenmail>, installId: string): Promise<void> {
  const c = await client(cfg);
  try {
    const list = await c.list();
    if (!list.some((f) => f.path === META_PATH)) await c.mailboxCreate(META_PATH);
    await c.append(META_PATH, formatClaim({
      authorizedAt: null, capabilities: [],
      installId, kind: "cloud", displayName: "ohmail Cloud",
      heartbeat: new Date(), claimedAt: new Date(), nonce: "seed",
    }), ["\\Seen"]);
  } finally {
    await c.logout();
  }
}

/** Every claim in `ohmail/_meta`, read by an INDEPENDENT client. */
async function claimsOn(cfg: ReturnType<typeof greenmail>): Promise<Array<{ installId: string; kind: string }>> {
  const c = await client(cfg);
  try {
    const list = await c.list();
    if (!list.some((f) => f.path === META_PATH)) return [];
    const lock = await c.getMailboxLock(META_PATH);
    try {
      const out: Array<{ installId: string; kind: string }> = [];
      for await (const m of c.fetch("1:*", { uid: true, headers: true })) {
        if (!m.headers) continue;
        const claim = parseClaim(m.headers.toString("utf8"));
        if (!claim || "malformed" in claim) continue;
        out.push({ installId: claim.installId, kind: claim.kind });
      }
      return out;
    } finally {
      lock.release();
    }
  } finally {
    await c.logout();
  }
}

/** Remove every claim — Cloud releasing on an entitlement lapse. */
async function releaseAll(cfg: ReturnType<typeof greenmail>): Promise<void> {
  const c = await client(cfg);
  try {
    const lock = await c.getMailboxLock(META_PATH);
    try {
      const uids: number[] = [];
      for await (const m of c.fetch("1:*", { uid: true })) uids.push(m.uid);
      if (uids.length > 0) await c.messageDelete(uids, { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await c.logout();
  }
}

/**
 * The DISTINCT `folder_state.last_set_by` values on a set of rows, sorted.
 *
 * ASSERTED AS A VALUE, NEVER AS "not `'us'`" — the rule `organizer-takeover.e2e.test.ts` states
 * in the same words, and the reason these three assertions were spelled as a FILTER against
 * `'external'` and went stale in silence. There are three attributions now, not two:
 *
 *  · `'us'`       — THIS install decided. A stood-down install writing one is the dual-organizer
 *                   defect these cases exist to catch: it is the placement it would carry to
 *                   somebody else's mailbox, and the row every unpressed mover requires.
 *  · `'peer'`     — another install of this account placed it, in a folder ohmail organizes.
 *                   What a READER actually observes, and what both reader seams now write.
 *  · `'external'` — the person filed it by hand, in a folder of their own. A false claim for the
 *                   mail here, which is APPENDed to `INBOX`; and it means "hands off, for ever"
 *                   to every retro pass, so it freezes mail behind a rule its owner already wrote.
 *
 * A filter that admits everything except one of the three cannot tell the other two apart, which
 * is why the value is named. `'peer'` is out of every UNPRESSED mover's reach exactly as
 * `'external'` was — `sync.ts:1619/:2113`, `ohbox-tidy.ts:703`, `screener-auto.ts:369` and
 * `reconcileFolders` all require `'us'` — so admitting it here concedes nothing about organizing.
 *
 * The hosted half of this file, `apps/worker/test/organizer-lease.e2e.test.ts:377`, carries the
 * same correction and names the same abandoned predicate. The two are kept in one shape on
 * purpose: a desktop and a worker standing down are the same invariant read from two sides.
 */
function setBy(rows: ReadonlyArray<{ lastSetBy: string }>): string[] {
  return [...new Set(rows.map((r) => r.lastSetBy))].sort();
}

/**
 * Rows whose DESIRED folder is not where the message actually is — a move this install chose.
 *
 * THE BEHAVIOUR, beside the label. `setBy` alone pins what the row SAYS; a build that stamped a
 * reader's attribution while still planning a move would satisfy it and would still be two
 * installs deciding where one person's mail goes. An adoption is `desired === observed`, and a
 * reader has nothing to reconcile — so this list is empty for a reason no label can express.
 */
function chosenMoves(
  rows: ReadonlyArray<{ desiredFolder: string; observedFolder: string }>,
): ReadonlyArray<{ desiredFolder: string; observedFolder: string }> {
  return rows.filter((r) => r.desiredFolder !== r.observedFolder);
}

describe("the sidecar reads the organizer lease before its first move", () => {
  const dirs: string[] = [];
  const running: Sidecar[] = [];
  afterEach(async () => {
    for (const s of running.splice(0)) await s.stop().catch(() => undefined);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function dataDir(): string {
    const d = mkdtempSync(join(tmpdir(), "ohmail-lease-"));
    dirs.push(d);
    return d;
  }

  /**
   * `start()`, with a throw recorded instead of propagated.
   *
   * Not politeness — it is what makes the assertions below name the BEHAVIOUR. Standing down
   * closes the IMAP login (§4: stop burning a connection), so a build with the gate removed runs
   * `ensureFolders` on a dead socket and dies with `Connection not available` somewhere inside
   * imapflow. That is a red, but it is a red that names a symptom three layers from the decision,
   * and a guard whose failure message does not say what broke is a guard the next person
   * misdiagnoses. Recording the throw lets `organizerState()` and the message count be checked in
   * every case, so removing either gate fails with "this install organized a mailbox it must
   * not" rather than with a socket error.
   */
  async function startRecording(s: Sidecar): Promise<string | null> {
    try {
      await s.start();
      return null;
    } catch (err) {
      return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
  }

  it("stands down from a mailbox a fresh CLOUD claim holds, and organizes NOTHING", async () => {
    const cfg = greenmail();
    // Cloud got there first. A fresh cloud lease outranks local for CONTINUING coverage (§4).
    await seedCloudClaim(cfg, "ohmail-cloud:production");

    const c = await client(cfg);
    await c.append("INBOX", eml({
      from: "stranger@example.com", to: cfg.auth.user, subject: "first contact", messageId: "sc-lease-1@x",
    }));
    await c.logout();

    const sidecar = await createSidecar({
      dataDir: dataDir(), imap: cfg, machineName: "Mila's MacBook",
      pollIntervalMs: 200, leaseStaleAfterMs: 60_000,
    });

    await grantOrganizeConsent(sidecar);
    running.push(sidecar);
    const startError = await startRecording(sidecar);

    // ── STOPPED ENTIRELY, NOT MIRRORING QUIETLY ───────────────────────────────────────────
    //
    // The DECISION is asserted before anything else and independently of whether `start()`
    // returned cleanly, so a build with the gate removed fails here — naming the behaviour —
    // rather than inside imapflow on the closed login the stand-down left behind.
    expect(sidecar.organizerState()).toMatchObject({
      organizing: false,
      reason: "organized_elsewhere:cloud",
      heldBy: "ohmail Cloud",          // §4's prompt names the machine; here the machine is Cloud
    });
    /* ── WHAT A STOOD-DOWN INSTALL MAY NOT DO — AND MIRRORING IS NOT ON THAT LIST ──────────
     *
     * The symmetric-takeover ruling: the stand-down write leaves the install with its
     * *"row, credentials, mirror kept"*, and it *"reads the mailbox from now on"*. So this
     * install's own copy of the message is EXPECTED, and the two lines that used to stand here —
     * *"Not one message ingested"*, and a row read as `status = 'disabled'` with a
     * `disabled_reason` — were the pre-0083 shape, in which a loser left the roster entirely.
     * Neither could say so while nothing could reach a mail server.
     *
     * The claim that survives is about the SERVER and about intent. A reader ADOPTS: the reader
     * arm of `planChange` keeps the arrival folder and `commitChange` records where the mail
     * already is. `'us'` is a placement this install CHOSE and would carry to somebody else's
     * mailbox, and there must not be one.
     *
     * THE ATTRIBUTION FOR THAT ADOPTION IS `'peer'`, and this line read `'external'` until the
     * reader stamp landed. `'external'` says the person filed it by hand in a folder of their
     * own — false of mail APPENDed to `INBOX`, and the one record that means "hands off, for
     * ever" to every retro pass, so it froze mail behind a rule its owner had already written.
     * The sibling cases were corrected with the stamp and this file was not, which is the whole
     * of what was red here: the product stood down correctly throughout. See {@link setBy} for
     * why the value is named rather than filtered against.
     */
    const placements = await sidecar.db.select().from(folderState);
    /* SUBSET, not the exact set, at THIS point only: `start()` returns when the engine is up and
       not when the first drain has committed, so the mirror may legitimately still be empty. The
       exact-value form is asserted after `syncUntilQuiet()` below, where a row is owed. */
    expect(setBy(placements).filter((v) => v !== "peer"),
      "a stood-down install recorded a placement that is not another install's").toEqual([]);
    expect(chosenMoves(placements),
      "a stood-down install chose a move in a mailbox it does not organize").toEqual([]);
    // And it created no tree: `ensureFolders` is behind the same gate as the first move.
    const folders = (await (async () => {
      const cc = await client(cfg);
      try { return (await cc.list()).map((f) => f.path); } finally { await cc.logout(); }
    })());
    expect(folders).not.toContain("ohmail.Screener");

    // The local row records WHO, which is what makes §4's "Organized by Cloud" tellable apart
    // from a mailbox that merely stopped syncing. The ROLE carries the whole decision now, and
    // the status deliberately does not move: this mailbox is connected and being read.
    const [row] = await sidecar.db.select().from(mailboxes)
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    expect(row!.organizerRole).toBe("reader");
    expect(row!.organizedByKind).toBe("cloud");
    expect(row!.organizedByName).toBe("ohmail Cloud");
    expect(row!.status).toBe("connected");
    expect(row!.takeoverAuthorizedAt).toBeNull();

    // Cloud's claim is untouched, and the desktop left none of its own: standing down RELEASES
    // ours so the winner's own gate is clean immediately.
    expect(await claimsOn(cfg)).toEqual([{ installId: "ohmail-cloud:production", kind: "cloud" }]);

    /* A later drain is a READER's drain — the gate is on the public entry point, not only on
     * `start()`, and what it gates is ORGANIZING rather than syncing. `syncUntilQuiet()` may
     * therefore return a positive count; what it may not do is throw (the pre-0083 gate closed
     * the login, and a build that reinstated that dies in imapflow here) or leave a chosen
     * placement behind. Asserted on `last_set_by` again rather than on a cycle count, because
     * a count of zero would now forbid the mirror the ruling says this install keeps. */
    const drained = await sidecar.syncUntilQuiet().catch(() => -1);
    expect(drained, "a stood-down install's own drain threw instead of reading").toBeGreaterThanOrEqual(0);
    const afterDrain = await sidecar.db.select().from(folderState);
    /* THE EXACT SET, and therefore a POSITIVE CONTROL as well as a refusal: the drain has run, so
       exactly one placement is owed for the message appended above. `[]` here would mean the
       reader mirrored nothing — the stand-down reading as "stopped entirely", which §4 forbids —
       and `["us"]` or `["external"]` name the two ways the attribution can be wrong. */
    expect(setBy(afterDrain),
      "a later drain recorded a placement of its own, whatever start() did").toEqual(["peer"]);
    expect(chosenMoves(afterDrain),
      "a later drain chose a move, whatever start() did").toEqual([]);
    expect(await claimsOn(cfg), "a later drain claimed the mailbox")
      .toEqual([{ installId: "ohmail-cloud:production", kind: "cloud" }]);
    expect(startError, "start() must return cleanly on a stand-down, not throw").toBeNull();
  }, 60_000);

  it("does NOT auto-resume when Cloud releases: the stand-down is sticky in the local row", async () => {
    const cfg = greenmail();
    await seedCloudClaim(cfg, "ohmail-cloud:production");

    const dir = dataDir();
    const first = await createSidecar({
      dataDir: dir, imap: cfg, machineName: "Mila's MacBook",
      pollIntervalMs: 200, leaseStaleAfterMs: 60_000,
    });
    await grantOrganizeConsent(first);
    await first.start();
    expect(first.organizerState().organizing).toBe(false);
    await first.stop();

    // Cloud lapses and RELEASES. `ohmail/_meta` is now empty, which to the LEASE alone reads as
    // "nobody has ever organized this mailbox" — the arm that organizes.
    await releaseAll(cfg);
    expect(await claimsOn(cfg)).toEqual([]);

    const c = await client(cfg);
    await c.append("INBOX", eml({
      from: "stranger@example.com", to: cfg.auth.user, subject: "after the lapse", messageId: "sc-lease-2@x",
    }));
    await c.logout();

    // Same data directory: the same install, relaunched, with the stand-down still on its row.
    const second = await createSidecar({
      dataDir: dir, imap: cfg, machineName: "Mila's MacBook",
      pollIntervalMs: 200, leaseStaleAfterMs: 60_000,
    });
    await grantOrganizeConsent(second);
    running.push(second);

    // THE ROW OUTRANKS THE FOLDER. The relaunch finds the STOOD-DOWN row rather than minting a
    // fresh `connected` one — a lease stand-down is the same mailbox paused, not a tombstone —
    // and it therefore organizes nothing even though `ohmail/_meta` is now completely empty and
    // the lease alone would say "nobody has ever organized this mailbox".
    //
    // This is the assertion that would have caught the defect this test found on its first run:
    // `ensureLocalWorld` used to treat any `disabled` row as a tombstone, so relaunching the app
    // minted a new mailbox and the install silently resumed organizing.
    expect(second.world.standDownReason).toBe("organized_elsewhere:cloud");
    expect(second.world.mailboxId).toBe(first.world.mailboxId);
    const relaunchError = await startRecording(second);
    expect(second.organizerState()).toMatchObject({
      organizing: false, reason: "organized_elsewhere:cloud",
    });
    /* RESUMING IS ORGANIZING, NOT SYNCING. This asserted a cycle count of zero and an empty
     * message table, which was the pre-0083 reading of "did not resume": a stood-down install
     * stopped entirely. The symmetric-takeover ruling keeps its *"row, credentials,
     * mirror"* and has it read the mailbox from now on, so the relaunch DOES drain and its own
     * copy does grow — and the mail appended above is exactly what a reader should now hold.
     *
     * What must not happen is the becoming: no placement this install chose (`last_set_by` is
     * `'peer'` on every row, the reader's adoption), no claim of its own in a folder the
     * lease alone would hand it, and the role still `reader` after the cycles. That last one is
     * the defect this case found on its first run, restated: `ensureLocalWorld` used to treat a
     * `disabled` row as a tombstone, mint a fresh mailbox and resume organizing in silence.
     */
    expect(await second.syncUntilQuiet().catch(() => -1),
      "the relaunch's own drain threw instead of reading").toBeGreaterThanOrEqual(0);
    expect(relaunchError).toBeNull();
    const secondPlacements = await second.db.select().from(folderState);
    expect(setBy(secondPlacements),
      "restarting the app organized a mailbox this install stood down from").toEqual(["peer"]);
    expect(chosenMoves(secondPlacements),
      "restarting the app chose a move in a mailbox it stood down from").toEqual([]);
    expect(await claimsOn(cfg),
      "the relaunch claimed a mailbox whose folder happened to be empty").toEqual([]);

    // Exactly one mailbox row, still a reader, still naming who took it. A second row would BE
    // the auto-resume.
    const rows = await second.db.select().from(mailboxes);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.organizerRole).toBe("reader");
    /* AND NO HOLDER — because Cloud released, and the reader's peek says so honestly. That pair,
       reader with nobody holding the mailbox, is the whole point of this case: the role is what
       makes the stand-down sticky, and it stays sticky with an EMPTY `ohmail/_meta` that the
       lease alone would read as "nobody has ever organized this mailbox". */
    expect(rows[0]!.organizedByKind).toBeNull();
    // And the install wrote no claim of its own while standing down.
    expect(await claimsOn(cfg)).toEqual([]);
  }, 60_000);

  it("organizes, and claims, when nobody else holds the mailbox", async () => {
    // The other direction, and the reason the two assertions above are not vacuous: with an empty
    // `_meta` the same install DOES organize, files first contact into the Screener on the server,
    // and leaves exactly one fresh `local` claim naming the machine.
    const cfg = greenmail();
    const c = await client(cfg);
    await c.append("INBOX", eml({
      from: "stranger@example.com", to: cfg.auth.user, subject: "first contact", messageId: "sc-lease-3@x",
    }));
    await c.logout();

    const sidecar = await createSidecar({
      dataDir: dataDir(), imap: cfg, machineName: "Mila's MacBook",
      pollIntervalMs: 200, leaseStaleAfterMs: 60_000,
    });

    await grantOrganizeConsent(sidecar);
    running.push(sidecar);
    expect(await startRecording(sidecar), "an unheld mailbox must start cleanly").toBeNull();

    /* `claimed` is this install's claim STANDING — the instruction, set where the gate becomes
       entitled to the lease, one IMAP round trip before `organizing`. Added by "phone: the
       background arm decides on whether the mailbox is ours" (2026-09-12), whose reading was a
       mailbox just claimed looking exactly like one nobody consented to. Stated in full and not
       matched loosely: an organizing install answering `claimed: false` is the state that change
       exists to make unreachable, and only the whole object says so. */
    expect(sidecar.organizerState()).toEqual({ organizing: true, reason: null, heldBy: null,
      releaseRequestedAt: null, unreadableSince: null, unreadableReason: null, claimed: true, releaseRefusal: null, holderState: null });
    expect(await sidecar.db.select().from(messages)).toHaveLength(1);

    const claims = await claimsOn(cfg);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.kind).toBe("local");
    // The install id is the local account row — stable across launches, distinct between machines.
    expect(claims[0]!.installId).toBe(sidecar.world.accountId);

    // And the message physically moved, checked with an independent client: organize-in-place
    // means the folder on the server is the fact.
    const cc = await client(cfg);
    try {
      const lock = await cc.getMailboxLock("ohmail.Screener");
      try {
        const found = await cc.search({ header: { "message-id": "sc-lease-3@x" } }, { uid: true });
        expect(Array.isArray(found) ? found.length : 0).toBe(1);
      } finally {
        lock.release();
      }
    } finally {
      await cc.logout();
    }
  }, 60_000);

  /* ══ MAIL 0092 — THE ROW RECORDS WHICH INSTALL HOLDS IT, NOT ONLY WHAT SORT ═══════════════
   *
   * `organized_by_kind` is one of three words and answers "what sort of thing holds this". The
   * hand-back needs "is this us", and those are the same question only when there is one install
   * per kind — which the design explicitly rejects: a hosted deployment's identity carries its
   * environment, and a person may run two desktops. The hosted worker learned this first; these
   * three are the desktop half.
   *
   * The third is the one the other two cannot see. Both of them pass if the projection writes
   * THIS install's id instead of the holder's — and that mistake TYPECHECKS, because an outer
   * `const installId = world.accountId` is in scope at the projection and a same-named binding
   * shadows it only inside its own block. It was made and caught here by renaming the binding
   * and finding that nothing broke.
   */
  it("MAIL 0092 — a peer's tenure is recorded under the PEER's id, and a quiet poll re-stamps nothing", async () => {
    const cfg = greenmail();
    await seedCloudClaim(cfg, "ohmail-cloud:production");
    const sidecar = await createSidecar({
      dataDir: dataDir(), imap: cfg, machineName: "Mila's MacBook",
      pollIntervalMs: 200, leaseStaleAfterMs: 60_000,
    });
    await grantOrganizeConsent(sidecar);
    running.push(sidecar);
    await startRecording(sidecar);

    const readRow = async () => (await sidecar.db.select().from(mailboxes)
      .where(eq(mailboxes.id, sidecar.world.mailboxId)))[0]!;

    /* WAIT FOR THE PROJECTION. `startRecording` returns when the engine is up, not when the first
       holder refresh has written; reading immediately raced it and read a NULL that meant "not
       yet", which is indistinguishable from "never". */
    const first = await (async () => {
      for (let i = 0; i < 150; i++) {
        const r = await readRow();
        if (r.organizedByInstallId !== null) return r;
        await new Promise((res) => setTimeout(res, 100));
      }
      return await readRow();
    })();
    expect(first.organizedByKind, "the fixture did not put Cloud's claim on the row").toBe("cloud");
    /* THE PEER'S ID, NOT OURS. `world.accountId` is this install; writing it here would make the
       row say the desktop holds a mailbox Cloud holds. */
    expect(first.organizedByInstallId,
      "the row records this install's id for somebody else's tenure")
      .toBe("ohmail-cloud:production");
    expect(first.organizedByInstallId).not.toBe(sidecar.world.accountId);

    /* AND A QUIET POLL CHANGES NOTHING. If the projection wrote our id, every poll would find the
       row "different", rewrite it, and re-stamp `organizer_event_at` — the fifteen-second notice
       the comparison exists to prevent. Comparing the stamp across several polls is what catches
       that; comparing the id alone would not. */
    const stampBefore = first.organizerEventAt?.getTime() ?? null;
    await new Promise((r) => setTimeout(r, 1_200));
    const after = await readRow();
    expect(after.organizerEventAt?.getTime() ?? null,
      "a quiet poll re-stamped the organizer event, so the row is being rewritten every cycle")
      .toBe(stampBefore);
    expect(after.organizedByInstallId).toBe("ohmail-cloud:production");
  }, 60_000);

  it("MAIL 0092 — a row whose id is NULL is refreshed, not left as it was", async () => {
    const cfg = greenmail();
    await seedCloudClaim(cfg, "ohmail-cloud:production");
    const sidecar = await createSidecar({
      dataDir: dataDir(), imap: cfg, machineName: "Mila's MacBook",
      pollIntervalMs: 200, leaseStaleAfterMs: 60_000,
    });
    await grantOrganizeConsent(sidecar);
    running.push(sidecar);
    await startRecording(sidecar);

    /* THE STATE A MIGRATION LEAVES: five holder columns already agreeing with the folder, and the
       sixth NULL because the column has only just been added. A five-column compare finds nothing
       to do and the id stays NULL for ever — which fails closed in the release arm, so the person
       is told they cannot stop organizing a mailbox they hold. */
    await sidecar.db.update(mailboxes).set({ organizedByInstallId: null })
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    expect((await sidecar.db.select().from(mailboxes)
      .where(eq(mailboxes.id, sidecar.world.mailboxId)))[0]!.organizedByInstallId).toBeNull();

    const backfilled = await (async () => {
      for (let i = 0; i < 100; i++) {
        const [r] = await sidecar.db.select().from(mailboxes)
          .where(eq(mailboxes.id, sidecar.world.mailboxId));
        if (r!.organizedByInstallId !== null) return r!.organizedByInstallId;
        await new Promise((res) => setTimeout(res, 100));
      }
      return null;
    })();
    expect(backfilled,
      "the id stayed NULL — the compare cannot see a column it does not carry, so it never refreshes")
      .toBe("ohmail-cloud:production");
  }, 60_000);


  it("MAIL 0092 — while THIS install organizes, no id is recorded: the holder columns name somebody else", async () => {
    const cfg = greenmail();
    // No competing claim: the desktop organizes.
    const sidecar = await createSidecar({
      dataDir: dataDir(), imap: cfg, machineName: "Mila's MacBook",
      pollIntervalMs: 200, leaseStaleAfterMs: 60_000,
    });
    await grantOrganizeConsent(sidecar);
    running.push(sidecar);
    await startRecording(sidecar);
    await new Promise((r) => setTimeout(r, 2_000));

    const [row] = await sidecar.db.select().from(mailboxes)
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    /* THE HOLDER COLUMNS DESCRIBE SOMEBODY ELSE. An install that holds the mailbox itself has
       them empty — "organized by <someone>" is a sentence about a peer. The first version of this
       case asserted the opposite, expecting our own id here, and it was the premise that was
       wrong rather than the product.
       This is the trap's OTHER FACE and worth guarding for that reason: a projection that reached
       for `world.accountId` would write this install's id exactly here, where nobody else holds
       the mailbox — and the row would then claim a peer holds it while we do. */
    expect(row!.organizerRole).toBe("organizer");
    expect(row!.organizedByInstallId,
      "the row names a holder while this install is the holder — the projection is writing our own id")
      .toBeNull();
    expect(row!.organizedByKind, "same, by kind").toBeNull();
  }, 60_000);

});
