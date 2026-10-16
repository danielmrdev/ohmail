import { rmSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeBatch, ImapConfig, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { createSidecar, type AdapterDialContext, type Sidecar } from "../src/engine.js";
import { createSidecarLogger, diagnosticFor } from "../src/log.js";
import { freshDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  ONE SIGN-OUT FENCE — a sign-out that reports success has cleared the credential
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `DELETE /local/stored-login` deletes the sealed mailbox password and reads it back inside its
 * own transaction, so it cannot report success over a delete that removed nothing
 * (`stored-login-clear.test.ts` pins that order). What the read-back cannot see is a credential
 * writer that is ALREADY IN FLIGHT: `PATCH /local/mailboxes/:id` spends seconds inside a probe —
 * it dials the server with the password somebody just typed — and commits afterwards. Sign out
 * while that probe is out and the clear runs, proves the row gone, answers 200, and the probe
 * then returns and seals the password again.
 *
 * Two facts follow, and they are the two rows this file closes:
 *
 *  1. the store holds a mailbox password after a sign-out that reported success;
 *  2. the sidecar DIALS with it — not in some millisecond window before the shell stops the
 *     process, but on every launch after, because the row is durable. The person signed out and
 *     the app is still logged in to their mailbox tomorrow.
 *
 * ── THE FENCE ──────────────────────────────────────────────────────────────────────────────
 *
 * A sign-out is one act with a generation: `signOut()` bumps it FIRST, then waits (bounded) for
 * every credential writer that started before the bump, then discards the stores, then answers.
 * A writer that started earlier finds its generation stale and refuses — and, because its write
 * may already have committed, discards what it wrote before it settles. A writer that starts
 * after the bump never had a sign-out to race. A dial reads the same generation: a runtime that
 * resolved its password before the bump will not open a login on it.
 *
 * ── MEASURED BEFORE THE FENCE EXISTED ─────────────────────────────────────────────────────
 *
 * Both sequences were driven against the unfenced engine by this file's own fixture, and both
 * read exactly as the rows describe: the sign-out answered `200 {cleared:true}`, proved the row
 * gone, and after the probe returned the store held ONE sealed password (`expected 1 to be +0`);
 * a second launch over the same data directory then opened a login on it (`expected
 * [ 'the-typed-password' ] to deeply equal []`). The positive control was green throughout, so
 * neither reading was a fixture that refused everything.
 *
 * ── WHAT EACH CASE PROVES AND WHAT WOULD MAKE IT VACUOUS ──────────────────────────────────
 *
 * The probe is the clock. Every case below parks the PATCH inside `connect()` with a gate the
 * test opens, so the interleaving is exact rather than timed — `enteredProbe` is awaited before
 * the sign-out, so a case can never pass because the PATCH had not started yet, and the release
 * waits for the fence's own receipt, so it can never pass because the sign-out had not begun.
 *
 * Mutation-checked, each watched red and restored:
 *  · the seal route's `sealWrite.stale()` arm removed → sequence 1 (a password sealed over a
 *    sign-out that reported success);
 *  · `dialAndGate`'s `signedOutSinceDial()` refusal removed → sequence 2 (the next launch dials);
 *  · the `fenced.unsettled` refusal removed → the third case (a clean 200 over a store this door
 *    never watched settle).
 */

const HOST = "imap.example.test";
const USER = "owner@example.test";
const SEED_PASS = "the-seed-password";
const NEW_PASS = "the-typed-password";

const EMPTY_BATCH: ChangeBatch = {
  creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
};

interface Dials {
  /** Every `connect()` that opened, with the password it opened on. */
  opened: string[];
  /** `close()` calls, over every connection this factory built. */
  closed: number;
  /** Resolves the first time the PATCH's probe is inside `connect()`. */
  enteredProbe: Promise<void>;
  /** Lets that probe finish. */
  releaseProbe: () => void;
  /** Kill the live connection the way a server does — what makes the engine re-dial. */
  killConnection: () => void;
  factory: (cfg: ImapConfig, ctx: AdapterDialContext) => MailboxAdapter;
}

/**
 * The dial, as a double, with the PATCH's probe parked. It REFUSES an unknown password, so a
 * green here is a dial that happened rather than one that was skipped — the property that makes
 * "the sidecar still dials with its copy" measurable at all.
 */
function dials(): Dials {
  const opened: string[] = [];
  let closed = 0;
  let entered = (): void => {};
  const enteredProbe = new Promise<void>((r) => { entered = r; });
  let release = (): void => {};
  const gate = new Promise<void>((r) => { release = r; });

  /* THE LAST DIAL'S DEATH CHANNEL. `AdapterDialContext.onConnectionError` is how the real
     adapter reports a socket the server closed, and it is the only way a test can make the poll
     timer re-dial — which is where a runtime that still holds the plaintext in memory would
     otherwise open a second login on a password somebody signed out of. */
  let die: (() => void) | null = null;

  const factory = (cfg: ImapConfig, ctx: AdapterDialContext): MailboxAdapter => ({
    leaseIo: () => ({
      async ensureMetaFolder(): Promise<void> {},
      async listClaims(): Promise<never[]> { return []; },
      async appendClaim(): Promise<void> {},
      async removeClaims(): Promise<void> {},
      async findOwnRecords(): Promise<never[]> { return []; },
      /* A SERVER THAT NAMES ITS FOLDER GENERATION, which every real one this install dials does.
         A double without it drives the takeover's confirm through the unnamed-generation arm —
         a state no install reaches — and these cases are about a signed-out password, not that. */
      uidValidity(): number | bigint | null { return 4_100; },
    }),
    leasePeekIo: () => ({ async listClaims(): Promise<never[]> { return []; } }),
    async connect(): Promise<void> {
      /* `ImapAuth` is a union — a password auth or an OAuth one — so the password is read by
         narrowing rather than by an optional property the OAuth arm does not have. */
      const auth = cfg.auth as { pass?: string } | undefined;
      const pass = auth?.pass ?? "";
      /* THE PARK, and it is keyed on the PASSWORD rather than on a dial counter: the boot's own
         dial and the PATCH's probe both reach this function, and only the second is the writer
         whose commit the sign-out must overtake. */
      if (pass === NEW_PASS) {
        entered();
        await gate;
      }
      if (pass !== SEED_PASS && pass !== NEW_PASS) {
        const err = new Error("authentication failed") as Error & { authenticationFailed?: boolean };
        err.authenticationFailed = true;
        throw err;
      }
      opened.push(pass);
      die = () => ctx.onConnectionError(new Error("the server closed the connection"));
    },
    async close(): Promise<void> { closed += 1; },
    async listFolders(): Promise<string[]> { return ["INBOX", "Sent", "Drafts", "Trash"]; },
    async capabilities() {
      return { move: true, uidplus: true, condstore: true, qresync: false,
        idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { ...EMPTY_BATCH }; },
    async move() { return { folder: "INBOX", ref: "1:1" }; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
  } as unknown as MailboxAdapter);

  return {
    opened, get closed() { return closed; },
    enteredProbe, releaseProbe: () => release(), killConnection: () => die?.(), factory,
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** One key ring for every launch in a case, so a second engine can open the first one's row. */
const KEKS = { 1: Buffer.alloc(32, 7) };

/** The engine's own lines, so a case can wait on the sign-out's receipt rather than on a delay. */
interface Booted { sidecar: Sidecar; seen: (event: string) => boolean }
const booted = new WeakMap<Sidecar, () => string[]>();

/** Resolve once the engine has written `event`. The fence's receipt is the only one used here. */
async function until(s: Sidecar, event: string): Promise<void> {
  const events = booted.get(s)!;
  for (let i = 0; i < 2_000; i += 1) {
    if (events().includes(event)) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`the engine never wrote ${event}`);
}

async function boot(
  dataDir: string, d: Dials, opts: { pass?: string; pollIntervalMs?: number } = {},
): Promise<Sidecar> {
  const events: string[] = [];
  const logger = createSidecarLogger({
    sink: (line) => { events.push((JSON.parse(line) as { event: string }).event); },
  });
  const s = await createSidecar({
    dataDir,
    imap: {
      host: HOST, port: 993, secure: true,
      auth: { user: USER, pass: opts.pass },
    },
    address: USER,
    machineName: "this machine",
    pollIntervalMs: opts.pollIntervalMs ?? 60 * 60 * 1000,
    vitalsIntervalMs: 60 * 60 * 1000,
    leaseStaleAfterMs: 60_000,
    keks: KEKS,
    adapterFactory: d.factory,
    log: diagnosticFor(logger),
    logger,
  } as never);
  booted.set(s, () => events);
  cleanups.push(async () => { await s.stop().catch(() => undefined); });
  return s;
}

/** How many sealed passwords this install holds, over every transport. */
async function sealedCount(s: Sidecar): Promise<number> {
  const r = await s.db.execute(sql`select count(*)::int as n from mailbox_credentials`);
  return (r.rows[0] as { n: number }).n;
}

const auth = (s: Sidecar): Record<string, string> => ({
  authorization: `Bearer ${s.sessionToken}`,
  "content-type": "application/json",
});

/** Enter a password the way the window does — the local door's seal route. */
const seal = (s: Sidecar, pass: string): Promise<Response> =>
  s.handle(new Request(`http://local/local/mailboxes/${s.world.mailboxId}`, {
    method: "PATCH",
    headers: auth(s),
    body: JSON.stringify({ imap: { host: HOST, port: 993, secure: true, user: USER, pass } }),
  }));

/** Sign out of the local door — the shell's own call. */
const signOut = (s: Sidecar): Promise<Response> =>
  s.handle(new Request("http://local/local/stored-login", {
    method: "DELETE", headers: auth(s),
  }));

describe("signing out while a credential write is in flight", () => {
  it("SEQUENCE 1 — the write that was already out does not seal the password again", async () => {
    const dir = await freshDataDir("ohmail-signout-fence-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const d = dials();
    const s = await boot(dir, d, { pass: SEED_PASS });
    await s.start();
    expect(await sealedCount(s), "the boot did not seal the seed's password").toBeGreaterThan(0);

    // The window's password field: a PATCH that parks inside the probe's `connect()`.
    const patch = seal(s, NEW_PASS);
    await d.enteredProbe;

    /* …and the person signs out while it is out there. NOT awaited yet: the fence bumps the
       epoch and then waits for this write, so releasing the probe is what lets the sign-out
       finish — which is the interleaving the product has and the one a `await` here would hide. */
    const out = signOut(s);
    await until(s, "stored_login_fence_raised");
    d.releaseProbe();

    const res = await out;
    expect(res.status, "the sign-out was refused").toBe(200);
    expect(await res.json()).toEqual({ cleared: true });

    const sealed = await patch;
    expect(
      sealed.status,
      "the seal was accepted over the sign-out that overtook it",
    ).toBe(409);
    expect(
      await sealedCount(s),
      "a sign-out reported success and this install holds a sealed mailbox password again",
    ).toBe(0);
  });

  it("SEQUENCE 2 — and no launch after it dials the mailbox", async () => {
    const dir = await freshDataDir("ohmail-signout-dial-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const d = dials();
    const s = await boot(dir, d, { pass: SEED_PASS });
    await s.start();
    const dialsAtSignOut = d.opened.length;
    expect(dialsAtSignOut, "the seed never dialled, so this case measures nothing")
      .toBeGreaterThan(0);

    const patch = seal(s, NEW_PASS);
    await d.enteredProbe;
    const out = signOut(s);
    await until(s, "stored_login_fence_raised");
    d.releaseProbe();
    expect((await out).status).toBe(200);
    await patch;

    /* THE LIVE LOGIN FIRST. The row being gone says nothing about the socket the password
       already bought, and this engine outlives the clear on every door that does not stop it. */
    expect(d.closed, "the login the forgotten password bought was left open").toBeGreaterThan(0);
    await s.stop();

    // The same data directory, the same key ring — the app opened again tomorrow. Its gate is
    // open from the start: this launch races nothing, so a dial here must not be parked.
    const again = dials();
    again.releaseProbe();
    const s2 = await boot(dir, again, {});
    await s2.start();

    expect(
      again.opened,
      "this install signed out and the next launch logged in to the mailbox anyway",
    ).toEqual([]);
    expect(
      await s2.credentialState(),
      "a sign-out left a credential this install reports as ready to dial",
    ).not.toBe("ready");
  });

  it("A WRITE IT COULD NOT WATCH SETTLE IS REPORTED, not answered over", async () => {
    /* The fence waits, bounded — a probe against an unreachable server can hold the socket open
       for far longer than anyone should watch a Sign out button. Past the bound every store is
       still discarded, and the door then says what it could not promise instead of returning the
       200 that made the desktop delete `config.json` and report a clean sign-out. */
    const dir = await freshDataDir("ohmail-signout-unsettled-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const d = dials();
    const s = await boot(dir, d, { pass: SEED_PASS });
    await s.start();

    const patch = seal(s, NEW_PASS);
    await d.enteredProbe;

    const res = await signOut(s);
    expect(res.status, "the sign-out promised a store it never watched settle").toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "stored_login_not_fenced" } });
    expect(await sealedCount(s), "the stores were not discarded anyway").toBe(0);

    // …and the write, when it finally lands, still discards itself: the retry the message asks
    // for finds nothing, which is what makes the sentence true rather than merely cautious.
    d.releaseProbe();
    expect((await patch).status).toBe(409);
    expect(await sealedCount(s)).toBe(0);
    expect((await signOut(s)).status, "signing out again did not succeed").toBe(200);
  });

  it("A RE-DIAL AFTER THE SIGN-OUT DOES NOT OPEN A LOGIN ON THE COPY IN MEMORY", async () => {
    /* Deleting the row is not the same fact as "nothing can dial with it". The password this
     * attachment resolved lives in this process for the life of the attachment, and the poll
     * timer re-dials whenever the connection dies — so without a fence on the DIAL, a server-side
     * death moments after a sign-out puts a fresh authenticated login on the user's mailbox using
     * the password they just removed, and the desktop's own stop is the only thing that ever
     * ended it. Reachable here because the sign-out closes the live login itself, which is what
     * makes a death the ordinary next event rather than a contrived one.
     */
    const dir = await freshDataDir("ohmail-signout-redial-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const d = dials();
    const s = await boot(dir, d, { pass: SEED_PASS, pollIntervalMs: 25 });
    await s.start();
    expect(d.opened, "the launch never dialled, so this case measures nothing").toEqual([SEED_PASS]);

    expect((await signOut(s)).status).toBe(200);
    // The server drops the socket, as it does on every lid close and Wi-Fi change.
    d.killConnection();
    // Several poll intervals: the re-dial rides the timer, so this is the window it would land in.
    await new Promise((r) => setTimeout(r, 400));

    expect(
      d.opened,
      "this install signed out and then opened a fresh login on the password it had removed",
    ).toEqual([SEED_PASS]);
  });

  it("POSITIVE CONTROL — an ordinary sign-in after a sign-out stores and dials", async () => {
    // Without it every case above is satisfied by a fence that refuses every credential for the
    // life of the process, which is an install nobody can sign back in to.
    const dir = await freshDataDir("ohmail-signout-back-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const d = dials();
    const s = await boot(dir, d, { pass: SEED_PASS });
    await s.start();
    expect((await signOut(s)).status).toBe(200);
    expect(await sealedCount(s)).toBe(0);

    // Nothing is in flight now, so this is the ordinary path: type the password again.
    d.releaseProbe();
    const res = await seal(s, NEW_PASS);
    expect(res.status, "the fence refused a sign-in that raced nothing").toBe(200);
    expect(await sealedCount(s), "the password was not stored").toBeGreaterThan(0);

    await s.stop();
    const again = dials();
    again.releaseProbe();
    const s2 = await boot(dir, again, {});
    await s2.start();
    expect(again.opened, "the re-entered password did not dial on the next launch")
      .toEqual([NEW_PASS]);
    expect(await s2.credentialState()).toBe("ready");
  });
});
