import { describe, it, expect } from "vitest";
import { ImapAdapter } from "../../src/adapters/imap.js";

/**
 * NATIVE \Junk AND \Trash DISCOVERY — the write-side pair of `resolveSentFolder`'s lesson.
 *
 * The product rule (imap-types.ts, the 2026-08-22 amendment) lets exactly three user-commanded
 * writes reach the provider's own folders, and all three stand on this resolution: SPECIAL-USE
 * first, then the `JUNK_BY_NAME`/`TRASH_BY_NAME` belts on the canonical leaf, `\Noselect` and
 * the `ohmail` namespace excluded — and NOTHING IS EVER CREATED, which is the assertion that
 * distinguishes this path from Sent's create-as-last-resort: a verdict and a delete both have
 * an honest fallback (Quarantine / refusal), so `mailboxCreate` has no business here at all.
 *
 * The fake reports EXACTLY what the server said (the `imap.sentresolve.test.ts` contract):
 * `specialUse: undefined` means the server did not flag the folder, with imapflow's own
 * name-table heuristic removed from the question.
 *
 * Mutations watched (each restored, 2026-08-22):
 *  · make `resolve` fall back to `mailboxCreate` when both lookups miss ⇒ the never-create
 *    test red (`created` non-empty);
 *  · drop the `\Noselect` filter ⇒ the noselect test red (an unselectable `Spam` resolved);
 *  · drop the guess-depth rule in `folder-roles.ts` ⇒ the `Archive/Bin` arm red.
 */

interface FakeFolder { path: string; specialUse?: string; flags?: Set<string> }

interface Session { caps?: string[]; personal?: { prefix: string; delimiter: string }[] }

function makeFakeClient(folders: FakeFolder[], session: Session = {}) {
  const created: string[] = [];
  return {
    created,
    // SPECIAL-USE advertised by default: a server's role attributes count only beside it, XLIST or
    // IMAP4rev2 (imapflow 1.5.0's test). `session` replaces the capability set and adds a NAMESPACE.
    capabilities: new Map<string, boolean>((session.caps ?? ["IDLE", "SPECIAL-USE"]).map((c) => [c, true])),
    ...(session.personal ? { namespaces: { personal: session.personal } } : {}),
    mailbox: false as const,
    async list() {
      return folders.map((f) => ({
        path: f.path,
        name: f.path.split("/").pop()!,
        delimiter: "/",
        // imapflow keeps a server's SPECIAL-USE attribute in `flags` too; the adapter reads it there.
        flags: new Set([...(f.flags ?? []), ...(f.specialUse ? [f.specialUse] : [])]),
        specialUse: f.specialUse,
      }));
    },
    async mailboxCreate(path: string) { created.push(path); folders.push({ path }); return { path }; },
    async getMailboxLock(path: string) { return { path, release() {} }; },
    async search() { return [] as number[]; },
    async logout() { /* nothing to tear down */ },
    close() { /* nothing to tear down */ },
  };
}

const cfg = { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } };

async function resolved(folders: FakeFolder[], session: Session = {}) {
  const fake = makeFakeClient(folders, session);
  const adapter = new ImapAdapter(cfg, { client: fake });
  await adapter.connect();
  const found = await adapter.findSpecialFolders();
  return { found, created: fake.created };
}

describe("findSpecialFolders — native \\Junk/\\Trash, discovered and never created", () => {
  it("SPECIAL-USE wins, whatever the folders are named", async () => {
    const { found } = await resolved([
      { path: "INBOX" },
      { path: "Spamverdacht", specialUse: "\\Junk" },
      { path: "Weg damit", specialUse: "\\Trash" },
      // A name-belt candidate that must LOSE to the server's own flag.
      { path: "Junk" },
    ]);
    expect(found).toEqual({ junk: "Spamverdacht", trash: "Weg damit" });
  });

  it("the name belts carry a server that advertises nothing (the dovecot leftovers, measured)", async () => {
    const { found } = await resolved([
      { path: "INBOX" },
      { path: "INBOX/Junk" },
      { path: "INBOX/Deleted Messages" },
    ]);
    expect(found).toEqual({ junk: "INBOX/Junk", trash: "INBOX/Deleted Messages" });
  });

  it("\\Noselect is excluded — an unselectable folder cannot receive a MOVE", async () => {
    const { found } = await resolved([
      { path: "Spam", flags: new Set(["\\Noselect"]) },
      { path: "Trash", flags: new Set(["\\Noselect"]) },
    ]);
    expect(found).toEqual({ junk: null, trash: null });
  });

  it("the ohmail namespace is excluded even under a matching name", async () => {
    const { found } = await resolved([
      { path: "ohmail/Spam" },
      { path: "ohmail/Trash" },
    ]);
    expect(found).toEqual({ junk: null, trash: null });
  });

  it("`Bin` is the trash where 0.25.8's table made it one, and never inside a person's own folder", async () => {
    // imapflow 1.5.0's table named a bare `bin`, so 0.25.8 filed deletes there; the pinned table
    // keeps that. A nested `Archive/Bin` is a customer folder: no name is read below the top level.
    expect((await resolved([{ path: "INBOX" }, { path: "Bin" }])).found).toEqual({ junk: null, trash: "Bin" });
    expect((await resolved([{ path: "INBOX" }, { path: "Archive/Bin" }])).found).toEqual({ junk: null, trash: null });
  });

  it("NOTHING IS EVER CREATED — a mailbox with neither folder answers null twice and is untouched", async () => {
    const { found, created } = await resolved([{ path: "INBOX" }, { path: "Archive" }]);
    expect(found).toEqual({ junk: null, trash: null });
    expect(created).toEqual([]);
  });

  it("role attributes count with SPECIAL-USE, XLIST or IMAP4rev2, and not from a session advertising none", async () => {
    // Exchange's shape: the flags arrive in a plain LIST; 0.25.8 read names there (imapflow 1.5.0).
    const exchange: FakeFolder[] = [
      { path: "INBOX" }, { path: "Junk" }, { path: "Junk Email", specialUse: "\\Junk" },
      { path: "Trash" }, { path: "Deleted Items", specialUse: "\\Trash" },
    ];
    expect((await resolved(exchange, { caps: ["IDLE"] })).found).toEqual({ junk: "Junk", trash: "Deleted Items" });
    const flagged = { junk: "Junk Email", trash: "Deleted Items" };
    expect((await resolved(exchange, { caps: ["IDLE", "SPECIAL-USE"] })).found).toEqual(flagged);
    expect((await resolved(exchange, { caps: ["IDLE", "XLIST"] })).found).toEqual(flagged);
    expect((await resolved(exchange, { caps: ["IMAP4rev2"] })).found).toEqual(flagged);
    expect((await resolved(exchange, { caps: ["IMAP4rev1", "IMAP4rev2"] })).found).toEqual({ junk: "Junk", trash: "Deleted Items" });
  });

  it("a name is read under the server's own personal NAMESPACE prefix, not only under INBOX", async () => {
    const mail: FakeFolder[] = [{ path: "INBOX" }, { path: "Mail/Spam" }, { path: "Mail/Papierkorb" }];
    expect((await resolved(mail, { caps: ["IDLE"], personal: [{ prefix: "Mail/", delimiter: "/" }] })).found)
      .toEqual({ junk: "Mail/Spam", trash: "Mail/Papierkorb" });
    expect((await resolved(mail, { caps: ["IDLE"] })).found).toEqual({ junk: null, trash: null });
  });
});
