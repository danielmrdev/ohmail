import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { mailboxes } from "@trafficflow/db";
import { connectOverStdio, type StdioClient } from "../src/client.js";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { serveOverStdio, type StdioHost } from "../src/host.js";

/**
 * A 4 MB VIDEO LEAVES THE STANDALONE ENGINE — the reported refusal, end to end over GreenMail.
 * A mailbox whose server announced no `SIZE` was held to the hosted request body's 3 MB, so a
 * 4 MB mp4 was refused before it was sent; it now counts as the assumed 25 MiB announcement of a
 * typical provider. The same file sends against a mailbox that announced 25 MiB. The delivered copy
 * is read back by a second IMAP client and its attachment compared byte for byte.
 *
 * Mutation watched: `effectiveAttachmentCap`'s unprobed arm back to the 3 MB constant → the
 * unmeasured case answers 413 and goes red; the announced case stays green. The 39 MiB case is the
 * frame's: at a 32 MiB frame the request dies on the shell's frame cap.
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
const SMTP_HOST = process.env.SMTP_HOST ?? "127.0.0.1";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 3025);
const MIB = 1024 * 1024;

interface Launch { sidecar: Sidecar; host: StdioHost; client: StdioClient }
const launches: Launch[] = [];
const dirs: string[] = [];
const raw: ImapFlow[] = [];

afterEach(async () => {
  for (const l of launches.splice(0)) {
    l.client.close();
    l.host.stop();
    await l.sidecar.stop().catch(() => undefined);
  }
  for (const c of raw.splice(0)) await c.logout().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const user = (): string => `v-${randomUUID()}@trafficflow.test`;

async function launch(address: string): Promise<Launch> {
  const dataDir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-sidecar-video-"));
  dirs.push(dataDir);
  const sidecar = await createSidecar({
    dataDir,
    imap: {
      host: IMAP_HOST, port: IMAP_PORT, secure: false,
      auth: { user: address, pass: "test" },
      smtp: { host: SMTP_HOST, port: SMTP_PORT, secure: false },
    },
    address,
    displayName: "This computer",
    keks: { 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) },
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
  const l = { sidecar, host, client };
  launches.push(l);
  const res = await client.fetch(`/mailboxes/${sidecar.world.mailboxId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({ imap: { host: IMAP_HOST, port: IMAP_PORT, secure: false, user: address, pass: "test" } }),
  });
  expect(res.status).toBe(200);
  await sidecar.start();
  return l;
}

/** A video-shaped payload: not compressible to nothing, not all one byte. */
function clip(bytes: number): Buffer {
  const b = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 1) b[i] = (i * 31 + (i >> 9)) & 0xff;
  return b;
}

async function sendClip(l: Launch, to: string, bytes: Buffer): Promise<{ status: number; body: Record<string, unknown> }> {
  const auth = { authorization: `Bearer ${l.sidecar.sessionToken}`, "content-type": "application/json" };
  const draft = await l.client.fetch("/drafts", {
    method: "POST", headers: auth,
    body: JSON.stringify({ mailboxId: l.sidecar.world.mailboxId, subject: "the clip", html: "<p>here</p>", to: [{ name: null, address: to }] }),
  });
  expect(draft.status).toBe(201);
  const { id } = await draft.json() as { id: string };
  const res = await l.client.fetch(`/drafts/${id}/send`, {
    method: "POST",
    headers: { ...auth, "idempotency-key": `send-${randomUUID()}` },
    body: JSON.stringify({ attachments: [{ filename: "clip.mp4", contentType: "video/mp4", contentBase64: bytes.toString("base64") }] }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

/** The `clip.mp4` part of the newest INBOX message for `address`, decoded, or null. */
async function deliveredClip(address: string): Promise<Buffer | null> {
  const c = new ImapFlow({ host: IMAP_HOST, port: IMAP_PORT, secure: false, auth: { user: address, pass: "test" }, logger: false });
  await c.connect();
  raw.push(c);
  const lock = await c.getMailboxLock("INBOX");
  try {
    for (let i = 0; i < 40; i += 1) {
      const uids = await c.search({ subject: "the clip" }, { uid: true });
      if (Array.isArray(uids) && uids.length > 0) {
        const msg = await c.fetchOne(String(uids[uids.length - 1]), { source: true }, { uid: true });
        const src = msg && typeof msg !== "boolean" && msg.source ? msg.source.toString("latin1") : "";
        const at = src.search(/filename="?clip\.mp4"?/i);
        if (at < 0) return null;
        const bodyStart = src.indexOf("\r\n\r\n", at) + 4;
        const bodyEnd = src.indexOf("\r\n--", bodyStart);
        return Buffer.from(src.slice(bodyStart, bodyEnd).replace(/\s+/g, ""), "base64");
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  } finally {
    lock.release();
  }
}

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

describe("a 4 MB video/mp4 sends from the standalone engine", () => {
  it("to a server that announced NO size, and arrives byte for byte", async () => {
    const from = user();
    const l = await launch(from);
    const [row] = await l.sidecar.db.select().from(mailboxes).where(eq(mailboxes.id, l.sidecar.world.mailboxId));
    expect(row!.smtpMaxSizeBytes ?? null).toBeNull();

    const bytes = clip(4 * MIB);
    const sent = await sendClip(l, from, bytes);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.status).toBe("sent");
    const got = await deliveredClip(from);
    expect(got?.byteLength).toBe(bytes.byteLength);
    expect(sha(got!)).toBe(sha(bytes));
  }, 120_000);

  it("a 39 MiB video crosses the engine's frame to a server that announced 70 MiB, and arrives byte for byte", async () => {
    const from = user();
    const l = await launch(from);
    await l.sidecar.db.update(mailboxes).set({ smtpMaxSizeBytes: 70 * MIB }).where(eq(mailboxes.id, l.sidecar.world.mailboxId));
    const bytes = clip(39 * MIB);
    const sent = await sendClip(l, from, bytes);
    expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(200);
    const got = await deliveredClip(from);
    expect(got?.byteLength).toBe(bytes.byteLength);
    expect(sha(got!)).toBe(sha(bytes));
  }, 300_000);

  it("to a server that announced 25 MiB, and arrives byte for byte", async () => {
    const from = user();
    const l = await launch(from);
    await l.sidecar.db.update(mailboxes).set({ smtpMaxSizeBytes: 25 * MIB }).where(eq(mailboxes.id, l.sidecar.world.mailboxId));

    const bytes = clip(4 * MIB);
    const sent = await sendClip(l, from, bytes);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const got = await deliveredClip(from);
    expect(sha(got!)).toBe(sha(bytes));
  }, 120_000);
});
