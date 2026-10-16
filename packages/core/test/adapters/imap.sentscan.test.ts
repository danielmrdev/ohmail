import { describe, it, expect, afterEach } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter } from "../../src/adapters/imap.js";
import { greenmailConfig } from "./_imapenv.js";

/**
 * THE SENT-FOLDER KICKSTART'S READ HALF, against a real IMAP server.
 *
 * `contacts` IS `knownSenders` (`drizzle-repo.ts`), and it starts empty — which is why a virgin
 * mailbox screened most of its seeded messages, including every reply to a thread the user
 * started. The people the user has written to are sitting in their own Sent folder on their own
 * server, and until this method nothing read them.
 *
 * Against GreenMail rather than a fake client on purpose: the two things that can go wrong here
 * are both server-shaped. GreenMail does NOT advertise SPECIAL-USE, so the name fallback is the
 * path actually exercised — and a fake `list()` would have let a broken one pass. And the scan
 * must be a pure READ: the send path's `resolveSentFolder` CREATES a `Sent` folder when it finds
 * none, and inheriting that would mean connecting a mailbox silently adds a folder to it.
 */
function sentEml(o: { to: string; cc?: string; messageId: string }): string {
  return [
    `Message-ID: <${o.messageId}>`,
    "From: owner@trafficflow.test",
    `To: ${o.to}`,
    ...(o.cc ? [`Cc: ${o.cc}`] : []),
    "Subject: a note",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "hello",
  ].join("\r\n");
}

describe("ImapAdapter.scanSentRecipients (GreenMail)", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("harvests distinct To + Cc addresses from Sent, lowercased", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();

    const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
    await c.connect();
    try { await c.mailboxCreate("Sent"); } catch { /* exists */ }
    await c.append("Sent", sentEml({ to: "Anna@Work.example", messageId: "s1@t" }));
    await c.append("Sent", sentEml({ to: "bob@work.example", cc: "carol@other.example", messageId: "s2@t" }));
    await c.append("Sent", sentEml({ to: "anna@work.example", messageId: "s3@t" }));   // a repeat
    await c.logout();

    const found = await adapter.scanSentRecipients();
    expect([...found].sort()).toEqual(["anna@work.example", "bob@work.example", "carol@other.example"]);
  });

  /**
   * A MAILBOX WITH NO SENT FOLDER IS NOT A MAILBOX TO WRITE TO. The kickstart degrades to
   * "no material" — the account still syncs, it just screens more until the user replies to
   * someone. Creating a folder in a stranger's mailbox to read zero messages out of it is not
   * a trade this product makes; `resolveSentFolder` on the SEND path does create one, and this
   * asserts the two did not get merged.
   */
  it("returns nothing — and creates nothing — when the server has no Sent folder", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();

    expect(await adapter.scanSentRecipients()).toEqual([]);

    const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
    await c.connect();
    const paths = (await c.list()).map((f) => f.path);
    await c.logout();
    expect(paths.filter((p) => /sent/i.test(p))).toEqual([]);
  });

  it("bounds the result by `limit`", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();

    const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
    await c.connect();
    try { await c.mailboxCreate("Sent"); } catch { /* exists */ }
    for (let i = 0; i < 6; i++) {
      await c.append("Sent", sentEml({ to: `p${i}@work.example`, messageId: `lim${i}@t` }));
    }
    await c.logout();

    expect(await adapter.scanSentRecipients(2)).toHaveLength(2);
  });
});
