import { describe, it, expect, afterEach } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter } from "../../src/adapters/imap.js";
import { isOrganizedFolder, type ImapCursor } from "../../src/adapters/imap-types.js";
import { greenmailConfig, eml } from "./_imapenv.js";
import { FIXTURE_DOOR } from "./_door.js";

/**
 * THE FORM OF THE FOLDER NAME THAT REACHES THE READER STAMP.
 *
 * `pipeline.ts#readerAdoption` decides an attribution by asking `isOrganizedFolder`, and that
 * predicate matches the CANONICAL, `/`-delimited spelling — `ohmail/Screener`. Servers do not all
 * use `/`: GreenMail and Dovecot expose the same mailbox as `ohmail.Screener`, and some servers
 * hang the whole namespace under `INBOX`.
 *
 * If the server's own spelling ever reached `change.locator.folder`, `isOrganizedFolder` would
 * answer FALSE for ohmail's own folders, the reader would stamp `'external'` again, and every
 * message it adopted at the gate would be frozen exactly as before — with every unit test still
 * green, because they construct canonical locators by hand. That is the failure this file exists
 * to make impossible: it goes through a real server, and it asserts the string.
 *
 * The server's own path is READ rather than assumed, and printed, so a future GreenMail that
 * changes its delimiter shows up as a changed fact rather than as a mystery.
 */
async function raw(cfg: ReturnType<typeof greenmailConfig>) {
  const c = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false,
  });
  await c.connect();
  return c;
}

const WATCHED = [
  "INBOX", "ohmail/Screener", "ohmail/News",
  "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine",
];

function emptyCursor(): ImapCursor {
  const folders: ImapCursor["folders"] = {};
  for (const f of WATCHED) folders[f] = { uidValidity: "0", uidNext: 0, highestModseq: "0", known: [] };
  return { folders };
}

describe("the folder form that reaches the reader stamp (GreenMail)", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("an arrival in the Screener is canonical `ohmail/Screener`, whatever the server calls it", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg, { capabilityOverrides: { condstore: false } });
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);

    const c = await raw(cfg);
    // The server's OWN spelling of the same mailbox — whatever delimiter and prefix it uses.
    const listed = (await c.list()).map((b) => b.path);
    const serverPath = listed.find((p) => /(^|[./])ohmail[./]Screener$/i.test(p));
    expect(serverPath, `no Screener among the server's folders: ${listed.join(", ")}`).toBeTruthy();
    // Printed so a delimiter change is a visible fact rather than an unexplained red below.
    // eslint-disable-next-line no-console
    console.log(`        server spells the Screener: ${serverPath}`);

    const messageId = `reader-form-${Date.now()}@x`;
    await c.append(serverPath!, eml({ from: "anna@x.example", subject: "at the gate", messageId }));
    await c.logout();

    const batch = await adapter.changesSince(emptyCursor());

    const create = batch.creates.find((ch) => ch.raw?.includes(messageId) === true);
    expect(create, "the appended message was not read back at all — the rest is vacuous").toBeTruthy();

    // THE ASSERTION. Exact string, not a regex and not `isOrganizedFolder` alone: the predicate
    // could be widened to accept both forms one day, and the point here is that the pipeline is
    // handed ONE form so every consumer of it can be written against ONE form.
    expect(create!.locator.folder).toBe("ohmail/Screener");
    // …and the consequence, stated where it can be read: this is the exact input `readerAdoption`
    // asks about, and the whole reader stamp turns on the answer.
    expect(isOrganizedFolder(create!.locator.folder)).toBe(true);
  });
});
