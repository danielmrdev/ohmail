import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { folderState, mailboxes, messages } from "@trafficflow/db";
import { formatClaim, META_FOLDER, parseClaim } from "@trafficflow/core/adapters/organizer-lease";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { openLocalDb, type LocalDb } from "../src/db.js";
import { authorizeOrganizerTakeover } from "../src/organize-here.js";

/**
 * ENDING A STAND-DOWN — the only way a mailbox this install stopped organizing comes back to it.
 *
 * Exactly one active organizer per mailbox is the invariant, and standing down is how an install
 * honours it. Standing down is also STICKY: it is recorded on the local mailbox row, so that
 * relaunching the app cannot quietly resume organizing somebody's mail. That stickiness is
 * correct, and on its own it is a one-way door.
 *
 * These are the four things the exit has to get right, each of which is a way of getting it wrong:
 *
 *  1. A previous organizer that stopped WITHOUT releasing leaves a claim behind. The lease reads
 *     such a mailbox as available and declines to take it, so clearing the stand-down alone
 *     produces an action that appears to do nothing. The explicit authorization is what changes
 *     that answer, and the second test below is the proof that it is load-bearing rather than
 *     decorative.
 *  2. An organizer holding a NEWER PRESS keeps the mailbox regardless of what was authorized
 *     here. Authorization grants permission to ask, never permission to win. (Liveness alone
 *     stopped being a defence in that change — see that test for what replaced it.)
 *  2b. And the other half of that same rule: an organizer that is still alive but that NOBODY
 *     PRESSED FOR **is** displaced by an explicit request. A press ranks above liveness, so the
 *     two cases are one comparison read in both directions — a newer press defends, no press at
 *     all does not. The case the old liveness-wins rule was wrong about is ordinary: somebody
 *     loses access to the machine their organizer runs on and wants the mailbox organized from
 *     the laptop in front of them; the old remedy required action from the side that had
 *     disappeared, which is a lockout rather than a continuation rule. Nobody self-promotes by
 *     merely ARRIVING — an install with no press still ranks below an incumbent with none.
 *  2c. A stood-down install is a READER, not an inert one. It keeps its row, its credentials and
 *     its mirror, and it reads the mailbox from then on — so its own copy of the mail growing is
 *     the feature working. What it must never do is CHOOSE where mail goes.
 *  3. The authorization is spent once. A standing right would let this install seize the mailbox
 *     back long after a human had deliberately moved it somewhere else.
 *  4. A paused mailbox and a removed mailbox are different states that happen to share a status.
 *     Ending a pause must not resurrect a removal, and must not mint a second mailbox row.
 *
 * Against a real IMAP server, because the claim is a message in a folder and the folder's name
 * has to survive the server's own hierarchy delimiter.
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
/** This server's delimiter is `.`, so the canonical `ohmail/_meta` is `ohmail._meta`. */
const META_PATH = META_FOLDER.split("/").join(".");
const CLOUD_ID = "ohmail-cloud:production";

type Cfg = { host: string; port: number; secure: false; auth: { user: string; pass: string } };

function greenmail(): Cfg {
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

async function client(cfg: Cfg): Promise<ImapFlow> {
  const c = new ImapFlow({ ...cfg, logger: false });
  await c.connect();
  return c;
}

async function deliver(cfg: Cfg, messageId: string): Promise<void> {
  const c = await client(cfg);
  try {
    await c.append("INBOX", eml({
      from: "stranger@example.com", to: cfg.auth.user, subject: "first contact", messageId,
    }));
  } finally {
    await c.logout();
  }
}

/**
 * Put one claim in the meta folder, at a chosen age.
 *
 * `ageMs` is what makes the difference between the two cases that matter: an organizer that is
 * still renewing (age 0) and one that stopped (age past the staleness window). They are the same
 * message with a different heartbeat, which is exactly how the mechanism sees them.
 */
async function seedClaim(
  cfg: Cfg,
  o: {
    installId: string; kind: "cloud" | "local"; displayName: string; ageMs?: number;
    /**
     * THE PRESS ON THE CLAIM — `X-Ohmail-Authorized-At`, and since that change the FIRST term of
     * the election (`compareStrength`, and the `ourPress > livePress` gate beside it).
     *
     * It defaulted to `null` here and had no way to be anything else, which quietly made every
     * claim this file seeds a claim NOBODY PRESSED FOR — `-Infinity`, beaten by any real instant.
     * That is the correct default for the three tests that want a quiet or a stale organizer, and
     * it is the wrong fixture for the one that wants a holder able to defend itself: a press ranks
     * above liveness now, so "still renewing" is no longer a defence on its own.
     */
    authorizedAt?: Date;
  },
): Promise<void> {
  const c = await client(cfg);
  try {
    const list = await c.list();
    if (!list.some((f) => f.path === META_PATH)) await c.mailboxCreate(META_PATH);
    const at = new Date(Date.now() - (o.ageMs ?? 0));
    await c.append(META_PATH, formatClaim({
      authorizedAt: o.authorizedAt ?? null, capabilities: [],
      installId: o.installId, kind: o.kind, displayName: o.displayName,
      heartbeat: at, claimedAt: at, nonce: `seed-${randomUUID()}`,
    }), ["\\Seen"]);
  } finally {
    await c.logout();
  }
}

/** Every claim in the meta folder, read by an INDEPENDENT client. */
async function claimsOn(cfg: Cfg): Promise<Array<{ installId: string; kind: string }>> {
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

/** How many copies of a message sit in a folder, per the server rather than per our mirror. */
async function countIn(cfg: Cfg, path: string, messageId: string): Promise<number> {
  const c = await client(cfg);
  try {
    if (!(await c.list()).some((f) => f.path === path)) return 0;
    const lock = await c.getMailboxLock(path);
    try {
      const found = await c.search({ header: { "message-id": messageId } }, { uid: true });
      return Array.isArray(found) ? found.length : 0;
    } finally {
      lock.release();
    }
  } finally {
    await c.logout();
  }
}

/**
 * WHAT AN INSTALL DID TO A MAILBOX — two numbers out of its own database.
 *
 * ── WHY THIS REPLACED `expect(messages).toHaveLength(0)` ──────────────────────────────────────
 *
 * Four assertions in this file used to read "a stood-down install mirrored nothing", and they were
 * the earlier design written down. The change that replaced it — *"a stood-down install is a READER, not a
 * corpse"* — names the old behaviour as the defect in its own words: the gate returned before the
 * first drain, so a reader's mirror never grew by one message and `\Seen` never reached the server.
 * `reader-drain.test.ts`, three directories-worth of assertions away and green, states the
 * replacement as a test name: *"THE MIRROR GOES ON GROWING"*. Two files in this directory therefore
 * made opposite claims about one state, and only this one needed a mail server — so only this one
 * could go stale without anybody seeing it.
 *
 * ── AND WHY A ROW COUNT WAS NEVER THE RIGHT QUESTION ANYWAY ───────────────────────────────────
 *
 * `messages` cannot tell the two failures apart. An install that MIRRORED and an install that
 * ORGANIZED ONE CYCLE AND THEN STOOD DOWN both leave one row, and only the second is the
 * dual-organizer bug this file exists to catch. So the count is kept — a reader that mirrors
 * nothing is its own regression — and the DISCRIMINATOR is asserted beside it:
 *
 * `setBy` is every distinct `folder_state.last_set_by`. The reader arm of `planChange`
 * (`pipeline.ts`, the `deps.readerMode === true` branch) returns `passive: true` above the rule
 * read, the classifier and the money gate, and `commitChange` writes that as `'peer'` — another
 * install of this account placed it, and this one merely watched. `'us'` means THIS install
 * decided where that mail belongs, and every unpressed retro pass requires `'us'`, so the column
 * is the durable record of which install was the organizer.
 *
 * A reader is `{ mirrored: n, setBy: ["peer"] }` and an organizer is `["us"]`. That is a sharper
 * statement than the row count ever made, and it fails for the right reason: a loser that ran one
 * organizing cycle shows `'us'` while its `messages` count looks exactly like a reader's.
 *
 * `'peer'` and not `'external'` since 2026-09-06 (Fable ruling, reader stamp). The mail here is
 * APPENDed to INBOX, a folder ohmail organizes, and `'external'` claimed the person had filed it
 * there by hand — which froze it past the reach of every mover. The discriminator is unharmed:
 * `'peer'` is still ≠ `'us'`, which is the only property these four assertions rest on.
 *
 * ASSERT THE VALUE, NEVER "not us". Both reader seams write `'peer'` — the new-message arm and the
 * `adopt_external` one — precisely so this shape does not depend on whether the loser saw the
 * message arrive at the gate or move there afterwards. An assertion loosened to "anything but
 * `'us'`" would hide exactly that drift, and would also pass for a row filed as the user's hand.
 *
 * ── `routing_decisions` WAS THE OBVIOUS SECOND TERM AND IT IS DELIBERATELY NOT HERE ───────────
 *
 * It reads ZERO on both sides. The reader arm cannot write one, which is true and is why it looked
 * like a discriminator — but the ORGANIZER did not write one either for this mail on this door,
 * measured with the positive control below at `{ decisions: 0, setBy: ["us"] }`. A term that is 0
 * for the install that organized and 0 for the install that did not distinguishes nothing, and
 * asserting it would have been a guard that cannot fail dressed as the strongest claim in the
 * file. Left out rather than left in, and recorded here so the next person does not re-add it.
 */
async function shapeOf(s: Sidecar): Promise<{ mirrored: number; setBy: string[] }> {
  const [mirrored, folders] = await Promise.all([
    s.db.select().from(messages),
    s.db.select().from(folderState),
  ]);
  return {
    mirrored: mirrored.length,
    setBy: [...new Set(folders.map((f) => f.lastSetBy))].sort(),
  };
}

describe("ending an organizer stand-down", () => {
  const dirs: string[] = [];
  const running: Sidecar[] = [];

  afterEach(async () => {
    for (const s of running.splice(0)) await s.stop().catch(() => undefined);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function dataDir(): Promise<string> {
    const d = await freshDataDir("ohmail-takeover-");
    dirs.push(d);
    return d;
  }

  /**
   * `start()` with a throw recorded rather than propagated, so every assertion below names the
   * BEHAVIOUR. Standing down closes the IMAP login, so a build that skipped the gate would die
   * inside the mail client on a closed socket — a red that points three layers away from the
   * decision. Recording the throw lets the organizer state and the message count be checked in
   * every case.
   */
  async function startRecording(s: Sidecar): Promise<string | null> {
    try {
      await s.start();
      return null;
    } catch (err) {
      return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
  }

  async function launch(dir: string, cfg: Cfg, machineName = "This machine"): Promise<Sidecar> {
    const s = await createSidecar({
      dataDir: dir, imap: cfg, machineName,
      // Long enough that nothing re-enters mid-assertion; the drain on start() is what these
      // tests measure.
      pollIntervalMs: 60_000,
      leaseStaleAfterMs: 60_000,
    });
    await grantOrganizeConsent(s);
    running.push(s);
    return s;
  }

  /** Stand this install down behind a live organizer, then shut it down. */
  async function standDown(dir: string, cfg: Cfg): Promise<string> {
    await seedClaim(cfg, { installId: CLOUD_ID, kind: "cloud", displayName: "ohmail Cloud" });
    const first = await launch(dir, cfg);
    await startRecording(first);
    expect(first.organizerState()).toMatchObject({
      organizing: false, reason: "organized_elsewhere:cloud",
    });
    const mailboxId = first.world.mailboxId;
    await first.stop();
    running.splice(running.indexOf(first), 1);
    return mailboxId;
  }

  /** Replace whatever is in the meta folder with a single claim of the given age. */
  async function replaceClaims(cfg: Cfg, o: Parameters<typeof seedClaim>[1]): Promise<void> {
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
    await seedClaim(cfg, o);
  }

  it("an explicit request lets a stood-down install take a mailbox whose organizer went quiet", async () => {
    const cfg = greenmail();
    const dir = await dataDir();
    const mailboxId = await standDown(dir, cfg);

    // The other organizer stops renewing but never releases — a machine that crashed, or one that
    // never woke up. Its claim is still in the folder, merely old.
    await replaceClaims(cfg, {
      installId: CLOUD_ID, kind: "cloud", displayName: "ohmail Cloud", ageMs: 20 * 60_000,
    });
    await deliver(cfg, "takeover-1@x");

    // The user asks for this machine.
    const { db, close } = await launchDbOnly(dir);
    const authorized = await authorizeOrganizerTakeover(db, { intent: "takeover", address: cfg.auth.user, now: new Date() });
    expect(authorized.outcome).toBe("authorized");
    expect(authorized.previousReason).toBe("organized_elsewhere:cloud");
    // THE SAME mailbox row, not a fresh one. A pause and a removal share a status, and ending the
    // pause by clearing only the reason would turn it into a removal — after which the next launch
    // mints a second mailbox for the same address, with none of the first one's history.
    expect(authorized.mailboxId).toBe(mailboxId);
    await close();

    const second = await launch(dir, cfg);
    /* -- THE REQUEST DOES NOT END THE ROW'S MEMORY, AND SINCE MAIL 0083 IT MUST NOT ---------
     *
     * This asserted `standDownReason` was NULL, on the ground that `authorizeOrganizerTakeover`
     * moves `status`, `disabled_reason` and the stamp together. It still clears those two columns
     * — and neither of them is the record any more. The stand-down is `organizer_role =
     * 'reader'`, which this ceremony deliberately leaves alone (`organize-here.ts`: *"the role is
     * deliberately NOT among them. The GATE promotes"*), so the memory survives to the gate
     * exactly as the stamp does, and what ends it is the lease saying organize three lines below.
     * Observed against GreenMail (10/10, 2026-09-22); `reader-no-auto-resume.test.ts` drives the
     * same two transitions against PGlite.
     */
    expect(second.world.standDownReason,
      "the row stopped remembering the stand-down before any lease had been read")
      .toBe("organized_elsewhere:cloud");
    expect(second.world.mailboxId, "and it must still be the same mailbox").toBe(mailboxId);
    expect(await startRecording(second)).toBeNull();

    /* `claimed` is this install's claim STANDING — the instruction, set where the gate becomes
       entitled to the lease, one IMAP round trip before `organizing`. Added by "phone: the
       background arm decides on whether the mailbox is ours" (2026-09-12), whose reading was a
       mailbox just claimed looking exactly like one nobody consented to. Stated in full and not
       matched loosely: an organizing install answering `claimed: false` is the state that change
       exists to make unreachable, and only the whole object says so. */
    expect(second.organizerState())
      .toEqual({ organizing: true, reason: null, heldBy: null, releaseRequestedAt: null,
        unreadableSince: null, unreadableReason: null, claimed: true, releaseRefusal: null, holderState: null });
    /* THE POSITIVE HALF of the reader shape the three tests below assert, and it is what keeps
     * those three honest. `setBy: ["peer"]` is only evidence of a reader if an ORGANIZER on
     * this same door writes something else — otherwise it is a guard that passes because the
     * standalone install never writes either, which is a guard that cannot fail. It earned its
     * place immediately: it is what caught `routing_decisions` reading 0 on BOTH sides, and that
     * term is gone from the shape rather than sitting in it looking like evidence. */
    expect(await shapeOf(second)).toEqual({ mirrored: 1, setBy: ["us"] });
    expect(await countIn(cfg, "ohmail.Screener", "takeover-1@x")).toBe(1);

    // It claimed the mailbox in its own name.
    const claims = await claimsOn(cfg);
    expect(claims.some((c) => c.installId === second.world.accountId && c.kind === "local")).toBe(true);

    // …and SPENT the authorization. One becoming, not a standing right.
    const [row] = await second.db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(row!.status).toBe("connected");
    expect(row!.disabledReason).toBeNull();
    expect(row!.takeoverAuthorizedAt, "the authorization must be spent, not left set").toBeNull();
  }, 60_000);

  it("clearing the stand-down WITHOUT the authorization is not enough, and stands down again", async () => {
    // The reason the stamp exists, proved rather than asserted. This is the same scenario as the
    // test above with one thing removed — the explicit request — and the result is an install that
    // consults the lease, is told the mailbox is somebody else's to give away, and stops. An exit
    // built as "clear the flag" would ship exactly this: a button that does nothing.
    const cfg = greenmail();
    const dir = await dataDir();
    const mailboxId = await standDown(dir, cfg);
    await replaceClaims(cfg, {
      installId: CLOUD_ID, kind: "cloud", displayName: "ohmail Cloud", ageMs: 20 * 60_000,
    });
    await deliver(cfg, "takeover-2@x");

    const { db, close } = await launchDbOnly(dir);
    await db.update(mailboxes)
      .set({ status: "connected", disabledReason: null })   // no takeoverAuthorizedAt
      .where(eq(mailboxes.id, mailboxId));
    await close();

    const second = await launch(dir, cfg);
    /* Mail 0083, and the point sharpens: clearing `status` and `disabled_reason` — which is what
     * the update above is — no longer touches the record at all, because the record is the ROLE.
     * The row goes on remembering, and the install goes on being a reader, which is what the rest
     * of this test then observes. */
    expect(second.world.standDownReason,
      "a status/reason clear ended a stand-down that lives on `organizer_role`")
      .toBe("organized_elsewhere:cloud");
    expect(await startRecording(second)).toBeNull();

    expect(second.organizerState()).toMatchObject({
      organizing: false, reason: "organized_elsewhere:cloud",
    });
    // The mirror is LIVE, so "organize nothing" is a statement about decisions, not about rows.
    expect(await shapeOf(second),
      "without an explicit request this install must organize nothing")
      .toEqual({ mirrored: 1, setBy: ["peer"] });
    expect(await countIn(cfg, "ohmail.Screener", "takeover-2@x")).toBe(0);
    // …and the mail is still exactly where the server put it: a reader issues no move.
    expect(await countIn(cfg, "INBOX", "takeover-2@x")).toBe(1);
  }, 60_000);

  it("an organizer with a NEWER press keeps the mailbox, whatever was authorized here", async () => {
    /*
     * Authorization is permission to ask, not permission to win. The mailbox is the authority and
     * it is read first.
     *
     * ── WHAT RANKS, AND WHAT STOPPED RANKING ────────────────────────────────────────────────
     *
     * This test used to say "an organizer that is still ALIVE keeps the mailbox" and seed a claim
     * that was merely renewing. (2026-09-03) ended that: a press ranks ABOVE liveness,
     * so a live holder nobody pressed for is TAKEN by a press — stated as its own green test in
     * `reader-drain.test.ts` ("a live holder that nobody pressed for is TAKEN by a press"), whose
     * failure message calls the old behaviour by name: *"rule 5 is back"*.
     *
     * The reason is in the project's design notes: the remedy that liveness-wins implied — give the
     * mailbox up on the OTHER side — needs the side the person has just lost access to. Somebody
     * locked out of the machine their organizer runs on had no path to their own mailbox at all.
     *
     * So the PURPOSE of this test survives intact and the FIXTURE had to change: the holder now
     * defends with a press of its own, newer than this install's. `seedClaim` could not express
     * that until this commit — every claim it wrote was unpressed, which is `-Infinity` and loses
     * to any real instant. The scenario is a real one and it is the one worth guarding: two
     * humans, two machines, and the more recent press wins.
     */
    const cfg = greenmail();
    const dir = await dataDir();
    const mailboxId = await standDown(dir, cfg);

    // Still renewing, AND pressed for — a human asked for it on that side, just now.
    const theirPress = new Date();
    await replaceClaims(cfg, {
      installId: CLOUD_ID, kind: "cloud", displayName: "ohmail Cloud", authorizedAt: theirPress,
    });
    await deliver(cfg, "takeover-3@x");

    const { db, close } = await launchDbOnly(dir);
    // OURS IS OLDER — a minute back, against their press of a moment ago. The row still records an
    // authorization (the local ceremony does not consult the mailbox), which is exactly the point:
    // the request is granted here and REFUSED by the folder.
    expect((await authorizeOrganizerTakeover(db, { intent: "takeover",
      address: cfg.auth.user, now: new Date(theirPress.getTime() - 60_000),
    })).outcome).toBe("authorized");
    await close();

    const second = await launch(dir, cfg);
    expect(await startRecording(second)).toBeNull();

    expect(second.organizerState()).toMatchObject({
      organizing: false, reason: "organized_elsewhere:cloud", heldBy: "ohmail Cloud",
    });
    expect(await shapeOf(second),
      "a holder with a newer press must not be preempted by an older local request")
      .toEqual({ mirrored: 1, setBy: ["peer"] });
    expect(await countIn(cfg, "ohmail.Screener", "takeover-3@x")).toBe(0);
    expect(await countIn(cfg, "INBOX", "takeover-3@x")).toBe(1);
    // Only the other organizer's claim is on the server; this install wrote none.
    expect(await claimsOn(cfg)).toEqual([{ installId: CLOUD_ID, kind: "cloud" }]);
    // And the unspent authorization is VOIDED by the stand-down: becoming an organizer later is a
    // new becoming and needs a new request.
    const [row] = await second.db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    /* THE ROLE IS THE RECORD, NOT THE STATUS — mail 0083, and the third superseded ruling this
     * file was still asserting. A stand-down writes `organizer_role: 'reader'` and deliberately
     * leaves `status` alone: `disabled` means tombstone or plan-disable, full stop, and a row
     * carrying both would be saying two different things about itself. `engine.ts` states it where
     * it writes: *"This wrote `status: "disabled"` and the install stopped … A demoted install is
     * a READER. It is `connected`, it is on its own roster"*. So `connected` here is not a
     * weakening of the old `disabled` — it is the stand-down being recorded in the column that now
     * holds it, and the role is asserted beside it so the pair cannot drift apart again. */
    expect(row!.status).toBe("connected");
    expect(row!.organizerRole, "the stand-down was not recorded on the role").toBe("reader");
    expect(row!.takeoverAuthorizedAt).toBeNull();
  }, 60_000);

  /**
   * A LIVE ORGANIZER THAT NOBODY PRESSED FOR **IS** DISPLACED BY AN EXPLICIT REQUEST (0.14.1).
   *
   * This test asserted the opposite until 0.14.1, on the doctrine that "authorization is
   * permission to ask, not permission to win" — a claim still being renewed outranked a local
   * request every time. That was the `kind` term in the ranking and the rule built on it, and both
   * are deleted: `compareStrength`'s first term is now the PRESS, and a claim with no press ranks
   * lowest, which is the whole mechanism of a takeover.
   *
   * The case the old rule was wrong about is ordinary rather than exotic: somebody loses access to
   * the machine their hosted organizer runs on and wants the mailbox organized from the laptop in
   * front of them. Under the old rule there was no path — the remedy required action from the side
   * that had disappeared, which is a lockout rather than a continuation rule.
   *
   * What still holds, and is asserted below, is that nobody self-promotes by merely ARRIVING: an
   * install with no press ranks below an incumbent with none, on incumbency. Liveness is not
   * authority; an explicit press outranks both.
   *
   * The pure-function twin of this is `organizer-lease.test.ts`'s "authorized takeover of a live
   * equal-kind incumbent", whose incumbent is live (30 s heartbeat) and unstamped and which has
   * been asserting `organize` all along. The two files disagreed for one release; this is the one
   * that was stale.
   */
  it("an explicit request DOES take a live organizer that nobody pressed for", async () => {
    const cfg = greenmail();
    const dir = await dataDir();
    const mailboxId = await standDown(dir, cfg);

    // Still renewing: a fresh claim, not a stale one — and carrying no press of its own.
    await replaceClaims(cfg, { installId: CLOUD_ID, kind: "cloud", displayName: "ohmail Cloud" });
    await deliver(cfg, "takeover-3@x");

    const { db, close } = await launchDbOnly(dir);
    expect((await authorizeOrganizerTakeover(db, { intent: "takeover", address: cfg.auth.user, now: new Date() })).outcome)
      .toBe("authorized");
    await close();

    const second = await launch(dir, cfg);
    expect(await startRecording(second)).toBeNull();

    expect(second.organizerState(), "a press must outrank a live claim that carries none")
      .toMatchObject({ organizing: true });
    // The handover is recorded in the shared medium: the displaced claim is gone and exactly this
    // install's remains, which is what makes the other side's next read a stand-down.
    const claims = await claimsOn(cfg);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.installId).not.toBe(CLOUD_ID);
    // And the authorization is SPENT by the win — one press must not win an unbounded number of
    // contests. The mailbox is live now, so there is no stand-down to void it instead.
    const [row] = await second.db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(row!.takeoverAuthorizedAt).toBeNull();
  }, 60_000);

  it("the authorization is spent once, so a second quiet organizer is NOT seized from", async () => {
    // The scenario that tells a one-shot apart from a standing right, and it is a scenario a user
    // can walk into without doing anything odd: the claim message says in its own body that
    // deleting it is safe, so a tidied `ohmail/_meta` is a state to survive rather than a fault.
    //
    // After the takeover this install has no stand-down on its row, so nothing stops it consulting
    // the lease. Its own claim is gone, another machine's claim is present but quiet, and the ONLY
    // thing standing between it and that mailbox is whether the earlier authorization was spent.
    const cfg = greenmail();
    const dir = await dataDir();
    const mailboxId = await standDown(dir, cfg);
    await replaceClaims(cfg, {
      installId: CLOUD_ID, kind: "cloud", displayName: "ohmail Cloud", ageMs: 20 * 60_000,
    });

    const { db, close } = await launchDbOnly(dir);
    await authorizeOrganizerTakeover(db, { intent: "takeover", address: cfg.auth.user, now: new Date() });
    await close();

    const second = await launch(dir, cfg);
    await startRecording(second);
    expect(second.organizerState().organizing, "the authorized takeover must succeed").toBe(true);
    await second.stop();
    running.splice(running.indexOf(second), 1);

    // Another machine of the user's becomes the organizer and then goes quiet, and the meta folder
    // no longer carries this install's own claim.
    await replaceClaims(cfg, {
      installId: "another-machine", kind: "local", displayName: "The other laptop", ageMs: 20 * 60_000,
    });
    await deliver(cfg, "takeover-4@x");

    const third = await launch(dir, cfg);
    expect(await startRecording(third)).toBeNull();
    expect(third.organizerState(), "a spent authorization must not take a second mailbox").toMatchObject({
      organizing: false, reason: "organized_elsewhere:local",
    });
    expect(await shapeOf(third),
      "a spent authorization let this install organize a second mailbox")
      .toEqual({ mirrored: 1, setBy: ["peer"] });
    expect(await countIn(cfg, "ohmail.Screener", "takeover-4@x")).toBe(0);
    expect(await countIn(cfg, "INBOX", "takeover-4@x")).toBe(1);
    expect(third.world.mailboxId).toBe(mailboxId);
  }, 60_000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  THE ONLY TEST THAT PROVES A REAL SERVER ANSWERS THE WAY THE DOUBLE DOES
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * A live claim, then a ceiling's worth of ordinary messages appended on top of it, against
   * GreenMail. The bounded read cannot cover the folder, so the election asks the server for every
   * message carrying `X-Ohmail-Lease` — and that is the step this case exists for: everywhere else
   * the header search is answered by a fake this lane wrote, and a fake that matched too generously
   * would hide a real miss on every one of them. Four defects on this branch were the double being
   * kinder than a server; the fifth would be this one.
   *
   * So the assertion is made twice over: the install must STAND DOWN (it found the buried claim),
   * and an INDEPENDENT client must see exactly one message carrying the header afterwards — the
   * flood must not match, and this install must not have appended a second claim.
   */
  it("a claim buried under a flood is found on a REAL server, and this install stands down", async () => {
    const cfg = greenmail();
    const dir = await dataDir();

    // A live claim from somebody else, then more messages than one read may take.
    await seedClaim(cfg, { installId: CLOUD_ID, kind: "cloud", displayName: "ohmail Cloud" });
    const c = await client(cfg);
    try {
      for (let i = 0; i < 501; i++) {
        await c.append(META_PATH, [
          `Message-ID: <flood-${i}@x>`, "From: noise@example.com", `To: ${cfg.auth.user}`,
          `Subject: filler ${i}`, "", "not a claim, not a profile, not an ack.", "",
        ].join("\r\n"), ["\\Seen"]);
      }
    } finally {
      await c.logout();
    }

    const install = await launch(dir, cfg);
    expect(await startRecording(install)).toBeNull();

    expect(install.organizerState(),
      "a live claim buried under a flood was read as no claim, on a real server")
      .toMatchObject({ organizing: false, reason: "organized_elsewhere:cloud" });

    /* AND THE SERVER'S OWN ANSWER, read by a client this code does not own. Exactly one message
     * carries the header: the flood does not match it, and standing down appended nothing. */
    const probe = await client(cfg);
    try {
      const lock = await probe.getMailboxLock(META_PATH);
      try {
        const found = await probe.search({ header: { "X-Ohmail-Lease": true } }, { uid: true });
        expect(Array.isArray(found)).toBe(true);
        expect(found as number[],
          "the header search matched something other than exactly the one claim").toHaveLength(1);
      } finally {
        lock.release();
      }
    } finally {
      await probe.logout();
    }
  }, 120_000);

  it("refuses a mailbox that was REMOVED rather than paused, and writes nothing", async () => {
    // Disabled with no reason is a removal. Re-adding a removed mailbox is a different action with
    // different consequences, and quietly converting one into the other would resurrect a mailbox
    // somebody deliberately took off this machine.
    const cfg = greenmail();
    const dir = await dataDir();
    const first = await launch(dir, cfg);
    await startRecording(first);
    const mailboxId = first.world.mailboxId;
    await first.stop();
    running.splice(running.indexOf(first), 1);

    const { db, close } = await launchDbOnly(dir);
    await db.update(mailboxes)
      .set({ status: "disabled", disabledReason: null })
      .where(eq(mailboxes.id, mailboxId));
    const result = await authorizeOrganizerTakeover(db, { intent: "takeover", address: cfg.auth.user, now: new Date() });
    expect(result.outcome).toBe("removed");
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(row!.status, "a removal must stay removed").toBe("disabled");
    expect(row!.takeoverAuthorizedAt).toBeNull();
    await close();
  }, 60_000);

  it("is a no-op on a mailbox this install already organizes", async () => {
    const cfg = greenmail();
    const dir = await dataDir();
    const first = await launch(dir, cfg);
    await startRecording(first);
    expect(first.organizerState().organizing).toBe(true);
    await first.stop();
    running.splice(running.indexOf(first), 1);

    const { db, close } = await launchDbOnly(dir);
    const result = await authorizeOrganizerTakeover(db, { intent: "takeover", address: cfg.auth.user, now: new Date() });
    expect(result.outcome).toBe("already_organizing");
    const [row] = await db.select().from(mailboxes);
    expect(row!.takeoverAuthorizedAt,
      "a no-op must not leave an authorization lying around to be spent later").toBeNull();
    await close();
  }, 60_000);
});

/**
 * TWO INSTALLS, ONE MAILBOX — the failure the whole mechanism exists to prevent.
 *
 * Two engines organizing one mailbox means two independent decisions about where each new message
 * belongs, issued as competing moves against one server. It cannot be repaired afterwards: the
 * mail has already been filed twice.
 *
 * The lease is a lease and not a lock — IMAP has no compare-and-swap, so two installs can write a
 * claim in the same instant and both succeed. What it guarantees is that they cannot both KEEP
 * organizing: each re-reads the folder before every pass, both compute the same winner from the
 * same contents, and the loser stops.
 */
describe("two installs contending for one mailbox", () => {
  const dirs: string[] = [];
  const running: Sidecar[] = [];

  afterEach(async () => {
    for (const s of running.splice(0)) await s.stop().catch(() => undefined);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function dataDir(): Promise<string> {
    const d = await freshDataDir("ohmail-contend-");
    dirs.push(d);
    return d;
  }

  async function launch(cfg: Cfg, machineName: string): Promise<Sidecar> {
    const s = await createSidecar({
      dataDir: await dataDir(), imap: cfg, machineName,
      pollIntervalMs: 60_000, leaseStaleAfterMs: 60_000,
    });
    await grantOrganizeConsent(s);
    running.push(s);
    try {
      await s.start();
    } catch {
      /* a stand-down closes the login; the assertions below read the decision, not the socket */
    }
    return s;
  }

  it("lets exactly one organize, and the loser ingests nothing", async () => {
    const cfg = greenmail();
    await deliver(cfg, "contend-1@x");

    const a = await launch(cfg, "First machine");
    const b = await launch(cfg, "Second machine");

    const states = [a.organizerState(), b.organizerState()];
    expect(states.filter((s) => s.organizing), "exactly one organizer per mailbox").toHaveLength(1);

    const loser = a.organizerState().organizing ? b : a;
    const winner = loser === a ? b : a;
    expect(loser.organizerState().reason).toBe("organized_elsewhere:local");
    expect(loser.organizerState().heldBy).toBe("First machine");

    // ONE decision about one message, checked on both mirrors and then on the server itself.
    //
    // The loser MIRRORS the message — that is the reader design and not a leak — so the row count
    // is the same on both sides and says nothing on its own. What separates them is who DECIDED:
    // an install that lost the mailbox but got one organizing cycle in first is the failure this
    // whole file exists to catch, and it is indistinguishable from a reader on `mirrored` alone.
    expect(await shapeOf(winner)).toEqual({ mirrored: 1, setBy: ["us"] });
    expect(await shapeOf(loser),
      "the loser ran the ORGANIZING pipeline — two installs decided about one mailbox")
      .toEqual({ mirrored: 1, setBy: ["peer"] });
    expect(await countIn(cfg, "ohmail.Screener", "contend-1@x")).toBe(1);
    expect(await countIn(cfg, "INBOX", "contend-1@x")).toBe(0);

    // One claim on the server, the winner's. The loser released its own when it stood down, so
    // the winner's next pass sees a clean folder instead of waiting out a staleness window.
    const claims = await claimsOn(cfg);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toEqual({ installId: winner.world.accountId, kind: "local" });
  }, 90_000);

  it("POSITIVE CONTROL: the same two installs on two mailboxes both organize", async () => {
    // Without this, the result above cannot be told apart from a harness that only ever manages to
    // bring one engine up. Two installs, two mailboxes, nothing contended — both must work.
    const one = greenmail();
    const two = greenmail();
    await deliver(one, "control-1@x");
    await deliver(two, "control-2@x");

    const a = await launch(one, "First machine");
    const b = await launch(two, "Second machine");

    // Both organize, so both carry the standing claim — the `claimed` note on the stand-down case
    // above. Stating it on BOTH is what keeps this control a control: a pair where one organizes
    // without a claim of its own is the reading the background-arm change closed.
    expect(a.organizerState()).toEqual({ organizing: true, reason: null, heldBy: null,
      releaseRequestedAt: null, unreadableSince: null, unreadableReason: null, claimed: true, releaseRefusal: null, holderState: null });
    expect(b.organizerState()).toEqual({ organizing: true, reason: null, heldBy: null,
      releaseRequestedAt: null, unreadableSince: null, unreadableReason: null, claimed: true, releaseRefusal: null, holderState: null });
    expect(await a.db.select().from(messages)).toHaveLength(1);
    expect(await b.db.select().from(messages)).toHaveLength(1);
    expect(await countIn(one, "ohmail.Screener", "control-1@x")).toBe(1);
    expect(await countIn(two, "ohmail.Screener", "control-2@x")).toBe(1);
  }, 90_000);
});

/**
 * The local database, opened WITHOUT an engine.
 *
 * The engine holds an exclusive lock on the data directory while it runs — two processes on one
 * local database corrupt it — so the request has to be made with the engine stopped. That is a
 * real constraint on the action and not a test convenience, which is why these tests take the same
 * route a user does rather than reaching into a running engine.
 */
async function launchDbOnly(dir: string): Promise<{ db: LocalDb; close: () => Promise<void> }> {
  const opened = await openLocalDb(dir);
  return { db: opened.db, close: () => opened.close() };
}
