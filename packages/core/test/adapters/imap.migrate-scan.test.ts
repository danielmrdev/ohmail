import { describe, it, expect, afterEach } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter } from "../../src/adapters/imap.js";
import { scanFoldersForMigration, type MigrationObservation } from "../../src/migrate-hey.js";
import { greenmailConfig, eml } from "./_imapenv.js";
import { FIXTURE_DOOR } from "./_door.js";

async function raw(cfg: ReturnType<typeof greenmailConfig>) {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  return c;
}

/**
 * Real-server (GreenMail) folder-scan → observations → migrated destinations.
 * Seeds an existing mailbox's placement (INBOX + user folders), scans it through
 * the ImapAdapter's FolderScanner, and asserts the canonical mapping + skips.
 */
describe("ImapAdapter folder-scan (GreenMail) → HEY migration observations", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("lists folders, samples senders, maps to canonical destinations and skips ohmail/*", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);                       // creates ohmail/* (must be SKIPPED by the scan)

    const c = await raw(cfg);
    // Existing-mailbox placement: two user folders + INBOX.
    for (const path of ["Newsletters", "Receipts"]) {
      try { await c.mailboxCreate(path); } catch { /* exists */ }
    }
    await c.append("INBOX", eml({ from: "alice@work.example", subject: "hi", messageId: "a1@work" }));
    await c.append("INBOX", eml({ from: "boss@work.example", subject: "sync", messageId: "b1@work" }));
    await c.append("Newsletters", eml({ from: "digest@news.example", subject: "weekly", messageId: "n1@news" }));
    await c.append("Receipts", eml({ from: "orders@store.example", subject: "order #1", messageId: "r1@store" }));
    // A message that must NOT be scanned (our own management folder).
    await c.append(adapter.toServerPath("ohmail/News"), eml({ from: "skip@x.example", subject: "x", messageId: "s1@x" }));
    await c.logout();

    const obs: MigrationObservation[] = await scanFoldersForMigration(adapter, { sampleLimit: 20 });
    const byMatch = new Map(obs.map((o) => [o.senderOrDomain, o]));

    expect(byMatch.get("alice@work.example")).toMatchObject({ destination: "INBOX", kind: "sender" });
    expect(byMatch.get("boss@work.example")).toMatchObject({ destination: "INBOX" });
    expect(byMatch.get("digest@news.example")).toMatchObject({ destination: "ohmail/News" });
    expect(byMatch.get("orders@store.example")).toMatchObject({ destination: "ohmail/Receipts" });
    // Our own management folder was skipped.
    expect(byMatch.has("skip@x.example")).toBe(false);
  });
});
