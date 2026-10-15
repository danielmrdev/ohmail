import { describe, it, expect, afterEach } from "vitest";
import { ImapAdapter } from "../../src/adapters/imap.js";
import { greenmailConfig } from "./_imapenv.js";
import { FIXTURE_DOOR } from "./_door.js";

describe("ImapAdapter capabilities + ensureFolders (GreenMail)", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("connects, reports capabilities, and creates the ohmail/* folders idempotently", async () => {
    adapter = new ImapAdapter(greenmailConfig());
    await adapter.connect();

    const caps = await adapter.capabilities();
    expect(typeof caps.move).toBe("boolean");
    expect(typeof caps.uidplus).toBe("boolean");
    expect(typeof caps.idle).toBe("boolean");

    await adapter.ensureFolders(FIXTURE_DOOR);
    await adapter.ensureFolders(FIXTURE_DOOR); // idempotent — second call must not throw

    // capabilityOverrides win, proving the fallback path can be forced in later tasks
    const forced = new ImapAdapter(greenmailConfig(), { capabilityOverrides: { condstore: false, move: false } });
    await forced.connect();
    const c2 = await forced.capabilities();
    expect(c2.condstore).toBe(false);
    expect(c2.move).toBe(false);
    await forced.close();
  });
});
