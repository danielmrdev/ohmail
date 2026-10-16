import { describe, it, expect, afterEach } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter, MessageGoneError } from "../../src/adapters/imap.js";
import { greenmailConfig, seedInbox } from "./_imapenv.js";
import { FIXTURE_DOOR } from "./_door.js";

/**
 * `ImapAdapter.setFlags` — read-state actually reaching the user's server.
 *
 * Against GREENMAIL, not a fake client, and the reason is the claim being tested. A fake would
 * only prove that we call `messageFlagsAdd` with the arguments we decided to call it with; what
 * has to be true is that a real IMAP server afterwards REPORTS `\Seen` on that message, because
 * that flag is what every other mail client the user owns reads, and what survives them leaving
 * ohmail entirely (the project's design notes §6.A). The assertions below therefore re-read the
 * flags over an independent connection.
 */
async function raw(cfg: ReturnType<typeof greenmailConfig>): Promise<ImapFlow> {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  return c;
}

/** The flags a SECOND connection sees on `uid` — the server's own answer, not ours. */
async function flagsOf(cfg: ReturnType<typeof greenmailConfig>, uid: number): Promise<string[]> {
  const c = await raw(cfg);
  const lock = await c.getMailboxLock("INBOX");
  try {
    const one = await c.fetchOne(String(uid), { uid: true, flags: true }, { uid: true });
    return one && one.flags ? [...one.flags] : [];
  } finally {
    lock.release();
    await c.logout();
  }
}

describe("ImapAdapter.setFlags (GreenMail)", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("sets \\Seen on the real server, and clears it again", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);
    const src = await seedInbox(cfg, "flag1@x");
    expect(await flagsOf(cfg, src.uid)).not.toContain("\\Seen");

    await adapter.setFlags({ folder: "INBOX", ref: src.ref }, { seen: true }, FIXTURE_DOOR);
    expect(await flagsOf(cfg, src.uid)).toContain("\\Seen");

    // Marking unread again is the same method with the other value — this is what `u` does, and
    // what a reconcile of a `desired_seen = false` row performs.
    await adapter.setFlags({ folder: "INBOX", ref: src.ref }, { seen: false }, FIXTURE_DOOR);
    expect(await flagsOf(cfg, src.uid)).not.toContain("\\Seen");
  });

  it("is IDEMPOTENT — re-issuing the same write after a crash is free and harmless", async () => {
    // The reconciler writes `observed_seen` AFTER the STORE, so a crash between the two replays
    // this call on the next cycle. That has to be a no-op rather than an error.
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);
    const src = await seedInbox(cfg, "flag2@x");

    await adapter.setFlags({ folder: "INBOX", ref: src.ref }, { seen: true }, FIXTURE_DOOR);
    await adapter.setFlags({ folder: "INBOX", ref: src.ref }, { seen: true }, FIXTURE_DOOR);
    expect(await flagsOf(cfg, src.uid)).toContain("\\Seen");
  });

  it("leaves the message's OTHER flags alone", async () => {
    // `{ seen }` and not a flag bag: this method must be incapable of touching `\Deleted` or
    // `\Answered` in somebody's real mailbox.
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);
    const src = await seedInbox(cfg, "flag3@x");

    const c = await raw(cfg);
    const lock = await c.getMailboxLock("INBOX");
    try { await c.messageFlagsAdd([src.uid], ["\\Flagged"], { uid: true }); }
    finally { lock.release(); await c.logout(); }

    await adapter.setFlags({ folder: "INBOX", ref: src.ref }, { seen: true }, FIXTURE_DOOR);
    const flags = await flagsOf(cfg, src.uid);
    expect(flags).toContain("\\Seen");
    expect(flags, "an unrelated flag the user set must survive").toContain("\\Flagged");
  });

  it("a UID that no longer exists raises MessageGoneError, not a silent success", async () => {
    // The reconciler's skip-and-retry branch keys on this. A silent success would flip
    // `observed_seen` to a value the server never confirmed, and the row would read as converged
    // for a message that was never touched.
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);
    const src = await seedInbox(cfg, "flag4@x");

    /* THE EPOCH IS THE SERVER'S AND THE UID IS THE MISSING ONE — the pair matters. This read
     * `"1:999999"`, which raised MessageGoneError for the WRONG reason on any real server: the
     * fabricated `1` contradicts GreenMail's own UIDVALIDITY, so `assertLocatorEpoch` refused it
     * before the UID was ever looked up, and the "no such message" branch this case is named for
     * was never reached. Same error, same green, different code path. */
    await expect(adapter.setFlags({ folder: "INBOX", ref: `${src.uidValidity}:999999` }, { seen: true }, FIXTURE_DOOR))
      .rejects.toBeInstanceOf(MessageGoneError);
  });
});
