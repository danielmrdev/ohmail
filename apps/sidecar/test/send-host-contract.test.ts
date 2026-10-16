import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { mailboxCredentials } from "@trafficflow/db";
import { isOAuthAuth, type ImapConfig } from "@trafficflow/core/adapters/imap";
import { connectOverStdio, type StdioClient } from "../src/client.js";
import { createSidecar, type Sidecar, type SidecarConfig } from "../src/engine.js";
import { serveOverStdio, type StdioHost } from "../src/host.js";
import { credentialIsForeignSmtp, sealedHost, sealedSmtpHost } from "../src/credential-host.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";

/**
 * ═══ THE SEND CONTRACT — THE OUTGOING HALF OF THE BOOT CONTRACT ════════════════════════════════
 *
 * A mailbox has two servers. The boot contract compares the INCOMING one, and a change that moves
 * only the OUTGOING one leaves that comparison satisfied: the incoming host still agrees, the
 * launch is `ready`, and the send transport is then built from whatever submission coordinates the
 * process booted with. The password proved for one pair of servers is offered to a submission
 * server nobody named.
 *
 * ── WHY THIS COULD NOT SHIP WITH THE INCOMING HALF ─────────────────────────────────────────────
 *
 * There was nothing to compare against. An install that holds the whole mailbox itself reads its
 * outgoing server from its own configuration: one password covers both transports, so there is no
 * second credential row to hold submission coordinates, and nothing recorded WHICH outgoing server
 * a password had been stored for. The comparison had no left-hand side. Giving it one means the
 * seal records the outgoing host it was configured for — which is a change to the credential's
 * non-secret half, written by the shared mailbox service that a hosted deployment uses too.
 *
 * ── WHAT IT RECORDS, AND WHAT THAT IS WORTH ────────────────────────────────────────────────────
 *
 * `meta.smtpHost` is the outgoing server the credential was SEALED FOR, not one a dial proved: the
 * seal tries the incoming server and stores what answered, and no submission login is attempted.
 * So this arm compares an AUTHORIZATION — the pair of servers the person named beside the password
 * — which is exactly the fact that decides whether a submission server may be offered the secret.
 *
 * ── AND WHY IT IS NARROWER THAN THE INCOMING ARM, DELIBERATELY ─────────────────────────────────
 *
 * It refuses THE SEND and nothing else. A mailbox whose outgoing server moved still receives mail
 * perfectly, and stopping the launch over it would break somebody's incoming mail to fence a send
 * they may not be making. The second case below is the guard on that: the same install, the same
 * disagreement, and the mailbox connects.
 *
 * ── WHAT THIS FILE DRIVES, AND WHY IT NEEDS NO MAIL SERVER ─────────────────────────────────────
 *
 * Real launches of a real engine on one real on-disk mirror, because the defect is invisible to
 * anything that keeps one process alive: the credential has to be sealed by one launch and met by
 * a different one. The seal is the product's own — the engine's first-run seal writes both hosts
 * from the configuration it was launched with — so nothing here hand-crafts the row under test.
 *
 * No server is needed because the claim is that NOTHING IS DIALLED. `adapterFactory` is the seam
 * the engine already has, and every adapter it hands back records its `connect()` — the moment a
 * password meets a server — into one list. The assertion is therefore `authentications === []`:
 * not "the state string was right", but no login attempted anywhere, with anything.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ─────────────────────────────────────────────
 *
 * Each applied alone, the tree restored after it, and what is written here is what the run PRINTED.
 *
 *  · delete the `credentialIsForeignSmtp` branch in `resolveLogin()` → both refusal cases go red
 *    NAMING THE LEAK rather than a state string: a `connect()` is recorded against the outgoing
 *    server the process booted with, carrying the password saved for the other one.
 *  · stop recording `smtpHost` in the engine's first-run seal → FOUR of the five launch cases go
 *    red, and they fail in the shared helper on the seal itself ("expected null to be
 *    'smtp.one-server.example'") rather than at a leak. That order is right: without the record
 *    there is no left-hand side, and this is the mutation that shows the SEAL, not the predicate,
 *    is the part that was missing. The tolerance case stays green, because its install records
 *    nothing either way.
 *  · pass `{ smtpHost }` from `start()` as well as from the send path → the "still connects" case
 *    goes red with `expected [] to have a length of 1`: the launch withholds the credential and
 *    the mailbox dials nothing, which is incoming mail broken to fence a send.
 *  · make the shared default two-sided (`sealed === null` returning `true`) → the tolerance case
 *    goes red AND SO DOES THE INCOMING ARM'S in `boot-host-contract.test.ts`. That is the property
 *    one shared comparison buys: an install sealed before either key existed can no longer send,
 *    and one mutation says so twice.
 *
 * Added with the review rounds that found the three cases below them:
 *
 *  · fold `""` back into `null` in `sealedSmtpHost` — collapsing "no outgoing server is
 *    authorized" into "this row says nothing" → the sealed-none launch case (`expected null to be
 *    ''`) and its predicate case (`expected false to be true`).
 *  · one sentence for both arms in `openLocalSend` → the naming case, whose answer no longer
 *    contains "incoming". This is the mutation worth understanding: the refusal still FIRES and
 *    still dials nothing, so every other case here stays green while the person is told to
 *    correct a server that was already right.
 *  · the door omits `smtpHost` when it is empty instead of stating it → the door's own case in
 *    `desktop-doors.test.ts`.
 *
 * ── AND A NOTE ON WHAT THESE ASSERTIONS HAD TO BECOME ──────────────────────────────────────────
 *
 * The sentence assertions were `toContain("outgoing")`, which cannot tell three refusals apart —
 * and that is exactly how a message offering a recovery with no referent survived a round. Each
 * one now asserts its arm's RECOVERY CLAUSE and the ABSENCE of the other arms'. A guard that only
 * checks a refusal happened is a guard that lets the wrong explanation ship.
 */

const PASS_FOR_THE_PAIR = "the-password-saved-for-one-pair-of-servers";
/** The INCOMING server never moves in this file. That is the whole point of it. */
const IMAP_HOST = "imap.one-server.example";
const SMTP_A = "smtp.one-server.example";
const SMTP_B = "smtp.somewhere-else.example";

/** One `connect()`: the moment a password would meet a server. */
interface Authentication {
  imapHost: string;
  smtpHost: string | null;
  pass: string;
}

interface Launch {
  sidecar: Sidecar;
  host: StdioHost;
  client: StdioClient;
}

const openLaunches: Launch[] = [];
const dataDirs: string[] = [];

afterEach(async () => {
  for (const l of openLaunches.splice(0)) {
    l.client.close();
    l.host.stop();
    await l.sidecar.stop().catch(() => undefined);
  }
  for (const d of dataDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A per-install key, as the shell's keystore would hand it over. */
function aKek(): Buffer {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
}

function freshDataDir(): string {
  const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-send-contract-"));
  dataDirs.push(d);
  return d;
}

/**
 * Every adapter this launch builds, recording the one thing that matters.
 *
 * `connect()` is where the real adapter logs in, so recording THERE rather than at construction is
 * deliberate: the engine builds its boot adapter unconditionally and only then decides whether to
 * connect it, so a recorder at the constructor would report a refusal that dialled nothing as a
 * leak.
 *
 * `send` THROWS, which is right on both kinds of case in this file. On a refusal it must never be
 * reached at all. On a TOLERANCE case it is reached deliberately, and a throw there is the stub
 * saying "there is no server here" — the send's own outcome from that point is the stub's, not the
 * contract's, so those cases assert the recorded `connect()` and not the HTTP status.
 */
/**
 * THE PASSWORD THIS CONFIG WOULD LOG IN WITH — narrowed, not asserted.
 *
 * `ImapAuth` is a union with no tag field: `{ user, pass }` for a stored password and
 * `{ user, fetchAccessToken }` for OAuth, where the token is a CALLBACK resolved at connect time
 * and there is no `pass` to read at all. `isOAuthAuth` is therefore the discriminant the type
 * carries, and it is the same predicate the adapter itself narrows with in `resolveImapAuth`.
 *
 * Every case in this file builds a password config, so the OAuth arm is a path this stub must
 * never reach — and it throws for exactly the reason `send` below does: on a mutated tree the
 * failure should be loud and here, not a silent `undefined` recorded as the password that
 * travelled.
 */
function passwordOf(auth: ImapConfig["auth"]): string {
  if (isOAuthAuth(auth)) {
    throw new Error(
      "the stub adapter was handed an OAuth config: every case in this file is password auth");
  }
  return auth.pass;
}

function recordingFactory(into: Authentication[]) {
  return (cfg: ImapConfig) => ({
    connect: async () => {
      into.push({
        imapHost: cfg.host,
        smtpHost: cfg.smtp?.host ?? null,
        pass: passwordOf(cfg.auth),
      });
    },
    send: async () => {
      throw new Error("the stub adapter was asked to send: the send reached the transport");
    },
    messageInSent: async () => null,
    close: async () => undefined,
    changesSince: async () => ({ messages: [], truncated: false }),
    ensureFolders: async () => undefined,
  });
}

interface LaunchOptions {
  dataDir: string;
  address: string;
  keks: Record<number, Buffer>;
  /**
   * The INCOMING server this launch is configured for. Defaulted, because every case but one keeps
   * it fixed — that is what makes a refusal attributable to the outgoing comparison. The one case
   * that moves it is the one asserting the refusal names the server that actually moved.
   */
  imapHost?: string;
  /**
   * The outgoing server THIS launch is configured for. `null` means the launch has no submission
   * server at all, which is what an install with nothing to send through looks like.
   */
  smtpHost: string | null;
  /** Omitted ⇒ the environment carries NO password, the steady state after the first run. */
  pass?: string;
  into?: Authentication[];
}

/** One launch of the engine on `dataDir`, with a client on the other end of a pipe pair. */
async function launch(opts: LaunchOptions): Promise<Launch> {
  const sidecar = await createSidecar({
    dataDir: opts.dataDir,
    imap: {
      // FIXED UNLESS A CASE SAYS OTHERWISE. Every case but one keeps the incoming server where the
      // credential was sealed, so a refusal can only have come from the outgoing comparison.
      host: opts.imapHost ?? IMAP_HOST,
      port: 993,
      secure: true,
      auth: { user: opts.address, ...(opts.pass === undefined ? {} : { pass: opts.pass }) },
      ...(opts.smtpHost === null
        ? {}
        : { smtp: { host: opts.smtpHost, port: 587, secure: false } }),
    },
    address: opts.address,
    displayName: "This Mac",
    keks: opts.keks,
    ...(opts.into
      ? { adapterFactory: recordingFactory(opts.into) as unknown as SidecarConfig["adapterFactory"] }
      : {}),
    // Long enough that the poll never fires during a test — every cycle here is one the test asked
    // for, so a passing assertion is never a coincidence of timing.
    pollIntervalMs: 60 * 60 * 1000,
  });

  const toHost = new PassThrough({ highWaterMark: 1024 });
  const toClient = new PassThrough({ highWaterMark: 1024 });
  const host = serveOverStdio({ handle: (req) => sidecar.handle(req), input: toHost, output: toClient });
  const client = connectOverStdio({ input: toClient, output: toHost, baseUrl: "http://sidecar" });
  await host.ready({
    baseUrl: "http://sidecar",
    sessionToken: sidecar.sessionToken,
    accountId: sidecar.world.accountId,
    userId: sidecar.world.userId,
    mailboxId: sidecar.world.mailboxId,
    credentialState: await sidecar.credentialState(),
  });

  const l: Launch = { sidecar, host, client };
  openLaunches.push(l);
  return l;
}

/** Stop a launch the way the shell does, and take it off the teardown list. */
async function shutdown(l: Launch): Promise<void> {
  const i = openLaunches.indexOf(l);
  if (i >= 0) openLaunches.splice(i, 1);
  l.client.close();
  l.host.stop();
  await l.sidecar.stop();
}

async function createDraft(l: Launch): Promise<{ id: string }> {
  const res = await l.client.fetch("/drafts", {
    method: "POST",
    headers: { authorization: `Bearer ${l.sidecar.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      mailboxId: l.sidecar.world.mailboxId,
      subject: "a send whose outgoing server moved",
      html: "<p>sent from an install whose credential and submission server disagree</p>",
      to: [{ name: null, address: "someone@elsewhere.example" }],
    }),
  });
  expect(res.status, `create draft: ${await res.clone().text()}`).toBe(201);
  return res.json() as Promise<{ id: string }>;
}

async function sendDraft(l: Launch, draftId: string): Promise<Response> {
  return l.client.fetch(`/drafts/${draftId}/send`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${l.sidecar.sessionToken}`,
      "content-type": "application/json",
      "idempotency-key": `send-${randomUUID()}`,
    },
    body: "{}",
  });
}

async function draftStatus(l: Launch, draftId: string): Promise<string> {
  const res = await l.client.fetch(`/drafts/${draftId}`, {
    headers: { authorization: `Bearer ${l.sidecar.sessionToken}` },
  });
  expect(res.status, `read draft: ${await res.clone().text()}`).toBe(200);
  return (await res.json() as { status: string }).status;
}

interface Install {
  dataDir: string;
  address: string;
  keks: Record<number, Buffer>;
}

/**
 * AN INSTALL WHOSE CREDENTIAL IS SEALED FOR ONE PAIR OF SERVERS.
 *
 * Launch one with the password in the environment: the engine's first-run seal writes the
 * credential, recording both the incoming host it dialled and the outgoing host it was configured
 * for. Stop it. The mirror on disk is now a working install.
 *
 * `sealedFor` is the OUTGOING server of that pair — `null` for an install with none, which is what
 * every credential sealed before that was recorded looks like.
 */
async function anInstallSealedFor(sealedFor: string | null): Promise<Install> {
  const dataDir = freshDataDir();
  const address = `t-${randomUUID()}@trafficflow.test`;
  const keks = { 1: aKek() };

  const first = await launch({ dataDir, address, keks, smtpHost: sealedFor, pass: PASS_FOR_THE_PAIR });
  expect(await first.sidecar.credentialState()).toBe("ready");

  // THE SEAL ITSELF, read out of the store rather than assumed. This is the left-hand side the
  // whole contract rests on, and it did not exist before this slice: without it every case below
  // would pass for the wrong reason (nothing to compare ⇒ nothing refused).
  const [row] = await first.sidecar.db.select().from(mailboxCredentials)
    .where(eq(mailboxCredentials.mailboxId, first.sidecar.world.mailboxId));
  expect(row, "the first-run seal wrote no credential").toBeTruthy();
  expect(sealedSmtpHost(row!.meta)).toBe(sealedFor);

  await shutdown(first);
  return { dataDir, address, keks };
}

describe("the send contract — a password is only offered to the outgoing server it was saved for", () => {
  it(
    "THE PROCESS CANNOT REDIRECT A SEND — the stored row decides where mail leaves by",
    async () => {
      /* ── WHAT THIS REPLACED, AND WHY THE OLD CLAIM WENT ──────────────────────────────────
       *
       * Four cases stood here, and their shared premise was that the OUTGOING server is a
       * property of the PROCESS: the engine built its send transport from the settings it was
       * launched with, so those settings could come to disagree with the credential, and the
       * defect was offering the password to a server nobody had saved it for. The refusal was
       * the right answer to that design.
       *
       * The design is gone. An install can hold several mailboxes and one process setting cannot
       * describe two submission servers, so the transport is built from the MAILBOX's own stored
       * credential — its `smtp` row when it has one, its own incoming host on 587 when it does
       * not. There is no longer a process-wide submission host to disagree with the credential,
       * which is why the outgoing arm of `resolveLogin` and its three sentences went with it.
       *
       * The safety is not weaker, it is structural: the old design let the process point
       * somewhere else and then refused; this one never asks the process at all. THAT is what
       * this case asserts, at the same dial level and with the same recording seam — because
       * "the row is right" is not the claim, "the transport is built from the row" is.
       *
       * The INCOMING arm is untouched and is still asserted by the case below and by
       * `boot-host-contract.test.ts`: a password proved against one incoming server is still
       * withheld from another, and that comparison still has two sides.
       */
      const { dataDir, address, keks } = await anInstallSealedFor(SMTP_A);

      /* The same install, relaunched with its settings naming a DIFFERENT outgoing server — the
         interrupted change of submission host that used to produce a refusal. */
      const authentications: Authentication[] = [];
      const second = await launch({ dataDir, address, keks, smtpHost: SMTP_B, into: authentications });

      const draft = await createDraft(second);
      const res = await sendDraft(second, draft.id);

      /* IT SENDS — and it sends to the server the CREDENTIAL names, not the one the process was
         relaunched with. A dial against `SMTP_B` here would be the defect the old refusal existed
         to prevent, arriving through the new design; a refusal would be the old behaviour
         surviving a change that removed its reason. */
      expect(res.status, await res.clone().text()).toBe(200);
      expect(authentications.map((a) => a.smtpHost),
        "the process configuration redirected a send away from the server the credential names")
        .toEqual([SMTP_A]);
      /* AND WITH THE PASSWORD THAT WAS SEALED FOR IT — one mailbox, one password, and the pair is
         still a pair. */
      expect(authentications.map((a) => a.pass)).toEqual([PASS_FOR_THE_PAIR]);
    },
    PGLITE_STANDUP_BUDGET_MS,
  );

  it(
    "…and the mailbox still CONNECTS, because an outgoing server is not a reason to stop receiving",
    async () => {
      const { dataDir, address, keks } = await anInstallSealedFor(SMTP_A);

      const authentications: Authentication[] = [];
      const second = await launch({ dataDir, address, keks, smtpHost: SMTP_B, into: authentications });

      // The scope of the refusal, stated positively. A fence that took the launch down with it
      // would break incoming mail to fence a send, which is a worse trade than the defect.
      expect(await second.sidecar.credentialState()).toBe("ready");
      await second.sidecar.start();
      expect(authentications).toHaveLength(1);
      expect(authentications[0]!.imapHost).toBe(IMAP_HOST);
      expect(authentications[0]!.pass).toBe(PASS_FOR_THE_PAIR);
    },
    PGLITE_STANDUP_BUDGET_MS,
  );


  it(
    "TOLERANCE: a credential that records no outgoing server can still send",
    async () => {
      /* THE CASE THAT COSTS MOST TO GET WRONG. Every install whose password was sealed before the
         outgoing host was recorded carries none, and a two-sided default would take away its
         ability to send on the first launch after an update — breaking mailboxes that work today
         to close a case rarer than they are. Built by sealing on a launch with no submission
         server configured, which is the same absence. */
      const { dataDir, address, keks } = await anInstallSealedFor(null);

      const authentications: Authentication[] = [];
      const second = await launch({ dataDir, address, keks, smtpHost: SMTP_B, into: authentications });

      const draft = await createDraft(second);
      await sendDraft(second, draft.id);

      /* THE PASSWORD WAS OFFERED — which is the whole claim, and the reason this asserts the
         record rather than the status: the stub throws at `send`, so what happens after the
         transport opens belongs to the stub. */
      expect(authentications).toEqual([
        { imapHost: IMAP_HOST, smtpHost: SMTP_B, pass: PASS_FOR_THE_PAIR },
      ]);
    },
    PGLITE_STANDUP_BUDGET_MS,
  );



  it(
    "the same outgoing server spelled differently is the same server",
    async () => {
      const { dataDir, address, keks } = await anInstallSealedFor(SMTP_A);

      /* A hostname is case-insensitive and a value out of a form field can carry whitespace.
         Refusing here would stop somebody's mail going out over typography. */
      const authentications: Authentication[] = [];
      const second = await launch({
        dataDir, address, keks, smtpHost: `  ${SMTP_A.toUpperCase()}  `, into: authentications,
      });

      const draft = await createDraft(second);
      await sendDraft(second, draft.id);
      expect(authentications).toHaveLength(1);
      expect(authentications[0]!.pass).toBe(PASS_FOR_THE_PAIR);
    },
    PGLITE_STANDUP_BUDGET_MS,
  );
});

/**
 * The predicate's edges, unit-tested rather than launched — the same set the incoming arm has, for
 * the same reason: every case where the comparison CANNOT be made must resolve to "usable", and a
 * launch is a slow way to find out which of them was got wrong.
 */
describe("credentialIsForeignSmtp — the one-sided default", () => {
  it("refuses ONLY on a positive disagreement between two named hosts", () => {
    expect(credentialIsForeignSmtp({ smtpHost: SMTP_A }, SMTP_B)).toBe(true);
    expect(credentialIsForeignSmtp({ smtpHost: SMTP_A }, SMTP_A)).toBe(false);
  });

  it("admits a credential that SAYS NOTHING — everything sealed before this key existed", () => {
    expect(credentialIsForeignSmtp({ host: IMAP_HOST, port: 993 }, SMTP_B)).toBe(false);
    // Not a string is not a statement: a row written by something that put the wrong type here
    // says nothing, and a predicate that read it as "none" would refuse a working mailbox.
    expect(credentialIsForeignSmtp({ smtpHost: 587 }, SMTP_B)).toBe(false);
    expect(credentialIsForeignSmtp(null, SMTP_B)).toBe(false);
    expect(credentialIsForeignSmtp(undefined, SMTP_B)).toBe(false);
  });

  it("REFUSES a credential that says NO outgoing server — which is not the same as saying nothing", () => {
    /* THE DISTINCTION A REVIEW ROUND FOUND MISSING, and it was a real hole rather than a tidiness
       point. The door writes the empty string when the form and the preset name no outgoing
       server, which is a statement: this password was saved for a pair with nothing on that side.
       Folded into "says nothing" it became the LEGACY tolerance, so an install could acquire a
       submission server afterwards — by the hand-edited settings this contract exists to catch —
       and the password would be decrypted and offered to it. */
    expect(credentialIsForeignSmtp({ smtpHost: "" }, SMTP_B)).toBe(true);
    expect(credentialIsForeignSmtp({ smtpHost: "   " }, SMTP_B)).toBe(true);
    // And the two spellings are genuinely distinguishable at the source, which is what makes the
    // rule expressible at all.
    expect(sealedSmtpHost({ smtpHost: "" })).toBe("");
    expect(sealedSmtpHost({})).toBeNull();
    // …while an install that also has no outgoing server configured is not in disagreement with
    // it. That launch cannot send at all, and the honest refusal there is about the missing
    // server, not about the credential.
    expect(credentialIsForeignSmtp({ smtpHost: "" }, "")).toBe(false);
    expect(credentialIsForeignSmtp({ smtpHost: "" }, undefined)).toBe(false);
  });

  it("admits when the install names no outgoing server — nothing to disagree WITH", () => {
    expect(credentialIsForeignSmtp({ smtpHost: SMTP_A }, "")).toBe(false);
    expect(credentialIsForeignSmtp({ smtpHost: SMTP_A }, "   ")).toBe(false);
    expect(credentialIsForeignSmtp({ smtpHost: SMTP_A }, undefined)).toBe(false);
    expect(credentialIsForeignSmtp({ smtpHost: SMTP_A }, null)).toBe(false);
  });

  it("normalises case and surrounding whitespace, and NOTHING else", () => {
    expect(credentialIsForeignSmtp({ smtpHost: SMTP_A.toUpperCase() }, SMTP_A)).toBe(false);
    expect(credentialIsForeignSmtp({ smtpHost: `  ${SMTP_A}  ` }, SMTP_A)).toBe(false);
    /* Not normalised, deliberately, and this is the conservative direction: inventing an
       equivalence hands the secret over on a pair somebody typed differently. */
    expect(credentialIsForeignSmtp({ smtpHost: `${SMTP_A}.` }, SMTP_A)).toBe(true);
    expect(credentialIsForeignSmtp({ smtpHost: `sub.${SMTP_A}` }, SMTP_A)).toBe(true);
  });

  it("reads its OWN key, so the two arms of the contract cannot answer for each other", () => {
    // The incoming host is `meta.host` and the outgoing one is `meta.smtpHost`. A predicate that
    // read the wrong key would compare an incoming host with a submission host and refuse every
    // ordinary install, or — worse — silently compare nothing.
    expect(sealedSmtpHost({ host: SMTP_A })).toBeNull();
    expect(sealedSmtpHost({ smtpHost: `  ${SMTP_A.toUpperCase()}  ` })).toBe(SMTP_A);
    expect(sealedSmtpHost({})).toBeNull();
    expect(sealedSmtpHost(SMTP_A)).toBeNull();
    /* And the INCOMING reader does NOT draw the empty-string distinction, deliberately: `meta.host`
       is whatever the probe DIALLED, so an empty value there is a row written by a path that never
       dialled — an absence. Only the outgoing key has a writer that can mean "none". */
    expect(sealedHost({ host: "" })).toBeNull();
  });
});
