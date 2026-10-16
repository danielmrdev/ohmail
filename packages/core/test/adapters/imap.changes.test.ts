import { describe, it, expect, afterEach } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter, parseRef } from "../../src/adapters/imap.js";
import type { ImapCursor } from "../../src/adapters/imap-types.js";
import { greenmailConfig, eml } from "./_imapenv.js";
import { FIXTURE_DOOR } from "./_door.js";

/** Direct client to seed/mutate the same GreenMail mailbox out-of-band. */
async function raw(cfg: ReturnType<typeof greenmailConfig>) {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  return c;
}
function emptyCursor(): ImapCursor {
  const folders: ImapCursor["folders"] = {};
  for (const f of ["INBOX", "ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"]) {
    folders[f] = { uidValidity: "0", uidNext: 0, highestModseq: "0", known: [] };
  }
  return { folders };
}

describe("ImapAdapter.changesSince — fallback path (GreenMail, condstore forced off)", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("initial scan yields creates; an external move is reported as a MOVE (not delete+create)", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg, { capabilityOverrides: { condstore: false } });
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);

    const c = await raw(cfg);
    await c.append("INBOX", eml({ from: "anna@x.example", subject: "one", messageId: "m1@x" }));

    // initial sync
    const b1 = await adapter.changesSince(emptyCursor());
    expect(b1.creates).toHaveLength(1);
    expect(b1.moves).toHaveLength(0);
    const created = b1.creates[0];
    expect(created.locator.folder).toBe("INBOX");
    expect(created.raw && created.raw.length).toBeGreaterThan(0);
    const uid = parseRef(created.locator.ref).uid;

    // build the next cursor from b1 (persisted part + known learned)
    const cur = emptyCursor();
    cur.folders["INBOX"] = {
      ...b1.newCursor.folders["INBOX"],
      known: [{ uid, messageId: "m1@x" }],
    };

    // external move INBOX → ohmail/News
    const lock = await c.getMailboxLock("INBOX");
    try {
      await c.messageMove([uid], "ohmail.News", { uid: true }).catch(async () => {
        await c.messageCopy([uid], "ohmail.News", { uid: true }); await c.messageDelete([uid], { uid: true });
      });
    } finally { lock.release(); }

    const b2 = await adapter.changesSince(cur);
    expect(b2.creates).toHaveLength(0);
    expect(b2.deletes).toHaveLength(0);
    expect(b2.moves).toHaveLength(1);
    expect(b2.moves[0].type).toBe("move");
    expect(b2.moves[0].locator.folder).toBe("ohmail/News");

    await c.logout();
  });

  it("UIDVALIDITY mismatch triggers a clean resync (locator refresh, no duplicate delete/create split)", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg, { capabilityOverrides: { condstore: false } });
    await adapter.connect();
    const c = await raw(cfg);
    await c.append("INBOX", eml({ from: "bob@x.example", subject: "keep", messageId: "keep@x" }));
    const b1 = await adapter.changesSince(emptyCursor());
    const uid = parseRef(b1.creates[0].locator.ref).uid;

    // stale cursor with a WRONG uidvalidity but the message still known → resync must re-pair it as a move
    const cur = emptyCursor();
    cur.folders["INBOX"] = { uidValidity: "999999", uidNext: 1, highestModseq: "0", known: [{ uid, messageId: "keep@x" }] };

    const b2 = await adapter.changesSince(cur);
    expect(b2.moves).toHaveLength(1);            // same-folder locator refresh
    expect(b2.moves[0].locator.folder).toBe("INBOX");
    expect(b2.creates).toHaveLength(0);
    expect(b2.deletes).toHaveLength(0);

    await c.logout();
  });
});
