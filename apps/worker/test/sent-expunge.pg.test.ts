import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { changeLog, messages } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { realPgAvailable } from "@trafficflow/db/testing";
import { MessageService, SearchService, type ServiceContext } from "@trafficflow/services";
import { runSyncCycle, type SyncDeps } from "../src/sync.js";
import { makeHarness, rawClient, uidInFolder, DB_URL } from "./_workerenv.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A SENT MESSAGE DELETED BY ANOTHER CLIENT, AGAINST A REAL SERVER.
 *
 * The off-box twin (`sent-expunge.test.ts`) drives the adapter over a recording server; this one
 * expunges over a second IMAP connection, the way another mail app deletes, and reads History,
 * Search and the change log on real Postgres. The INBOX message is the positive control.
 */

const AVAILABLE = await realPgAvailable(DB_URL);

function eml(o: { from: string; to: string; subject: string; messageId: string }): string {
  return [
    `Message-ID: <${o.messageId}>`, `From: ${o.from}`, `To: ${o.to}`, `Subject: ${o.subject}`,
    "Content-Type: text/plain; charset=utf-8", "", "the whole text of the message",
  ].join("\r\n");
}

describe.skipIf(!AVAILABLE)("a message deleted on the server leaves History and Search (GreenMail + real Postgres)", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it("a Sent reply expunged by another client is tombstoned at the next cycle, as the INBOX one is", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const deps: SyncDeps = {
      repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId,
      storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
      role: "organizer", trustedAuthservIds: new Set<string>(),
    };
    const tag = randomUUID().slice(0, 8);
    const sentId = `sent-${tag}@trafficflow.test`;
    const inboxId = `inbox-${tag}@x.example`;
    const c = await rawClient(h.cfg);
    closers.push(async () => { await c.logout().catch(() => undefined); });
    await c.mailboxCreate("Sent").catch(() => undefined);
    await c.append("Sent", eml({ from: h.cfg.auth.user, to: "anna@x.example", subject: `Re: fixture ${tag}`, messageId: sentId }), ["\\Seen"]);
    await c.append("INBOX", eml({ from: "anna@x.example", to: h.cfg.auth.user, subject: `fixture ${tag}`, messageId: inboxId }));

    await runSyncCycle(deps);
    await runSyncCycle(deps);   // the steady state: the Sent watermark is published
    const idOf = async (header: string) => (await h.db.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.mailboxId, h.mailboxId), eq(messages.messageIdHeader, header))))[0]?.id;
    const sent = await idOf(sentId);
    const inbox = await idOf(inboxId);
    expect(sent, "the precondition: the Sent reply was ingested").toBeDefined();
    expect(inbox, "the precondition: the INBOX message was ingested").toBeDefined();
    const ctx: ServiceContext = { db: h.db, accountId: h.accountId, userId: null, now: () => new Date(), requestId: "r" };
    const history = async () => (await new MessageService().list(ctx, { view: "all", limit: 50 })).items.map((m) => m.id);
    const search = async () => (await new SearchService().search(ctx, { q: tag, limit: 50 })).items.map((m) => m.id);
    expect(await history(), "the precondition: History lists both").toEqual(expect.arrayContaining([sent, inbox]));
    expect(await search(), "the precondition: Search finds the reply").toContain(sent);

    for (const [folder, id] of [["Sent", sentId], ["INBOX", inboxId]] as const) {
      const uids = await uidInFolder(c, folder, id);
      expect(uids, `the precondition: ${folder} holds the message`).toHaveLength(1);
      const l = await c.getMailboxLock(folder);
      try { await c.messageDelete(uids, { uid: true }); } finally { l.release(); }
    }
    await runSyncCycle(deps);

    const rows = await h.db.select({ id: messages.id, deletedAt: messages.deletedAt }).from(messages)
      .where(eq(messages.mailboxId, h.mailboxId));
    expect(rows.find((r) => r.id === sent)?.deletedAt, "the deleted Sent reply is still live").not.toBeNull();
    expect(rows.find((r) => r.id === inbox)?.deletedAt, "the deleted INBOX message is still live").not.toBeNull();
    expect(await history(), "History still lists a message the server no longer holds").not.toContain(sent);
    expect(await search(), "Search still finds a message the server no longer holds").not.toContain(sent);
    const deletes = (await h.db.select().from(changeLog).where(eq(changeLog.accountId, h.accountId)))
      .filter((r) => r.entityType === "message" && r.op === "delete").map((r) => r.entityId);
    expect(deletes.sort(), "a mirror is not told").toEqual([sent, inbox].sort());
  });
});
