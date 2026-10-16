import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { eq, isNull } from "drizzle-orm";
import { mailboxes, messageInstances, messages } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE DESKTOP DOOR: A LETTER DELETED WHILE THE APP WAS CLOSED IS GONE AFTER THE NEXT LAUNCH.
 *
 * Reported on a desktop reader: a letter to oneself, deleted in another mail app while
 * ohmail was stopped, was still listed and found after relaunch. The engine as the shell runs it,
 * on one data directory across two launches, over GreenMail. Mutation: enumerate Sent from the
 * watermark again (`imap.ts`, `enumFloorUid = watermark`) and the letter stays on both roles.
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);

function eml(o: { messageId: string; from: string; to: string; subject: string }): string {
  return [
    `Message-ID: <${o.messageId}>`, `From: ${o.from}`, `To: ${o.to}`, `Subject: ${o.subject}`,
    "Date: Sat, 26 Sep 2026 22:13:00 +0000", "Content-Type: text/plain; charset=utf-8", "", "the letter",
  ].join("\r\n");
}

async function uidOf(c: ImapFlow, path: string, messageId: string): Promise<number> {
  const l = await c.getMailboxLock(path);
  try {
    const r = await c.search({ header: { "message-id": messageId } }, { uid: true });
    return Array.isArray(r) && r.length ? r[0]! : 0;
  } finally { l.release(); }
}
/** The folder another mail app finds the letter in: INBOX, or the pile the organizer filed it to. */
async function whereIs(c: ImapFlow, messageId: string): Promise<string> {
  for (const p of ["INBOX", "ohmail.Screener"]) if (await uidOf(c, p, messageId) > 0) return p;
  throw new Error(`${messageId} is on no folder the test reads`);
}
async function expungeIn(c: ImapFlow, path: string, messageId: string): Promise<void> {
  const uid = await uidOf(c, path, messageId);
  expect(uid, `${messageId} is in ${path} before the delete`).toBeGreaterThan(0);
  const l = await c.getMailboxLock(path);
  try { await c.messageDelete([uid], { uid: true }); } finally { l.release(); }
}

const open: Sidecar[] = [];
const dirs: string[] = [];
const clients: ImapFlow[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop().catch(() => undefined);
  for (const c of clients.splice(0)) await c.logout().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the desktop door: a letter deleted while the app was closed", () => {
  for (const role of ["reader", "organizer"] as const) {
    it(`${role}: gone from the store and from search after the next launch`, async () => {
      const cfg = {
        host: IMAP_HOST, port: IMAP_PORT, secure: false as const,
        auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: "test" },
      };
      const me = cfg.auth.user;
      const c = new ImapFlow({ ...cfg, logger: false });
      await c.connect();
      clients.push(c);
      for (const p of ["Sent", "Trash"]) await c.mailboxCreate(p).catch(() => undefined);
      await c.append("INBOX", eml({ messageId: "gone@x", from: "anna@x.example", to: me, subject: "r8 deleted in the inbox" }));
      await c.append("INBOX", eml({ messageId: "stays@x", from: "anna@x.example", to: me, subject: "r8 still on the server" }));
      await c.append("INBOX", eml({ messageId: "self@x", from: me, to: me, subject: "r8 a letter to myself" }));
      await c.append("Sent", eml({ messageId: "self@x", from: me, to: me, subject: "r8 a letter to myself" }), ["\\Seen"]);

      const dataDir = await freshDataDir("ohmail-deleted-while-closed-");
      dirs.push(dataDir);
      const keks = { 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) };
      const launch = async (): Promise<Sidecar> => {
        const s = await createSidecar({
          dataDir, imap: cfg, address: me, displayName: "This Mac", keks, pollIntervalMs: 60 * 60 * 1000,
        });
        open.push(s);
        if (role === "organizer") await grantOrganizeConsent(s);
        await s.start();
        await s.syncUntilQuiet();
        return s;
      };
      const rowOf = async (s: Sidecar, header: string) => (await s.db.select({ id: messages.id, deletedAt: messages.deletedAt })
        .from(messages).where(eq(messages.messageIdHeader, header)))[0];
      const searched = async (s: Sidecar): Promise<string[]> => {
        const res = await s.handle(new Request("http://sidecar/search?q=r8", {
          headers: { authorization: `Bearer ${s.sessionToken}` },
        }));
        expect(res.status).toBe(200);
        return ((await res.json()) as { items: Array<{ id: string }> }).items.map((i) => i.id);
      };

      const first = await launch();
      const [mb] = await first.db.select({ role: mailboxes.organizerRole }).from(mailboxes);
      expect(mb?.role, "the precondition: the install runs in the role under test").toBe(role);
      const self = (await rowOf(first, "self@x"))!;
      const selfFolders = (await first.db.select({ f: messageInstances.folder }).from(messageInstances)
        .where(eq(messageInstances.messageId, self.id))).map((r) => r.f).sort();
      expect(selfFolders, "the precondition: one row held in INBOX and in Sent").toEqual(["INBOX", "Sent"]);
      const gone = (await rowOf(first, "gone@x"))!.id;
      expect(await searched(first)).toEqual(expect.arrayContaining([self.id, gone]));
      await first.stop();
      open.splice(open.indexOf(first), 1);

      await expungeIn(c, await whereIs(c, "gone@x"), "gone@x");
      await expungeIn(c, await whereIs(c, "self@x"), "self@x");
      await expungeIn(c, "Sent", "self@x");

      const second = await launch();
      expect((await rowOf(second, "self@x"))!.deletedAt, "the letter to myself is still live").not.toBeNull();
      expect((await rowOf(second, "gone@x"))!.deletedAt, "the deleted letter is still live").not.toBeNull();
      const after = await searched(second);
      expect(after, "search still finds the letter to myself").not.toContain(self.id);
      expect(after, "search still finds the deleted letter").not.toContain(gone);
      const live = await second.db.select({ h: messages.messageIdHeader }).from(messages)
        .where(isNull(messages.deletedAt));
      expect(live.map((r) => r.h), "a letter still on the server was taken").toEqual(["stays@x"]);
    }, 180_000);
  }
});
