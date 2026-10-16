import { describe, expect, it } from "vitest";

import { ImapAdapter } from "../../src/adapters/imap.js";
import { OHMAIL_FOLDERS } from "../../src/adapters/imap-types.js";
import { makeLeaseIo } from "../../src/adapters/organizer-lease.js";
import { FIXTURE_DOOR } from "./_door.js";

/**
 * LOW 4: THE PARENT-FIRST CREATE IS DAVMAIL'S ALONE. An mbox-format server (UW-IMAP, mbox Dovecot)
 * has no dual-use mailboxes: `CREATE ohmail` makes a mailbox that can hold mail and nothing else,
 * after which `CREATE ohmail/Screener` is refused, while the base child-only CREATE makes the
 * hierarchy itself (RFC 3501 §6.3.3). So every server that does not greet as DavMail keeps the
 * base sequence, and this fake refuses exactly where a parent-first CREATE would break it.
 */

const TEST_META_ID = { installId: "scope-install", mailboxId: "44444444-4444-4444-8444-444444444444" };

/** An mbox-style server: a mailbox made at a bare name holds mail only; a child under it is refused. */
function mboxServer(greeting: string) {
  const mailOnly = new Set<string>();
  const folders = new Set<string>(["INBOX"]);
  const created: string[] = [];
  const client = {
    greeting,
    capabilities: new Map<string, boolean>([["IDLE", true]]),
    mailbox: false as const,
    async list() {
      return [...folders].map((path) => ({
        path, name: path.split("/").pop()!, delimiter: "/", flags: new Set<string>(), specialUse: undefined,
      }));
    },
    async mailboxCreate(path: string) {
      created.push(path);
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
      if (parent !== null && mailOnly.has(parent)) {
        throw Object.assign(new Error("Command failed"), { response: `NO Can't create mailbox node ${path}` });
      }
      if (parent === null) mailOnly.add(path);
      folders.add(path);
      return { path };
    },
    async mailboxUnsubscribe() { return true; },
    async getMailboxLock(path: string) { return { path, release() { /* nothing held */ } }; },
    async search() { return [] as number[]; },
    fetch() { return (async function* () { /* empty */ })(); },
    async append() { return {}; },
    async messageDelete() { return true; },
    async logout() { /* nothing to tear down */ },
    close() { /* nothing to tear down */ },
  };
  return { client, created };
}

const cfg = { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } };

describe("a server that does not greet as DavMail keeps the base CREATE sequence", () => {
  it("ensureFolders on an mbox-style server: the children alone, and every one is made", async () => {
    const { client, created } = mboxServer("* OK UW-IMAP server ready");
    const adapter = new ImapAdapter(cfg, { client });
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);
    expect(created).not.toContain("ohmail");
    expect(created).toEqual(OHMAIL_FOLDERS.map((f) => adapter.toServerPath(f)));
  });

  it("the lease's own CREATE: `ohmail/_meta` alone", async () => {
    const { client, created } = mboxServer("* OK UW-IMAP server ready");
    await makeLeaseIo(client as never, (c) => c, TEST_META_ID).ensureMetaFolder();
    expect(created).toEqual(["ohmail/_meta"]);
  });

  it("CONTROL: the same server greeting as DavMail gets the parent first, at its bare name", async () => {
    const { client, created } = mboxServer("IMAP4rev1 DavMail 7.0.0-4403 server ready");
    await makeLeaseIo(client as never, (c) => c, TEST_META_ID).ensureMetaFolder().catch(() => undefined);
    expect(created[0]).toBe("ohmail");
  });
});
