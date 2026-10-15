import { rmSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeBatch, ImapConfig, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { StaticKeyProvider } from "@trafficflow/core";
import { MailboxService } from "@trafficflow/services";
import { createSidecar, type AdapterDialContext, type Sidecar } from "../src/engine.js";
import { createSidecarLogger, diagnosticFor } from "../src/log.js";
import { freshDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE SIGN-OUT'S DURABLE STAMP — a password cannot be sealed back over a sign-out
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `signout-fence.test.ts` holds the sign-out's EPOCH: the local door's three credential writers
 * begin under it, and one overtaken by a sign-out discards what it wrote. The epoch lives in
 * memory, in one process, and it is read only by writers that were built to read it — so it says
 * nothing about the shared `PATCH /mailboxes/:id`, which is on the relay allow-list a paired phone
 * sends through and runs `MailboxService.update`.
 *
 * ── MEASURED AT THE BASE, BEFORE THE STAMP EXISTED ────────────────────────────────────────
 *
 * The sequence below was driven against the unfenced service by this file's own fixture: the
 * sign-out answered `200 {cleared:true}` and proved the store empty, and the write that had
 * started before it then committed — `writeOutcome=ok sealedAfterWrite=1`. The person signed out,
 * was told so, and this install held a sealed mailbox password again. With the stamp the same
 * sequence reads `writeOutcome=signed_out sealedAfterWrite=0`.
 *
 * ── WHAT MAKES EACH CASE NON-VACUOUS ──────────────────────────────────────────────────────
 *
 * The probe is the clock: the write parks inside it with a gate this file opens, so the
 * interleaving is exact rather than timed. `inProbe` is awaited before the sign-out, so no case
 * can pass because the write had not started; the positive control writes with nothing in flight,
 * so no case can pass because the fence refuses everything.
 *
 * Mutation-checked, each watched red and restored by `cmp`:
 *  · the `fenceSignedOutMailbox` call in `upsertCredOn` removed → case 1 (a password sealed over
 *    a sign-out that reported success);
 *  · the `signedOutAt` write in the purge's transaction (`purgeCredential`, which the sign-out's
 *    `forgetStoredLogin` calls) removed → cases 1 and 3;
 *  · the stamp read that `update` takes before it dials removed → case 1.
 */

const HOST = "imap.example.test";
const USER = "owner@example.test";
const SEED_PASS = "the-seed-password";
const NEW_PASS = "the-typed-password";

const EMPTY_BATCH: ChangeBatch = {
  creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
};

/** One key ring for every launch here, so a second engine can open the first one's row. */
const KEKS = { 1: Buffer.alloc(32, 7) };

/**
 * A dial double that REFUSES an unknown password, so a green is a dial that happened rather than
 * one that was skipped. It parks nothing: every case here drives the credential write through the
 * service's own injected probe, which is where the window is.
 */
function dials(): {
  opened: string[];
  factory: (cfg: ImapConfig, ctx: AdapterDialContext) => MailboxAdapter;
} {
  const opened: string[] = [];
  const factory = (cfg: ImapConfig, _ctx: AdapterDialContext): MailboxAdapter => ({
    leaseIo: () => ({
      async ensureMetaFolder(): Promise<void> {},
      async listClaims(): Promise<never[]> { return []; },
      async appendClaim(): Promise<void> {},
      async removeClaims(): Promise<void> {},
      async findOwnRecords(): Promise<never[]> { return []; },
      /* A server that names its folder generation, as every real one this install dials does. */
      uidValidity(): number { return 4_100; },
    }),
    leasePeekIo: () => ({ async listClaims(): Promise<never[]> { return []; } }),
    async connect(): Promise<void> {
      const auth = cfg.auth as { pass?: string } | undefined;
      const pass = auth?.pass ?? "";
      if (pass !== SEED_PASS && pass !== NEW_PASS) {
        const err = new Error("authentication failed") as Error & { authenticationFailed?: boolean };
        err.authenticationFailed = true;
        throw err;
      }
      opened.push(pass);
    },
    async close(): Promise<void> {},
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
  return { opened, factory };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot(
  dataDir: string, d: ReturnType<typeof dials>, opts: { pass?: string } = {},
): Promise<Sidecar> {
  const logger = createSidecarLogger({ sink: () => {} });
  const s = await createSidecar({
    dataDir,
    imap: { host: HOST, port: 993, secure: true, auth: { user: USER, pass: opts.pass } },
    address: USER,
    machineName: "this machine",
    pollIntervalMs: 60 * 60 * 1000,
    vitalsIntervalMs: 60 * 60 * 1000,
    leaseStaleAfterMs: 60_000,
    keks: KEKS,
    adapterFactory: d.factory,
    log: diagnosticFor(logger),
    logger,
  } as never);
  cleanups.push(async () => { await s.stop().catch(() => undefined); });
  return s;
}

/** How many sealed passwords this install holds, over every transport. */
async function sealedCount(s: Sidecar): Promise<number> {
  const r = await s.db.execute(sql`select count(*)::int as n from mailbox_credentials`);
  return (r.rows[0] as { n: number }).n;
}

/** The stamp itself, as the store holds it — what a restart has to find again. */
async function stampOf(s: Sidecar): Promise<string | null> {
  const r = await s.db.execute(sql`select signed_out_at from mailboxes limit 1`);
  const v = (r.rows[0] as { signed_out_at: Date | string | null }).signed_out_at;
  return v === null ? null : new Date(v).toISOString();
}

const auth = (s: Sidecar): Record<string, string> => ({
  authorization: `Bearer ${s.sessionToken}`,
  "content-type": "application/json",
});

/** Sign out of the local door — the shell's own call. */
const signOut = (s: Sidecar): Promise<Response> =>
  s.handle(new Request("http://local/local/stored-login", {
    method: "DELETE", headers: auth(s),
  }));

/**
 * A credential write driven the way the SHARED route drives it: `MailboxService.update` over this
 * install's own store, with the route's injection seam — the probe — parked. It is the writer a
 * paired phone reaches through `PATCH /mailboxes/:id`, and the one the engine's epoch cannot see.
 */
function sharedWrite(s: Sidecar): {
  inProbe: Promise<void>;
  release: () => void;
  done: Promise<{ outcome: string }>;
} {
  const svc = new MailboxService({ keyProvider: new StaticKeyProvider(KEKS) });
  let entered = (): void => {};
  const inProbe = new Promise<void>((r) => { entered = r; });
  let open = (): void => {};
  const gate = new Promise<void>((r) => { open = r; });
  const probe = async (): Promise<{ verdict: "ok"; proven: { port: number; secure: boolean } }> => {
    entered();
    await gate;
    return { verdict: "ok", proven: { port: 993, secure: true } };
  };
  const done = svc.update(
    {
      db: s.db as never, accountId: s.world.accountId, userId: s.world.userId,
      now: () => new Date(), requestId: "", sessionId: null,
    } as never,
    s.world.mailboxId!,
    { imap: { host: HOST, port: 993, secure: true, user: USER, pass: NEW_PASS } } as never,
    { probe: probe as never },
  ).then(
    () => ({ outcome: "stored" }),
    (err: unknown) => ({ outcome: (err as { code?: string }).code ?? (err as Error).message }),
  );
  return { inProbe, release: () => open(), done };
}

/**
 * The service's one door into `mailbox_credentials`, called with an explicit origin — a credential
 * write that began at a stated point relative to the sign-out stamp. Private, and reached through
 * a cast deliberately: the origin is the argument no public route can carry across a restart, and
 * this is the only way to state "a writer that began under the previous process".
 */
type SealDoor = {
  upsertCredOn(
    tx: unknown, ctx: unknown, kp: unknown, id: string, transport: string, pass: string,
    meta: Record<string, unknown>, origin: unknown,
  ): Promise<void>;
};

function sealWithOrigin(s: Sidecar, origin: unknown): Promise<string> {
  const kp = new StaticKeyProvider(KEKS);
  const svc = new MailboxService({ keyProvider: kp }) as unknown as SealDoor;
  const ctx = {
    db: s.db as never, accountId: s.world.accountId, userId: s.world.userId,
    now: () => new Date(), requestId: "", sessionId: null,
  };
  return svc.upsertCredOn(
    s.db, ctx, kp, s.world.mailboxId!, "imap", NEW_PASS, { host: HOST, user: USER }, origin,
  ).then(() => "stored", (err: unknown) => (err as { code?: string }).code ?? "threw");
}

describe("a sign-out that reported success holds against a write already in flight", () => {
  it("the write that started before the clear is REFUSED BY NAME, and stores nothing", async () => {
    const dir = await freshDataDir("ohmail-signed-out-stamp-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const d = dials();
    const s = await boot(dir, d, { pass: SEED_PASS });
    await s.start();
    expect(await sealedCount(s), "the boot did not seal the seed's password").toBeGreaterThan(0);
    expect(await stampOf(s), "a fresh install claims a sign-out it never had").toBeNull();

    // The password field on the phone: a write parked inside its probe, before it commits.
    const write = sharedWrite(s);
    await write.inProbe;

    // …and the person signs out on this computer while it is out there.
    const out = await signOut(s);
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ cleared: true });
    expect(await sealedCount(s), "the sign-out did not empty the store").toBe(0);
    expect(await stampOf(s), "the clear left no stamp for a later writer to read").not.toBeNull();

    write.release();
    expect(
      (await write.done).outcome,
      "the write was accepted over the sign-out that overtook it",
    ).toBe("signed_out");
    expect(
      await sealedCount(s),
      "a sign-out reported success and this install holds a sealed mailbox password again",
    ).toBe(0);
  });

  it("THE STAMP IS DURABLE — a fresh process refuses a write that began under the old one", async () => {
    /* The epoch is a counter in one process: every launch starts at zero, so a writer whose start
     * predates a sign-out looks brand new to the next launch. The stamp is on disk, so the same
     * writer is refused by a process that never saw the sign-out happen. */
    const dir = await freshDataDir("ohmail-signed-out-durable-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const d = dials();
    const s = await boot(dir, d, { pass: SEED_PASS });
    await s.start();
    expect((await signOut(s)).status).toBe(200);
    const stamped = await stampOf(s);
    expect(stamped, "the clear wrote no stamp").not.toBeNull();
    await s.stop();

    // The same data directory, the same key ring — the app opened again tomorrow.
    const again = dials();
    const s2 = await boot(dir, again, {});
    await s2.start();
    expect(await stampOf(s2), "the stamp did not survive the restart").toBe(stamped);

    /* A write carrying the origin a writer that began BEFORE the sign-out holds — the stamp as
       it stood then, which was nothing. Nothing in this process knows a sign-out happened: its
       epoch has never been bumped, and the shared service never reads one. `upsertCredOn` is the
       service's one door into `mailbox_credentials` and takes the origin as an argument, which is
       what lets a case state the one thing no public door can hold across a restart. */
    const outcome = await sealWithOrigin(s2, { row: "already-there", signedOutAt: null });

    expect(outcome, "a process that never saw the sign-out sealed the password anyway")
      .toBe("signed_out");
    expect(await sealedCount(s2), "the refused write left a row behind").toBe(0);
  });

  it("POSITIVE CONTROL — a write that STARTS after the sign-out stores and dials", async () => {
    // Without it every case above is satisfied by a fence that refuses every credential for the
    // life of the install, which is somebody who can never sign back in.
    const dir = await freshDataDir("ohmail-signed-out-back-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const d = dials();
    const s = await boot(dir, d, { pass: SEED_PASS });
    await s.start();
    expect((await signOut(s)).status).toBe(200);
    expect(await sealedCount(s)).toBe(0);

    // Nothing is in flight now, so this is the ordinary path: type the password again.
    const write = sharedWrite(s);
    await write.inProbe;
    write.release();
    expect((await write.done).outcome, "the fence refused a sign-in that raced nothing")
      .toBe("stored");
    expect(await sealedCount(s), "the password was not stored").toBeGreaterThan(0);

    await s.stop();
    const again = dials();
    const s2 = await boot(dir, again, {});
    await s2.start();
    expect(again.opened, "the re-entered password did not dial on the next launch")
      .toEqual([NEW_PASS]);
    expect(await s2.credentialState()).toBe("ready");
  });
});
