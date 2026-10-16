import { afterEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";

import { ImapAdapter } from "../../src/adapters/imap.js";
import {
  META_FOLDER, REQUEST_PROTOCOL, RequestUnavailableError, formatRequest,
} from "../../src/adapters/organizer-lease.js";
import { ProfileUnavailableError } from "../../src/adapters/organizer-profile.js";
import { greenmailConfig } from "./_imapenv.js";
import { FIXTURE_DOOR } from "./_door.js";

/**
 * ═══ THE EPOCH IS THE SERVER'S, AND THIS FILE ASKS THE SERVER ══════════════════════════════
 *
 * The in-memory double renumbers by adding one, which is a model of a renumbering rather than one.
 * GreenMail stamps UIDVALIDITY at MAILBOX CREATION from its own clock, so a folder deleted and
 * recreated really does get a new epoch — and the value is whatever the server chose, never
 * derived here. Measured on 2.1.3: two creations 1.2 s apart read 1789407673 and 1789407675, a
 * second-resolution stamp, so a recreation inside one second can land on the SAME number. That is
 * why the fixture reads the epoch back and keeps recreating until it has actually moved, and
 * REFUSES rather than passing if it never does: a case posed against an unchanged epoch is a case
 * that measures nothing.
 *
 * The passive folder skip is not driven here — it needs CONDSTORE and LIST-STATUS, which GreenMail
 * advertises neither of, so the fake-server file is the only place that arm can be posed.
 */

const TEST_META_ID = { installId: "us", mailboxId: "22222222-2222-4222-8222-222222222222" };
const KEY = "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk";
const NOW = new Date("2026-09-14T09:00:00.000Z");

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!().catch(() => undefined);
});

type Cfg = ReturnType<typeof greenmailConfig>;

async function rawClient(cfg: Cfg): Promise<ImapFlow> {
  const c = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false,
  });
  await c.connect();
  closers.push(() => c.logout());
  return c;
}

/** The server's own path for the meta folder, taken from its LIST rather than assembled here. */
async function metaPath(client: ImapFlow): Promise<string> {
  for (const row of await client.list()) {
    if (row.path.replace(/[./]/g, "/").toLowerCase().endsWith("ohmail/_meta")) return row.path;
  }
  throw new Error(`${META_FOLDER} is not on the server`);
}

/** The folder's UIDVALIDITY as the server states it NOW — read back, never derived. */
async function epochOnServer(client: ImapFlow, path: string): Promise<string> {
  const lock = await client.getMailboxLock(path);
  try {
    const mb = client.mailbox;
    if (!mb || mb.uidValidity == null) throw new Error(`${path} reported no UIDVALIDITY`);
    return String(mb.uidValidity);
  } finally {
    lock.release();
  }
}

/**
 * Delete and recreate the folder until the server states a DIFFERENT epoch, and refuse if it will
 * not — see the file's opening note on the second-resolution stamp.
 */
async function recreateUntilTheEpochMoves(
  client: ImapFlow, path: string, was: string,
): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await client.mailboxDelete(path).catch(() => undefined);
    await client.mailboxCreate(path);
    const now = await epochOnServer(client, path);
    if (now !== was) return now;
    await new Promise((r) => setTimeout(r, 1_100));
  }
  throw new Error(
    `${path} kept its UIDVALIDITY (${was}) across six recreations, so nothing here could be posed`,
  );
}

/**
 * Move the organizer's connection OFF the meta folder, the way the cycle does.
 *
 * Not fixture convenience: between the drain's read and its expunge the worker has been round the
 * INBOX, so `ohmail/_meta` is not the selected folder when it is replaced. Leaving it selected is
 * a state production never reaches, and GreenMail closes the connection out from under a client
 * whose selected mailbox is deleted — which would make this file measure a dropped socket.
 */
async function moveOffTheMetaFolder(adapter: ImapAdapter): Promise<void> {
  await adapter.listFolderPage("INBOX", { limit: 1 });
}

function requestRaw(requestId: string, installId: string): string {
  return formatRequest({
    protocol: REQUEST_PROTOCOL, requestId, kind: "screener.decide",
    mailboxId: TEST_META_ID.mailboxId, installId, organizerKind: "cloud", decidedAt: NOW,
    payload: { scope: "sender", decision: "yes", address: "person@example.com" },
    key: KEY,
  });
}

const profileDoc = (marker: string): string => [
  "X-Ohmail-Profile: 1",
  "X-Ohmail-Profile-Version: 1",
  `X-Ohmail-Install-Id: ${marker}`,
  "Subject: ohmail settings",
  "",
  marker,
  "",
].join("\r\n");

/** Everything the meta folder holds, as source — the only evidence this file accepts. */
async function contentsOf(client: ImapFlow, path: string): Promise<string> {
  const lock = await client.getMailboxLock(path);
  try {
    const out: string[] = [];
    for await (const m of client.fetch("1:*", { source: true })) {
      out.push(String(m.source));
    }
    return out.join("\n");
  } finally {
    lock.release();
  }
}

describe("a real server's UIDVALIDITY and the meta folder's cleanups", () => {
  it("refuses the request expunge across a real recreation, and the other install's request survives", async () => {
    const cfg = greenmailConfig();
    const adapter = new ImapAdapter(cfg);
    await adapter.connect();
    closers.push(() => adapter.close());
    await adapter.ensureFolders(FIXTURE_DOOR);
    // `ensureFolders` makes the organized five; `ohmail/_meta` is the lease and profile io's own
    // act, and it is created UNSUBSCRIBED — so it is asked for by LIST, never assembled here.
    await adapter.profileIo(TEST_META_ID).ensureMetaFolder();

    const other = await rawClient(cfg);
    const path = await metaPath(other);
    const before = await epochOnServer(other, path);

    // Our own record, and the read that names its uid under the epoch the server states now.
    await other.append(path, requestRaw("11111111-1111-4111-8111-111111111111", "us"), ["\\Seen"]);
    const io = adapter.requestOrganizerIo(TEST_META_ID);
    const records = (await io.listMetaRecords()).records;
    expect(records.length, "the read that names the refs found nothing").toBeGreaterThan(0);

    // The folder is replaced under us — the customer clearing it, a restore, a migration.
    await moveOffTheMetaFolder(adapter);
    const after = await recreateUntilTheEpochMoves(other, path, before);
    expect(after, "the server did not actually change the epoch").not.toBe(before);
    await other.append(path, requestRaw("33333333-3333-4333-8333-333333333333", "other-install"), ["\\Seen"]);

    const err = await io.remove(records.map((r) => r.ref)).then(() => null, (e: unknown) => e);
    expect(err, "a stale list was used to delete by uid on a real server")
      .toBeInstanceOf(RequestUnavailableError);

    expect(await contentsOf(other, path),
      "a reader on another computer lost the request it had pressed").toContain("other-install");
  }, 60_000);

  it("refuses the settings cleanup across a real recreation", async () => {
    const cfg = greenmailConfig();
    const adapter = new ImapAdapter(cfg);
    await adapter.connect();
    closers.push(() => adapter.close());
    await adapter.ensureFolders(FIXTURE_DOOR);
    // `ensureFolders` makes the organized five; `ohmail/_meta` is the lease and profile io's own
    // act, and it is created UNSUBSCRIBED — so it is asked for by LIST, never assembled here.
    await adapter.profileIo(TEST_META_ID).ensureMetaFolder();

    const other = await rawClient(cfg);
    const path = await metaPath(other);
    const before = await epochOnServer(other, path);

    await other.append(path, profileDoc("ours-before-the-renumber"), ["\\Seen"]);
    const io = adapter.profileIo(TEST_META_ID);
    const records = await io.listProfileMessages();
    expect(records.length, "the read that names the refs found nothing").toBeGreaterThan(0);
    // The io stamps each message with the epoch its own SELECT read, so the pair is the server's.
    expect(String(records[0]!.generation),
      "the io stamped a generation the server never stated").toBe(before);

    await moveOffTheMetaFolder(adapter);
    const after = await recreateUntilTheEpochMoves(other, path, before);
    expect(after).not.toBe(before);
    await other.append(path, profileDoc("a-stranger"), ["\\Seen"]);

    const err = await io.removeProfiles(records.map((r) => r.ref))
      .then(() => null, (e: unknown) => e);
    expect(err, "a stale list was used to delete by uid on a real server")
      .toBeInstanceOf(ProfileUnavailableError);

    expect(await contentsOf(other, path),
      "a stranger's settings document was expunged by uid coincidence").toContain("a-stranger");
  }, 60_000);

  /**
   * THE POSITIVE CONTROL, and it is the reason the two refusals above are evidence: on a folder
   * nothing happened to, the same call removes what it read. Without it a refusal that fired
   * always would look identical.
   */
  it("still expunges what it read when the real folder was not touched", async () => {
    const cfg = greenmailConfig();
    const adapter = new ImapAdapter(cfg);
    await adapter.connect();
    closers.push(() => adapter.close());
    await adapter.ensureFolders(FIXTURE_DOOR);
    // `ensureFolders` makes the organized five; `ohmail/_meta` is the lease and profile io's own
    // act, and it is created UNSUBSCRIBED — so it is asked for by LIST, never assembled here.
    await adapter.profileIo(TEST_META_ID).ensureMetaFolder();

    const other = await rawClient(cfg);
    const path = await metaPath(other);
    await other.append(path, requestRaw("11111111-1111-4111-8111-111111111111", "us"), ["\\Seen"]);

    const io = adapter.requestOrganizerIo(TEST_META_ID);
    const records = (await io.listMetaRecords()).records;
    await expect(io.remove(records.map((r) => r.ref))).resolves.toBeUndefined();
    expect(await contentsOf(other, path), "the refusal fires on an untouched folder").toBe("");
  }, 60_000);
});
