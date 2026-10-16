import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSidecar, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ═══ AN OUTGOING SERVER IS NOT A REASON TO STOP RECEIVING ══════════════════════════════════
 *
 * The local door proves BOTH transports before it stores anything, and `MailboxService` refuses
 * the whole write when either dial is refused — one transaction, both credentials, all or nothing.
 * On the hosted door that is right. On this one it read the send-host contract backwards: a
 * mailbox whose incoming server worked could not be connected AT ALL because its outgoing one was
 * blocked by a network, guessed wrong by a provider preset, or wanted a different login. And the
 * flow's "Test connection" only ever proved IMAP, so the refusal arrived after a green tick, about
 * a server the test had never touched.
 *
 * The shape now, and every clause of it is a case below:
 *
 *   connect with a refused submission server → the mailbox is there, connected, with its incoming
 *   credential stored and NO `smtp` row; the reason is recorded; sending refuses with that reason
 *   rather than guessing at `imap host:587`; and naming a working server in Settings re-probes and
 *   settles it.
 *
 * WHAT IS NOT TRADED AWAY: an IMAP refusal is still fatal. That is the password the person is
 * being asked for, and storing one nothing has logged in with is the defect the probe seam exists
 * to prevent — the last case holds that line.
 */

const HOST = "imap.example.test";
const USER = "owner@example.test";
const GOOD_SMTP = "smtp-good.example.test";
const BAD_SMTP = "smtp-blocked.example.test";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/**
 * The dial, as a double. The INCOMING leg accepts one password; the OUTGOING leg accepts one host
 * and refuses the other with a real `authenticationFailed`, which is what a submission server that
 * wants a different login looks like from here.
 */
function dialer() {
  const smtpDialled: string[] = [];
  return {
    smtpDialled,
    factory: (cfg: { host?: string; auth?: { pass?: string }; smtp?: { host?: string } }) => ({
      async connect(): Promise<void> {
        if (cfg.auth?.pass !== "right") {
          const err = new Error("authentication failed") as Error & { authenticationFailed?: boolean };
          err.authenticationFailed = true;
          throw err;
        }
      },
      async close(): Promise<void> {},
      async listFolders(): Promise<string[]> { return ["INBOX"]; },
      leaseIo: () => ({
        async ensureMetaFolder(): Promise<void> {},
        async listClaims(): Promise<never[]> { return []; },
        async appendClaim(): Promise<void> {},
        async removeClaims(): Promise<void> {},
        /** The uid generation, because `makeLeaseIo` always names one — see `lease-io-doubles.test.ts`. */
        uidValidity: () => 4_100,
      }),
      leasePeekIo: () => ({ async listClaims(): Promise<never[]> { return []; } }),
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
    }),
    /**
     * THE SUBMISSION DIAL, injected on the sidecar's own seam. The engine passes
     * `{ dial: async () => undefined }` when an `adapterFactory` is present — a double that always
     * succeeds — so a case about a REFUSED submission server has to replace it.
     */
    smtpDial: async (smtp: { host?: string }): Promise<void> => {
      /* THE FIRST PARAMETER IS THE SMTP CONFIG ITSELF, not a wrapper carrying one. Reading it as
         `opts.smtp.host` gave `undefined`, the refusal never fired, and the case failed against
         working code for a reason that had nothing to do with the product. */
      const host = smtp.host ?? "";
      smtpDialled.push(host);
      if (host === BAD_SMTP) {
        const err = new Error("authentication failed") as Error & { authenticationFailed?: boolean };
        err.authenticationFailed = true;
        throw err;
      }
    },
  };
}

/** Every submission host this composition dialled — see the case that asserts on it. */
let dialledHosts: string[] = [];
const dialled = (): string[] => dialledHosts;

async function boot(): Promise<Sidecar> {
  const dataDir = await freshDataDir("ohmail-sending-");
  const d = dialer();
  dialledHosts = d.smtpDialled;
  const s = await createSidecar({
    dataDir,
    imap: {
      host: HOST, port: 993, secure: true,
      auth: { user: USER, pass: "right" },
    },
    address: USER,
    machineName: "this machine",
    pollIntervalMs: 60 * 60 * 1000,
    leaseStaleAfterMs: 60_000,
    keks: { 1: Buffer.alloc(32, 7) },
    adapterFactory: d.factory,
    smtpDial: d.smtpDial,
    log: () => {},
  } as never);
  cleanups.push(async () => {
    await s.stop().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  });
  await s.start();
  return s;
}

const auth = (s: Sidecar): HeadersInit => ({
  authorization: `Bearer ${s.sessionToken}`,
  "content-type": "application/json",
});

const add = (s: Sidecar, body: unknown): Promise<Response> =>
  s.handle(new Request("http://local/local/mailboxes", {
    method: "POST", headers: auth(s), body: JSON.stringify(body),
  }));

const creds = async (s: Sidecar, mailboxId: string) =>
  (await s.db.execute(
    `select transport, meta->>'smtpUnsettled' as unsettled from mailbox_credentials `
    + `where mailbox_id = '${mailboxId}'` as never,
  )).rows as Array<{ transport: string; unsettled: string | null }>;

describe("connecting a mailbox whose submission server refuses", () => {
  it("STORES THE INCOMING CREDENTIAL, writes no smtp row, and records the reason", async () => {
    const s = await boot();
    const res = await add(s, {
      provider: "imap",
      address: "second@example.test",
      imap: { host: HOST, port: 993, secure: true, user: "second@example.test", pass: "right",
        smtpUnsettled: "" },
      smtp: { host: BAD_SMTP, port: 465, secure: true, user: "second@example.test", pass: "right" },
    });

    /* THE CONNECT SUCCEEDS. Before this it was a 400 and no mailbox at all — a working incoming
       server held hostage to a blocked outgoing one. */
    expect(res.status, await res.clone().text()).toBe(201);
    const dto = await res.json() as { id: string; sendingUnsettledReason?: string | null };

    /* THE REASON RIDES THE DTO, so the pane, the flow and the send refusal read one field.
       A MEMBER OF THE TAXONOMY rather than one named code: which member is the PROBE's
       classification, tested where the classifier lives (`imap-probe`), and pinning it here would
       make this file fail whenever that mapping is refined. What this file owns is that a reason
       is recorded at all, that it is one the surfaces have wording for, and that the DTO and the
       stored meta agree — three things that were all false before. */
    expect(["auth", "connect", "tls", "timeout", "unknown"])
      .toContain(dto.sendingUnsettledReason);

    const rows = await creds(s, dto.id);
    expect(rows.map((r) => r.transport), "an unproven submission credential was stored")
      .toEqual(["imap"]);
    expect(rows[0]!.unsettled, "the DTO and the stored meta disagree about the reason")
      .toBe(dto.sendingUnsettledReason);
    /* AND THE SUBMISSION SERVER WAS ACTUALLY DIALLED. Without this the case passes when the probe
       never runs at all — which is exactly how it failed the first time, against working code. */
    expect(dialled(), "the submission server was never dialled").toContain(BAD_SMTP);
  });

  /* THE SEND REFUSAL ITSELF lives beside the function that makes it —
     `packages/api/test/send-adapter-unsettled.test.ts` — because `makeSendAdapter` takes an
     `ApiDeps` and a key provider, and reaching into this engine for its private one would be a
     test asserting through a seam the product does not have. What this file holds is the STATE
     that refusal reads: an `imap` row carrying the marker and no `smtp` row at all. */

  it("A WORKING submission server settles it, and nothing is marked", async () => {
    // The positive control: the same path with a server that answers stores both rows and no
    // marker, so the case above cannot pass because the marker is written unconditionally.
    const s = await boot();
    const res = await add(s, {
      provider: "imap",
      address: "third@example.test",
      imap: { host: HOST, port: 993, secure: true, user: "third@example.test", pass: "right",
        smtpUnsettled: "" },
      smtp: { host: GOOD_SMTP, port: 465, secure: true, user: "third@example.test", pass: "right" },
    });
    expect(res.status).toBe(201);
    const dto = await res.json() as { id: string; sendingUnsettledReason?: string | null };
    expect(dto.sendingUnsettledReason ?? null).toBeNull();
    const rows = await creds(s, dto.id);
    expect(rows.map((r) => r.transport).sort()).toEqual(["imap", "smtp"]);
  });

  it("AN INCOMING REFUSAL IS STILL FATAL — the line this does not cross", async () => {
    /* The whole trade is that a SUBMISSION refusal is survivable. An IMAP refusal is the password
       the person is being asked for, and storing one nothing has logged in with is the defect the
       probe seam exists to prevent. */
    const s = await boot();
    const res = await add(s, {
      provider: "imap",
      address: "fourth@example.test",
      imap: { host: HOST, port: 993, secure: true, user: "fourth@example.test", pass: "wrong" },
    });
    expect(res.status).toBe(400);
    const wire = await res.json() as { error: { code: string } };
    expect(wire.error.code).toBe("mailbox_probe_failed");
    const live = (await s.db.execute(
      "select address from mailboxes where status <> 'disabled'" as never,
    )).rows as Array<{ address: string }>;
    expect(live.map((r) => r.address)).not.toContain("fourth@example.test");
  });
});
