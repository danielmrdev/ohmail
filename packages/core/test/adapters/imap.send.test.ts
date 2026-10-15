import { describe, it, expect, afterEach } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter, parseRef } from "../../src/adapters/imap.js";
import { greenmailConfig, waitFor } from "./_imapenv.js";
import { FIXTURE_DOOR } from "./_door.js";

describe("ImapAdapter.send (GreenMail SMTP + \\Sent append)", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("sends over SMTP and appends the message to the Sent folder", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);

    const res = await adapter.send({
      from: cfg.auth.user, to: cfg.auth.user, subject: "hello sent",
      text: "body", messageId: "<sent1@trafficflow.test>",
    });
    expect(res.providerMessageId).toBe("<sent1@trafficflow.test>");
    // GreenMail files no submission itself, so the send appended and names where.
    expect(res.sentLocator).not.toBeNull();
    const locator = res.sentLocator!;
    expect(parseRef(locator.ref)).toBeTruthy();

    // the appended copy is searchable in the resolved Sent folder
    const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
    await c.connect();
    const sentPath = locator.folder === "INBOX" ? "INBOX" : locator.folder;
    let hits: number[] | boolean = [];
    await waitFor(async () => {
      const l = await c.getMailboxLock(sentPath.replace("/", "."));
      try { hits = await c.search({ header: { "message-id": "sent1@trafficflow.test" } }, { uid: true }); }
      finally { l.release(); }
      return Array.isArray(hits) && hits.length > 0;
    }, 8000);
    await c.logout();
    expect(Array.isArray(hits) && hits.length).toBeTruthy();
  });
});
