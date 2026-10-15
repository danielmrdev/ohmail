import { describe, it, expect, afterEach } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter } from "../../src/adapters/imap.js";
import { greenmailConfig } from "./_imapenv.js";

/**
 * WHERE SENT MAIL IS FILED — and the one thing this code path must never do to a real mailbox.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────
 *
 * `resolveSentFolder()` checked SPECIAL-USE and, on a miss, went straight to
 * `mailboxCreate("Sent")`. Creating a folder is the most destructive act available on this
 * path — it puts a directory into a stranger's mailbox, next to the real one, where their own
 * mail client does not show it as Sent — and it was the FIRST fallback. Meanwhile the READ
 * path (`findSentForScan`) had had a name fallback since slice so the same adapter could
 * find `Sent Mail` to read from it and create `Sent` to write into. That asymmetry is the bug.
 *
 * ── WHAT WAS MEASURED, BECAUSE IT CHANGES WHICH CASE IS RED ─────────────────────────────
 *
 * `ListResponse.specialUse` IS NOT THE SERVER'S SPECIAL-USE FLAG. imapflow resolves it —
 * server flag when the connection advertises SPECIAL-USE or XLIST, otherwise a guess from a
 * 103-entry table of localized folder names (`imapflow/lib/special-use.js`). Measured against
 * GreenMail 2.1.3, which advertises `IDLE IMAP4rev1 LITERAL+ MOVE QUOTA SORT UIDPLUS` and no
 * SPECIAL-USE at all: a folder named `Sent Messages` came back as
 * `{ specialUse: "\\Sent", specialUseSource: "name" }`.
 *
 * So a mailbox whose Sent folder is named one of imapflow's 103 names was never going to hit
 * the create — not because this file's code was right, but because a caret-ranged dependency
 * (`"imapflow": "^1.0.164"` → 1.5.0) happened to cover it. `Sent Mail` is NOT in that table
 * and IS in the adapter's own Sent belt (`folder-roles.ts`), so it is the case that was live, and it is a real name: it is what
 * Gmail calls the folder, and what a mailbox migrated off Gmail keeps calling it.
 *
 * Both are asserted below. The `Sent Mail` cases are the regression; the `Sent Messages` cases
 * are the guarantee, held here so that an imapflow upgrade that drops or narrows the name
 * table cannot quietly hand this path back to `mailboxCreate`.
 */

/** A LIST entry as imapflow hands it over, with `specialUse` under the test's control. */
interface FakeFolder { path: string; specialUse?: string; flags?: Set<string> }

/**
 * A client that reports EXACTLY what the server said and nothing more.
 *
 * The point of the fake is to remove imapflow's name heuristic from the question: here
 * `specialUse: undefined` means the server did not flag the folder, full stop. That is the
 * contract this adapter has to satisfy on its own, and it is the contract a future imapflow
 * is free to stop satisfying for it.
 */
function makeFakeClient(folders: FakeFolder[]) {
  const created: string[] = [];
  return {
    created,
    // SPECIAL-USE advertised: a server's role attributes count only beside it (imapflow 1.5.0's test).
    capabilities: new Map<string, boolean>([["IDLE", true], ["SPECIAL-USE", true]]),
    mailbox: false as const,
    async list() {
      return folders.map((f) => ({
        path: f.path,
        name: f.path.split("/").pop()!,
        delimiter: "/",
        // A server's SPECIAL-USE attribute arrives in `flags` too; the adapter reads it there.
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

describe("resolveSentFolder — creating a folder is the LAST resort (fake client)", () => {
  it("THE REGRESSION: `Sent Messages` with NO special-use flag must not produce a `Sent` folder", async () => {
    const fake = makeFakeClient([{ path: "INBOX" }, { path: "Sent Messages" }]);
    const adapter = new ImapAdapter(cfg, { client: fake });
    await adapter.connect();

    await adapter.messageInSent("<probe@ohmail.test>");

    expect(fake.created, "a folder was created in a mailbox that already had one").toEqual([]);
    expect((await adapter.capabilities()).sentFolder).toBe("Sent Messages");
  });

  it("`Sent Mail` with no flag resolves by name — the read path's fallback, on the write path", async () => {
    const fake = makeFakeClient([{ path: "INBOX" }, { path: "Sent Mail" }]);
    const adapter = new ImapAdapter(cfg, { client: fake });
    await adapter.connect();

    await adapter.messageInSent("<probe@ohmail.test>");

    expect(fake.created).toEqual([]);
    expect((await adapter.capabilities()).sentFolder).toBe("Sent Mail");
  });

  it("`INBOX/Sent` resolves by canonical path, not by leaf name", async () => {
    // The Sent belt matches `sent` directly under the `INBOX` prefix; the adapter must feed it the
    // canonicalized path so a namespaced server is not treated as having no Sent folder.
    const fake = makeFakeClient([{ path: "INBOX" }, { path: "INBOX/Sent" }]);
    const adapter = new ImapAdapter(cfg, { client: fake });
    await adapter.connect();

    await adapter.messageInSent("<probe@ohmail.test>");

    expect(fake.created).toEqual([]);
    expect((await adapter.capabilities()).sentFolder).toBe("INBOX/Sent");
  });

  it("SPECIAL-USE wins over the name — resolved at connect, and cached", async () => {
    // Two candidates, and the flagged one is NOT the one the name rule would pick first.
    const fake = makeFakeClient([
      { path: "INBOX" },
      { path: "Sent" },
      { path: "Archive/Outgoing", specialUse: "\\Sent" },
    ]);
    const adapter = new ImapAdapter(cfg, { client: fake });
    await adapter.connect();

    await adapter.messageInSent("<probe@ohmail.test>");

    expect(fake.created).toEqual([]);
    expect((await adapter.capabilities()).sentFolder).toBe("Archive/Outgoing");
  });

  it("…and wins over the name INSIDE the resolve too, not only via `connect`", async () => {
    // `connect()` caches `sentFolder` from its own LIST, which shadows the whole method for a
    // mailbox that already had a Sent folder — so the ordering inside `resolveSentFolder` is
    // only reachable when the folder appeared afterwards. It is a real window (the user made
    // one while we were attached) and it is the one that proves the precedence is written here
    // rather than borrowed from `connect`.
    const folders: FakeFolder[] = [{ path: "INBOX" }];
    const fake = makeFakeClient(folders);
    const adapter = new ImapAdapter(cfg, { client: fake });
    await adapter.connect();
    folders.push({ path: "Sent" }, { path: "Archive/Outgoing", specialUse: "\\Sent" });

    await adapter.messageInSent("<probe@ohmail.test>");

    expect(fake.created).toEqual([]);
    expect((await adapter.capabilities()).sentFolder).toBe("Archive/Outgoing");
  });

  it("a `\\Noselect` container named Sent is not a folder to append into", async () => {
    // Appending into an unselectable node fails at APPEND time, which surfaces as a failed
    // send rather than as "this server has no Sent folder". Same filter the read path uses.
    const fake = makeFakeClient([
      { path: "INBOX" },
      { path: "Sent Messages", flags: new Set(["\\Noselect"]) },
    ]);
    const adapter = new ImapAdapter(cfg, { client: fake });
    await adapter.connect();

    await adapter.messageInSent("<probe@ohmail.test>");

    expect(fake.created).toEqual(["Sent"]);
    expect((await adapter.capabilities()).sentFolder).toBe("Sent");
  });

  it("THE LAST RESORT IS STILL THERE: a mailbox with no Sent folder gets one", async () => {
    // Deleting the create is not the fix. A send has to be filed somewhere, and a mailbox
    // that genuinely has no Sent folder is the one case where making one is the honest act.
    const fake = makeFakeClient([{ path: "INBOX" }]);
    const adapter = new ImapAdapter(cfg, { client: fake });
    await adapter.connect();

    await adapter.messageInSent("<probe@ohmail.test>");

    expect(fake.created).toEqual(["Sent"]);
    expect((await adapter.capabilities()).sentFolder).toBe("Sent");
  });

  it("a lowercase `sent` is matched by name, not shadowed by a new `Sent`", async () => {
    const fake = makeFakeClient([{ path: "INBOX" }, { path: "sent" }]);
    const adapter = new ImapAdapter(cfg, { client: fake });
    await adapter.connect();

    await adapter.messageInSent("<probe@ohmail.test>");

    expect(fake.created).toEqual([]);
    expect((await adapter.capabilities()).sentFolder).toBe("sent");
  });

  it("the last resort does not re-CREATE a name the server already has in another case", async () => {
    // Reachable only past the `\Noselect` filter, which is the point: the name rule declines
    // the folder, and the create must still see that the name is taken. The old check compared
    // the RAW server path to the literal "Sent" and would have asked for a duplicate.
    const fake = makeFakeClient([
      { path: "INBOX" },
      { path: "sent", flags: new Set(["\\Noselect"]) },
    ]);
    const adapter = new ImapAdapter(cfg, { client: fake });
    await adapter.connect();

    await adapter.messageInSent("<probe@ohmail.test>");

    expect(fake.created).toEqual([]);
  });
});

/**
 * The same question against a server that really does not advertise SPECIAL-USE.
 *
 * A fake `list()` proves what the adapter does with an answer; only a server proves what the
 * answer is. GreenMail is the one in this repo with no SPECIAL-USE, which is why the read
 * path's own test (`imap.sentscan.test.ts`) is here too.
 */
describe("resolveSentFolder — against GreenMail (no SPECIAL-USE)", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  /** Give a fresh GreenMail user one folder, then report every folder it has afterwards. */
  async function withSentNamed(name: string | null): Promise<{ resolved: string | null; paths: string[] }> {
    const cfg = greenmailConfig();

    const setup = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
    await setup.connect();
    if (name) await setup.mailboxCreate(name);
    await setup.logout();

    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    await adapter.messageInSent("<probe@ohmail.test>");
    const resolved = (await adapter.capabilities()).sentFolder;

    const after = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
    await after.connect();
    const paths = (await after.list()).map((f) => f.path).sort();
    await after.logout();

    return { resolved, paths };
  }

  it("THE REGRESSION: `Sent Mail` is used — no second folder appears in the user's mailbox", async () => {
    const { resolved, paths } = await withSentNamed("Sent Mail");
    expect(resolved).toBe("Sent Mail");
    expect(paths).toEqual(["INBOX", "Sent Mail"]);
  });

  it("`Sent Messages` — iCloud's shape — is used as-is", async () => {
    const { resolved, paths } = await withSentNamed("Sent Messages");
    expect(resolved).toBe("Sent Messages");
    expect(paths).toEqual(["INBOX", "Sent Messages"]);
  });

  it("a mailbox with no Sent folder gets exactly one, named `Sent`", async () => {
    const { resolved, paths } = await withSentNamed(null);
    expect(resolved).toBe("Sent");
    expect(paths).toEqual(["INBOX", "Sent"]);
  });
});
