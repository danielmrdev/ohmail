import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

import { createSidecar, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ═══ THE SUBMISSION LEG, AGAINST A REAL SERVER ═════════════════════════════════════════════
 *
 * `local-probe.test.ts` drives this leg through an injected dial, which is the only way to
 * produce a refusal on demand — and a double answers the way the file that wrote it expects. The
 * dial that ships is nodemailer speaking SMTP to a socket, so the classification that matters is
 * the one a real handshake produces. Two arms: the compose stack's own submission server, and a
 * port nothing is listening on.
 */

/**
 * WHAT THIS FILE CANNOT ASK. GreenMail cannot be made hostile — it accepts any login — so the
 * REFUSED-BY-THE-SERVER classes (a wrong password, a certificate) are proved at the double and
 * at the fake-server seam, and what is proved here is the pair a real socket can answer: an
 * accepted handshake and a connection nothing answers. The fixture login is generated per run
 * and never written down; nothing in this file reads the wire.
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
const SMTP_HOST = process.env.SMTP_HOST ?? "127.0.0.1";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 3025);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A port that was bound and released, so "nothing is listening" is a fact rather than a guess. */
async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

async function boot(): Promise<Sidecar> {
  const dataDir = await freshDataDir("ohmail-probe-smtp-");
  const s = await createSidecar({
    dataDir,
    /* THE REAL DIALS. No `adapterFactory`, so the engine composes the probes it ships with —
       which is the whole point of this file; with one, both legs resolve against doubles. */
    imap: {
      host: IMAP_HOST, port: IMAP_PORT, secure: false,
      auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: randomUUID() },
    },
    address: `t-${randomUUID()}@trafficflow.test`,
    machineName: "this machine",
    pollIntervalMs: 60 * 60 * 1000,
    leaseStaleAfterMs: 60_000,
    keks: { 1: Buffer.alloc(32, 7) },
    log: () => {},
  } as never);
  cleanups.push(async () => {
    await s.stop().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  });
  await s.start();
  /* The launch stamp is written once at boot and the shared probe route is `stepUp: true`; the
     local one is not, and ageing the row is how its own test proves that. Kept here so this file
     measures the dial rather than the gate. */
  await s.db.execute(sql`update sessions set last_twofa_at = now() - interval '6 minutes'`);
  return s;
}

interface Probed {
  host?: string;
  folders?: number | null;
  sending?: { state: string; host?: string; reason?: string };
}

async function probe(s: Sidecar, smtp: Record<string, unknown>): Promise<Probed> {
  const address = `t-${randomUUID()}@trafficflow.test`;
  const res = await s.handle(new Request("http://local/local/mailboxes/probe", {
    method: "POST",
    headers: { authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      address,
      imap: { host: IMAP_HOST, port: IMAP_PORT, secure: false, user: address, pass: randomUUID() },
      smtp,
    }),
  }));
  expect(res.status, "the probe route refused the whole request").toBe(200);
  return await res.json() as Probed;
}

describe("the submission leg against the compose stack", () => {
  it("an answering submission server is OK, and the incoming verdict comes with it", async () => {
    const s = await boot();
    const dto = await probe(s, { host: SMTP_HOST, port: SMTP_PORT, secure: false });

    expect(dto.host, "the incoming leg did not answer").toBe(IMAP_HOST);
    expect(dto.sending, "the submission leg was not reported at all").toMatchObject({ state: "ok" });
    expect(dto.sending?.host).toBe(SMTP_HOST);
  });

  it("a port nothing is listening on is REFUSED, and classified as the connection", async () => {
    const s = await boot();
    const dto = await probe(s, { host: SMTP_HOST, port: await closedPort(), secure: false });

    /* THE RECEIVING LEG STILL ANSWERS — the two verdicts are independent, which is the whole
       reason the sending one is reported rather than thrown. */
    expect(dto.host).toBe(IMAP_HOST);
    expect(dto.sending).toMatchObject({ state: "refused", reason: "connect" });
  });
});
