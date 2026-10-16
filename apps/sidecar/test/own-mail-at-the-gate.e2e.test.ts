/**
 * A STANDALONE DESKTOP NEVER HOLDS THE ACCOUNT'S OWN MAIL AT THE GATE — the phone file's twin
 * (`phone-own-mail-at-the-gate.imap.test.ts`) on the desktop's composition: `createSidecar` over
 * its own store, against a real IMAP server, consented through the local door as a person does.
 * The verdict is the folder an independent client finds the letter in; a stranger's letter is
 * the control that the gate is live. Addresses are synthetic.
 */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { folderState, messages } from "@trafficflow/db/mail";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { freshDataDir } from "./_datadir.js";

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 3025);
/* GreenMail runs with authentication disabled and makes the user at first login. */
const PASS = "test";

interface Desk { sidecar: Sidecar; lines: string[] }
const open: Sidecar[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop().catch(() => undefined);
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function withServer<T>(user: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host: IMAP_HOST, port: IMAP_PORT, secure: false, auth: { user, pass: PASS }, logger: false });
  await c.connect();
  try { return await fn(c); } finally { await c.logout().catch(() => undefined); }
}

async function deliver(user: string, from: string, subject: string, folder = "INBOX"): Promise<void> {
  const raw = [
    `From: ${from}`, `To: ${user}`, `Subject: ${subject}`,
    `Message-ID: <${randomUUID()}@own-mail.example>`, `Date: ${new Date().toUTCString()}`,
    "Content-Type: text/plain; charset=utf-8", "", `The body of ${subject}.`, "",
  ].join("\r\n");
  await withServer(user, async (c) => {
    if (folder !== "INBOX") await c.mailboxCreate(folder.split(".")).catch(() => undefined);
    await c.append(folder, Buffer.from(raw, "utf8"));
  });
}

async function folderOnServer(user: string, subject: string): Promise<string | null> {
  return withServer(user, async (c) => {
    for (const box of await c.list()) {
      if (box.flags.has("\\Noselect")) continue;
      const lock = await c.getMailboxLock(box.path);
      try {
        const hits = await c.search({ header: { subject } }, { uid: true });
        if (Array.isArray(hits) && hits.length > 0) return box.path.replace(/\./g, "/");
      } finally { lock.release(); }
    }
    return null;
  });
}

async function rowOf(d: Desk, subject: string): Promise<{ desired: string; by: string } | null> {
  const [r] = await d.sidecar.db.select({ desired: folderState.desiredFolder, by: folderState.lastSetBy })
    .from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(eq(messages.subject, subject)).limit(1);
  return r ?? null;
}

async function call(d: Desk, method: string, path: string, body?: unknown): Promise<number> {
  const res = await d.sidecar.handle(new Request(`http://local${path}`, {
    method,
    headers: { authorization: `Bearer ${d.sidecar.sessionToken}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
  await res.text();
  return res.status;
}

/** A desktop over `user`, a consent-less reader until {@link organize}. */
async function launch(user: string): Promise<Desk> {
  const dataDir = await freshDataDir("ohmail-own-mail-");
  dirs.push(dataDir);
  const lines: string[] = [];
  const sidecar = await createSidecar({
    dataDir,
    imap: {
      host: IMAP_HOST, port: IMAP_PORT, secure: false, auth: { user, pass: PASS },
      smtp: { host: IMAP_HOST, port: SMTP_PORT, secure: false },
    },
    address: user,
    machineName: "the desktop reading its own mail",
    keks: { 1: Buffer.alloc(32, 9) },
    pollIntervalMs: 60 * 60 * 1000,
    log: (event) => { lines.push(event); },
  });
  open.push(sidecar);
  await sidecar.start();
  return { sidecar, lines };
}

async function organize(d: Desk): Promise<void> {
  expect(await call(d, "POST", `/local/mailboxes/${d.sidecar.world.mailboxId}/organize`)).toBe(200);
}

/** Visits until the letter is in `folder` on the server, or the deadline; where it is. */
async function untilOnServer(d: Desk, user: string, subject: string, folder: string, deadlineMs = 90_000): Promise<string | null> {
  const t0 = Date.now();
  for (;;) {
    await d.sidecar.syncMailbox(d.sidecar.world.mailboxId, 3);
    const at = await folderOnServer(user, subject);
    if (at === folder || Date.now() - t0 >= deadlineMs) return at;
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe("a standalone desktop organizing its own mailbox, with mail from its own addresses", () => {
  it("keeps own mail from either of its mailboxes in INBOX while a stranger's goes to the Screener", async () => {
    const user = `own-desk-${randomUUID()}@trafficflow.test`;
    const other = `own-desk-other-${randomUUID()}@trafficflow.test`;
    await withServer(other, async () => undefined);
    const d = await launch(user);
    // The second own identity: another mailbox of this install, added through its own door.
    expect(await call(d, "POST", "/local/mailboxes", {
      provider: "imap", address: other,
      imap: { host: IMAP_HOST, port: IMAP_PORT, secure: false, user: other, pass: PASS },
      smtp: { host: IMAP_HOST, port: SMTP_PORT, secure: false },
    })).toBe(201);
    await organize(d);
    const own = `from myself ${randomUUID()}`;
    const ownOther = `from my other mailbox ${randomUUID()}`;
    const stranger = `from a stranger ${randomUUID()}`;
    await deliver(user, `Me <${user.toUpperCase()}>`, own);
    await deliver(user, other, ownOther);
    await deliver(user, "first.contact@stranger.example", stranger);

    expect(await untilOnServer(d, user, stranger, "ohmail/Screener"), `events ${[...new Set(d.lines)].join(", ")}`)
      .toBe("ohmail/Screener");
    for (const s of [own, ownOther]) {
      expect(await folderOnServer(user, s), JSON.stringify(await rowOf(d, s))).toBe("INBOX");
      expect((await rowOf(d, s))?.desired).toBe("INBOX");
    }
  }, 600_000);

  it("moves own mail ANOTHER organizer left in the Screener back to INBOX once it organizes", async () => {
    const user = `own-desk-${randomUUID()}@trafficflow.test`;
    const own = `left at the gate by another organizer ${randomUUID()}`;
    await deliver(user, user, own, "ohmail.Screener");
    const d = await launch(user);
    await d.sidecar.syncMailbox(d.sidecar.world.mailboxId, 3);
    expect(await rowOf(d, own), "the reader met it where the other organizer left it")
      .toEqual({ desired: "ohmail/Screener", by: "peer" });
    await organize(d);
    expect(await untilOnServer(d, user, own, "INBOX"), JSON.stringify(await rowOf(d, own))).toBe("INBOX");
  }, 600_000);
});
