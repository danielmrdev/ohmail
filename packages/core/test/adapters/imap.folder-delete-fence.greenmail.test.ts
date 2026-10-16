import { afterEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter } from "../../src/adapters/imap.js";
import { greenmailConfig, eml } from "./_imapenv.js";
import type { ImapConfig } from "../../src/adapters/imap-types.js";
import { FIXTURE_DOOR } from "./_door.js";

/**
 * ═══ THE FOLDER DELETE'S FENCE, AGAINST A REAL MAIL SERVER ═════════════════════════════════
 *
 * The seam file next door proves the fence's arms; this one proves the PRODUCT FACT, and the
 * interleaving is real: a second IMAP connection — another mail client, as far as the server is
 * concerned — APPENDs a message into the folder after the sweep has emptied it and before the
 * delete. The message is still there afterwards, and so is its folder.
 *
 * GreenMail is an HONEST server and that is the point here: nothing about this case needs a
 * server to misbehave. Two clients and ordinary timing are enough to lose somebody's mail, which
 * is why the fence and not a comment.
 *
 * IMAP only — nothing here sends, so no SMTP port is involved; `greenmailConfig()` reads both
 * from the environment either way, and a lane runs this against its own container.
 *
 * MUTATION WATCHED RED HERE, against this server, restored from a pristine copy proved by `cmp`:
 * `deleteFolder`'s `if (now.exists > 0) return "not_empty"` → never ⇒ `Proj` is gone from the
 * server's LIST and the appended message with it.
 */

const cfg: ImapConfig = greenmailConfig();
const clients: ImapFlow[] = [];

/** A SECOND CLIENT — its own connection, which is what makes the interleaving real. */
async function otherClient(): Promise<ImapFlow> {
  const c = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false,
  });
  await c.connect();
  clients.push(c);
  return c;
}

async function countIn(c: ImapFlow, path: string): Promise<number> {
  const lock = await c.getMailboxLock(path, { readOnly: true });
  try {
    return (c.mailbox as { exists: number }).exists;
  } finally {
    lock.release();
  }
}

async function listPaths(c: ImapFlow): Promise<string[]> {
  return (await c.list()).map((f) => f.path);
}

afterEach(async () => {
  for (const c of clients.splice(0)) {
    try { await c.logout(); } catch { /* the case may have closed it */ }
  }
});

describe("[real server] the folder delete's fence", () => {
  it("a message another client files between the sweep and the check keeps itself AND its folder", async () => {
    const other = await otherClient();
    await other.mailboxCreate("Proj");
    await other.mailboxCreate("Trash");
    await other.append("Proj", eml({ from: "a@x.test", subject: "old 1", messageId: "fd-old-1@x" }));
    await other.append("Proj", eml({ from: "a@x.test", subject: "old 2", messageId: "fd-old-2@x" }));

    const a = new ImapAdapter(cfg);
    let res: string;
    await a.connect();
    try {
      const sweep = await a.moveAll("Proj", "Trash", FIXTURE_DOOR);
      expect(sweep.moved).toBe(2);
      expect(sweep.fence).toEqual({ exists: 0, modseq: null });   // GreenMail has no CONDSTORE

      // ── THE INTERLEAVING ──────────────────────────────────────────────────────────────────
      await other.append("Proj", eml({ from: "b@x.test", subject: "late", messageId: "fd-late@x" }));

      res = await a.deleteFolder("Proj", sweep.fence, FIXTURE_DOOR);
    } finally {
      await a.close?.();
    }

    // THE PRODUCT FACT FIRST, read off the SERVER by the other client and not off a return
    // value: the folder is there, the late message is in it, and the swept pair is in Trash.
    const check = await otherClient();
    expect(await listPaths(check)).toContain("Proj");
    expect(await countIn(check, "Proj")).toBe(1);
    expect(await countIn(check, "Trash")).toBe(2);
    const lock = await check.getMailboxLock("Proj", { readOnly: true });
    try {
      const found = await check.search({ header: { "message-id": "fd-late@x" } }, { uid: true });
      expect(Array.isArray(found) && found.length).toBeTruthy();
    } finally {
      lock.release();
    }
    expect(res).toBe("not_empty");
  }, 30_000);

  it("the second press: with the folder empty again, one more sweep deletes it", async () => {
    const other = await otherClient();
    await other.mailboxCreate("Later");
    await other.mailboxCreate("Bin");
    await other.append("Later", eml({ from: "a@x.test", subject: "one", messageId: "fd-2nd@x" }));

    const a = new ImapAdapter(cfg);
    await a.connect();
    try {
      const sweep = await a.moveAll("Later", "Bin", FIXTURE_DOOR);
      expect(sweep.moved).toBe(1);
      expect(await a.deleteFolder("Later", sweep.fence, FIXTURE_DOOR)).toBe("deleted");
    } finally {
      await a.close?.();
    }

    const check = await otherClient();
    expect(await listPaths(check)).not.toContain("Later");
    expect(await countIn(check, "Bin")).toBe(1);
  }, 30_000);
});
