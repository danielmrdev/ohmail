import { describe, it, expect, afterAll } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter, parseRef } from "../../src/adapters/imap.js";
import { eml } from "./_imapenv.js";
import { startLatencyProxy, type LatencyProxy } from "./_latency-proxy.js";
import type { ImapConfig, NativeLocator } from "../../src/adapters/imap-types.js";
import { randomUUID } from "node:crypto";
import { FIXTURE_DOOR } from "./_door.js";

/**
 * WHAT FILING COSTS, in round trips, against a real server.
 *
 * Opt-in (`IMAP_PERF=1`) and needs the Dovecot container — `docker compose --profile condstore up
 * -d dovecot`. Dovecot rather than GreenMail because the batched path is gated on MOVE + UIDPLUS
 * and Dovecot advertises both, which is what every mailbox this product has measured in production
 * also does.
 *
 * The assertion is on COMMANDS PER MESSAGE, not on seconds: seconds are a property of whatever
 * delay the proxy is set to, commands are a property of the code. The seconds are printed anyway
 * because they are what a person waiting on "Filing N messages" actually experiences, and the
 * proxy's delay is chosen to put the per-message figure in the range production measures.
 */
const RUN = process.env.IMAP_PERF === "1";
const DOVECOT = { host: process.env.IMAP_CONDSTORE_HOST ?? "127.0.0.1", port: Number(process.env.IMAP_CONDSTORE_PORT ?? 3144) };
/** One round trip: the figure production's filing time per message implies, spread over its commands. */
const ONE_WAY_MS = Number(process.env.IMAP_PERF_DELAY_MS ?? 50);
const N = Number(process.env.IMAP_PERF_N ?? 40);

let proxy: LatencyProxy | undefined;
afterAll(async () => { await proxy?.close(); });

function cfg(port: number, user: string): ImapConfig {
  return {
    host: "127.0.0.1", port, secure: false,
    auth: { user, pass: "testpass-password" },
    smtp: { host: "127.0.0.1", port: Number(process.env.SMTP_PORT ?? 3025), secure: false },
    sentDomain: "trafficflow.test",
  };
}

async function seed(port: number, user: string, n: number): Promise<NativeLocator[]> {
  const c = new ImapFlow({ host: "127.0.0.1", port, secure: false, auth: { user, pass: "testpass-password" }, logger: false });
  await c.connect();
  const out: NativeLocator[] = [];
  const lock = await c.getMailboxLock("INBOX");
  try {
    const uidValidity = String((c.mailbox as { uidValidity: bigint }).uidValidity);
    for (let i = 0; i < n; i++) {
      const id = `perf-${i}-${randomUUID()}@x`;
      const res = await c.append("INBOX", eml({ from: "s@x.example", subject: `perf ${i}`, messageId: id }));
      const uid = res && typeof res !== "boolean" ? res.uid : 0;
      out.push({ folder: "INBOX", ref: `${uidValidity}:${uid}` });
    }
  } finally { lock.release(); await c.logout(); }
  return out;
}

describe.runIf(RUN)("filing cost per message (Dovecot behind a latency proxy)", () => {
  it(`one-at-a-time move vs moveMany, ${N} messages`, async () => {
    proxy = await startLatencyProxy(DOVECOT, ONE_WAY_MS);

    // ── BEFORE: the per-message path, exactly as reconcileFolders drives it ────────────────
    const userA = `perf-a-${randomUUID().slice(0, 8)}@trafficflow.test`;
    const locsA = await seed(proxy.port, userA, N);
    const a = new ImapAdapter(cfg(proxy.port, userA));
    await a.connect();
    await a.ensureFolders(FIXTURE_DOOR);
    proxy.reset();
    const t0 = Date.now();
    for (const loc of locsA) {
      const next = await a.move(loc, "ohmail/News", FIXTURE_DOOR);
      expect(parseRef(next.ref).uid).toBeGreaterThan(0);
    }
    const perMsgBefore = (Date.now() - t0) / N;
    const cmdsBefore = proxy.commands;
    await a.close();

    // ── AFTER: the batched path ───────────────────────────────────────────────────────────
    const userB = `perf-b-${randomUUID().slice(0, 8)}@trafficflow.test`;
    const locsB = await seed(proxy.port, userB, N);
    const b = new ImapAdapter(cfg(proxy.port, userB));
    await b.connect();
    await b.ensureFolders(FIXTURE_DOOR);
    proxy.reset();
    const t1 = Date.now();
    const res = await b.moveMany(locsB, "ohmail/News", FIXTURE_DOOR);
    const perMsgAfter = (Date.now() - t1) / N;
    const cmdsAfter = proxy.commands;
    await b.close();

    expect(res.outcome).toBe("batched");
    expect(res.moved.size).toBe(N);

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      messages: N, oneWayDelayMs: ONE_WAY_MS,
      before: { commands: cmdsBefore, commandsPerMessage: +(cmdsBefore / N).toFixed(2), msPerMessage: +perMsgBefore.toFixed(1) },
      after: { commands: cmdsAfter, commandsPerMessage: +(cmdsAfter / N).toFixed(2), msPerMessage: +perMsgAfter.toFixed(1) },
      speedup: +(perMsgBefore / perMsgAfter).toFixed(1),
    }, null, 2));

    // The claim under test, and it is about the code rather than about this machine: the
    // per-message path costs a handful of commands PER MESSAGE, the batched path costs a handful
    // per BATCH. Anything above 1 command per message means the batch is still round-tripping
    // per message somewhere.
    expect(cmdsBefore / N).toBeGreaterThan(3);
    expect(cmdsAfter / N).toBeLessThan(1);
  }, 600_000);
});
