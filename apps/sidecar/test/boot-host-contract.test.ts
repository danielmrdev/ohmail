import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { isOAuthAuth, type ImapConfig } from "@trafficflow/core/adapters/imap";
import { connectOverStdio, type StdioClient } from "../src/client.js";
import { createSidecar, type Sidecar, type SidecarConfig } from "../src/engine.js";
import { serveOverStdio, type StdioHost } from "../src/host.js";
import { credentialIsForeign, sealedHost } from "../src/credential-host.js";
import { freshDataDir as templatedDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";

/**
 * ═══ THE BOOT CONTRACT ═════════════════════════════════════════════════════════════════════════
 *
 * An engine configured for one server, holding a password proved against another, must refuse to
 * dial — on BOTH transports — and must say so in words that are true.
 *
 * ── WHY THIS EXISTS AS A ROW OF ITS OWN ────────────────────────────────────────────────────────
 *
 * The local door was reordered so a reconfigure seals the new password BEFORE the shell commits
 * the new settings, which stops the leak on the path a person takes. That reorder cannot close the
 * general case, and its own review named the two sequences that remain. Both are here, and both
 * end at the SAME line of code — `resolveLogin()`, which is the one place that decides whether a
 * launch may have the stored password:
 *
 *  1. THE INTERRUPTED HANDOFF. Between the seal and the `engine_configure` that follows it, the
 *     credential names the new host and the settings still name the old one. A configure that
 *     fails is reported to the person; a process that DIES there has nobody to tell, and the next
 *     launch comes up configured for the old server holding the new server's password. That is the
 *     mirror image of the divergence the reorder ended, and only the engine can catch it.
 *  2. THE RACING SEND. `openLocalSend` resolves the credential AFRESH for every send while holding
 *     the SMTP coordinates the process booted with, so a send fired on the engine's own timer
 *     during that same interval offers the new server's password to the old server's SMTP. No
 *     ordering in the door can prevent it — the door is a modal over the whole app and the timer
 *     is not.
 *
 * ── WHAT THIS FILE DRIVES, AND WHY IT NEEDS NO MAIL SERVER ─────────────────────────────────────
 *
 * Three real launches of a real engine on ONE real on-disk mirror, because the defect is invisible
 * to anything that keeps a single process alive: the credential has to be sealed by one launch and
 * met by a different one. The seal is the product's own — the engine's first-run seal writes
 * `meta.host` from the config it was launched with, which is the same field
 * `PATCH /mailboxes/:id` writes from the host its probe actually dialled — so nothing here
 * hand-crafts the row the assertion is about.
 *
 * No IMAP server is needed because the claim is that NOTHING IS DIALLED. `adapterFactory` is the
 * seam the sidecar already has for exactly this, and every adapter it hands back records its
 * `connect()` — the moment a password meets a server — into one list. So the assertion is
 * `authentications === []`: not "the state string was right", but no login attempted anywhere,
 * with anything, on either transport.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ─────────────────────────────────────────────
 *
 * Each applied alone, the tree restored after it, and what is written here is what the run PRINTED
 * rather than what it was expected to print.
 *
 *  · delete the `credentialIsForeign` branch in `resolveLogin()` — i.e. today's engine → the two
 *    launch cases go red, and they name the defect rather than a state string: the boot case
 *    records a `connect()` against the NEW host carrying the password sealed for the OLD one, and
 *    the send case records a second one against the OLD host's SMTP carrying the NEW host's
 *    password.
 *  · make the comparison one-sided (`sealed !== null` alone, without the configured-host guard) →
 *    the legacy-row case goes red: an install whose credential predates `meta.host` is refused on
 *    every launch, which breaks a working mailbox to close a rarer one.
 *  · drop the `normalizeHost` lowercase → the case-and-whitespace case goes red, and it is the one
 *    that matters in practice: a host typed with a capital is the same server.
 */

const PASS_FOR_A = "the-password-proved-against-server-a";
const HOST_A = "imap.server-a.example";
const HOST_B = "imap.server-b.example";
const SMTP_A = "smtp.server-a.example";

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

async function freshDataDir(): Promise<string> {
  const d = await templatedDataDir("ohmail-boot-contract-");
  dataDirs.push(d);
  return d;
}

/**
 * Every adapter this launch builds, recording the one thing that matters.
 *
 * `connect()` is where `ImapAdapter` logs in, so recording THERE rather than at construction is
 * deliberate: the engine builds its boot adapter unconditionally and only then decides whether to
 * connect it, so a recorder at the constructor would report a refusal that dialled nothing as a
 * leak. The send methods throw, which is correct for a stub that must never be reached on the
 * paths this file asserts — and on a mutated tree it makes the second sequence fail loudly right
 * after it has been recorded.
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
      throw new Error("the stub adapter was asked to send: the send reached SMTP");
    },
    messageInSent: async () => null,
    close: async () => undefined,
    changesSince: async () => ({ messages: [], truncated: false }),
    ensureFolders: async () => undefined,
  });
}

interface LaunchOptions {
  dataDir: string;
  imapHost: string;
  address: string;
  keks: Record<number, Buffer>;
  /** Omitted ⇒ the environment carries NO password, the steady state after the first run. */
  pass?: string;
  into?: Authentication[];
}

/** One launch of the engine on `dataDir`, with a client on the other end of a pipe pair. */
async function launch(opts: LaunchOptions): Promise<Launch> {
  const sidecar = await createSidecar({
    dataDir: opts.dataDir,
    imap: {
      host: opts.imapHost,
      port: 993,
      secure: true,
      auth: { user: opts.address, ...(opts.pass === undefined ? {} : { pass: opts.pass }) },
      // The SMTP coordinates the process boots with, which is exactly what the racing-send
      // sequence is about: they do NOT move when the credential does.
      smtp: { host: SMTP_A, port: 587, secure: false },
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
      subject: "a send that races the handoff",
      html: "<p>sent from an engine whose credential and configuration disagree</p>",
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

/**
 * THE INSTALL BOTH SEQUENCES START FROM.
 *
 * Launch one against server A with the password in the environment: the engine's first-run seal
 * writes the credential with `meta.host = A`, which is the product's own seal and not a fixture.
 * Stop it. The mirror on disk is now a working install of a mailbox on server A.
 */
async function anInstallSealedForServerA(): Promise<{ dataDir: string; address: string; keks: Record<number, Buffer> }> {
  const dataDir = await freshDataDir();
  const address = `t-${randomUUID()}@trafficflow.test`;
  const keks = { 1: aKek() };

  const first = await launch({ dataDir, imapHost: HOST_A, address, keks, pass: PASS_FOR_A });
  expect(await first.sidecar.credentialState()).toBe("ready");
  await shutdown(first);

  return { dataDir, address, keks };
}

describe("the boot contract — a credential is only valid for the server it was proved against", () => {
  it(
    "REPRODUCTION (the interrupted handoff): a launch configured for another server dials nothing",
    async () => {
      const { dataDir, address, keks } = await anInstallSealedForServerA();

      /* The install as a crash inside `engine_configure` leaves it: the credential was sealed for
         one server and the settings this launch reads name a different one. Which of the two moved
         does not matter to the engine and is not knowable from here — what it knows is that they
         disagree, which is enough to withhold the password. */
      const authentications: Authentication[] = [];
      const second = await launch({
        dataDir, imapHost: HOST_B, address, keks, into: authentications,
      });

      /* THE ASSERTION THE FILE IS FOR, AND IT COMES FIRST DELIBERATELY. Not the state string: no
         login was attempted, with anything, anywhere. `start()` is allowed to fail — on a mutated
         tree it gets past the gate and then falls over a stub — so what is read is the RECORD,
         which is written before any of that.

         Asserted BEFORE the vocabulary below so that a tree without the contract fails by NAMING
         THE LEAK rather than by naming a missing string: the printed diff is
         `[{ imapHost: "imap.server-b.example", smtpHost: "smtp.server-a.example",
         pass: "the-password-proved-against-server-a" }]` — the new server, authenticated to with
         the old server's password. A guard whose failure message is "expected 'ready' to be
         'foreign-host'" describes the fix; this one describes the defect. */
      await second.sidecar.start().catch(() => undefined);
      expect(authentications).toEqual([]);

      // And the state, in the engine's own vocabulary — NOT one of the three that existed before,
      // and still the same after `start()`: this is a refusal to USE the credential, never a
      // deletion of it. The recovery case below is what proves that positively.
      expect(await second.sidecar.credentialState()).toBe("foreign-host");
    },
    PGLITE_STANDUP_BUDGET_MS,
  );

  it(
    "REPRODUCTION (the racing send): a send in that window reaches no SMTP server either",
    async () => {
      const { dataDir, address, keks } = await anInstallSealedForServerA();

      const authentications: Authentication[] = [];
      const second = await launch({
        dataDir, imapHost: HOST_B, address, keks, into: authentications,
      });

      /* The sequence review raised, driven rather than reasoned about: the door is a modal over
         the whole app, but a scheduled send fires on the engine's own timer and resolves the
         credential AFRESH while holding the SMTP coordinates this process booted with. */
      const draft = await createDraft(second);
      const res = await sendDraft(second, draft.id);

      /* FIRST, and for the same reason as the case above: the finding is not that a send failed,
         it is WHICH SERVER A PASSWORD WAS OFFERED TO. Against today's engine this prints
         `[{ imapHost: "imap.server-b.example", smtpHost: "smtp.server-a.example",
         pass: "the-password-proved-against-server-a" }]` — the SMTP coordinates the process booted
         with, carrying the password proved against the other server. That is the whole of the
         finding, and it is what a reader of a red run should see. */
      expect(authentications).toEqual([]);

      // …and only then that the send was refused rather than merely failing at the far end. It is
      // refused BEFORE a socket is opened, so no server was ever asked.
      expect(res.ok, `the send was accepted: ${await res.clone().text()}`).toBe(false);
    },
    PGLITE_STANDUP_BUDGET_MS,
  );

  it(
    "is a refusal about the CONFIGURATION, so putting the server back makes the mailbox work again",
    async () => {
      const { dataDir, address, keks } = await anInstallSealedForServerA();

      const refusing: Authentication[] = [];
      const wrong = await launch({ dataDir, imapHost: HOST_B, address, keks, into: refusing });
      expect(await wrong.sidecar.credentialState()).toBe("foreign-host");
      await shutdown(wrong);

      /* THE RECOVERY, and the reason this state is not `unreadable`. Nothing was re-entered, no
         key was replaced and no row was rewritten — the install was pointed back at the server its
         credential was always for, and it is `ready`. A state whose recovery is "type your
         password again" would have sent somebody to do that, into whichever server the install
         happened to be pointing at. */
      const right = await launch({ dataDir, imapHost: HOST_A, address, keks, into: [] });
      expect(await right.sidecar.credentialState()).toBe("ready");
    },
    PGLITE_STANDUP_BUDGET_MS,
  );

  it(
    "the same server spelled differently is the same server",
    async () => {
      const { dataDir, address, keks } = await anInstallSealedForServerA();

      /* A hostname is case-insensitive and a value out of a form field can carry whitespace.
         Refusing here would break a working mailbox over typography. */
      const l = await launch({
        dataDir, imapHost: `  ${HOST_A.toUpperCase()}  `, address, keks, into: [],
      });
      expect(await l.sidecar.credentialState()).toBe("ready");
    },
    PGLITE_STANDUP_BUDGET_MS,
  );
});

/**
 * The predicate's edges, unit-tested rather than launched.
 *
 * These are the cases where getting the DEFAULT wrong is expensive and a launch would be a slow
 * way to find out: the comparison decides whether to withhold a working password, so every case in
 * which it cannot be made must resolve to "usable". A stricter default would take every install
 * whose credential predates `meta.host` offline on its next launch — breaking mailboxes that work
 * today in order to close a case rarer than they are.
 */
describe("credentialIsForeign — the one-sided default", () => {
  it("refuses ONLY on a positive disagreement between two named hosts", () => {
    expect(credentialIsForeign({ host: HOST_A }, HOST_B)).toBe(true);
    expect(credentialIsForeign({ host: HOST_A }, HOST_A)).toBe(false);
  });

  it("admits a credential that names no host — an install sealed before the probe recorded one", () => {
    expect(credentialIsForeign({ port: 993, user: "someone" }, HOST_B)).toBe(false);
    expect(credentialIsForeign({ host: "" }, HOST_B)).toBe(false);
    expect(credentialIsForeign({ host: "   " }, HOST_B)).toBe(false);
    expect(credentialIsForeign({ host: 993 }, HOST_B)).toBe(false);
    expect(credentialIsForeign(null, HOST_B)).toBe(false);
    expect(credentialIsForeign(undefined, HOST_B)).toBe(false);
  });

  it("admits when the engine names no host — a configuration fault is not a credential fault", () => {
    expect(credentialIsForeign({ host: HOST_A }, "")).toBe(false);
    expect(credentialIsForeign({ host: HOST_A }, "   ")).toBe(false);
    expect(credentialIsForeign({ host: HOST_A }, undefined)).toBe(false);
    expect(credentialIsForeign({ host: HOST_A }, null)).toBe(false);
  });

  it("normalises case and surrounding whitespace, and NOTHING else", () => {
    expect(credentialIsForeign({ host: HOST_A.toUpperCase() }, HOST_A)).toBe(false);
    expect(credentialIsForeign({ host: `  ${HOST_A}  ` }, HOST_A)).toBe(false);
    /* Not normalised, deliberately: a trailing dot is a different string, and inventing an
       equivalence here hands the secret over on a pair somebody typed differently. The
       conservative direction for a predicate that decides whether to withhold a password is to
       refuse more, never to admit more. */
    expect(credentialIsForeign({ host: `${HOST_A}.` }, HOST_A)).toBe(true);
    expect(credentialIsForeign({ host: `sub.${HOST_A}` }, HOST_A)).toBe(true);
  });

  it("sealedHost reports what the row says, normalised, or null when it says nothing", () => {
    expect(sealedHost({ host: `  ${HOST_A.toUpperCase()}  ` })).toBe(HOST_A);
    expect(sealedHost({ host: "" })).toBeNull();
    expect(sealedHost({})).toBeNull();
    expect(sealedHost("imap.server-a.example")).toBeNull();
  });
});
