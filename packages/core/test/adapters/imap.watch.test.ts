import { describe, it, expect, afterEach } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter } from "../../src/adapters/imap.js";
import { greenmailConfig, eml, waitFor } from "./_imapenv.js";

describe("ImapAdapter.watch (GreenMail IDLE)", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("fires onSignal when a new message arrives in INBOX", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();

    let fired = 0;
    const stop = await adapter.watch(() => { fired += 1; });

    // deliver a message via a second connection
    const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
    await c.connect();
    await c.append("INBOX", eml({ from: "ping@x.example", subject: "idle", messageId: "idle1@x" }));
    await c.logout();

    await waitFor(() => fired > 0, 28000);
    expect(fired).toBeGreaterThan(0);
    await stop();
  }, 32000);
});
