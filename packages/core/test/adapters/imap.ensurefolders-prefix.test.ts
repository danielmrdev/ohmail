import { describe, it, expect } from "vitest";
import { ImapAdapter } from "../../src/adapters/imap.js";
import { OHMAIL_FOLDERS } from "../../src/adapters/imap-types.js";
import { FIXTURE_DOOR } from "./_door.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A PREFIXED SERVER'S OWN ohmail FOLDERS ARE OURS — AND WERE INVISIBLE ON EVERY CONNECT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────────────────────
 *
 * `ensureFolders` matched `OHMAIL_FOLDERS` against the LIST by string equality —
 * `existing.has(this.toServerPath(canonical))`. On a server with a personal namespace the two
 * sides are spelled differently and always miss: Dovecot declares `INBOX.`, `ImapFlow` prepends
 * that prefix to every path LIST hands back, so the row reads `INBOX.ohmail.News` while
 * `toServerPath("ohmail/News")` is `ohmail.News`. Not one of the five was ever recognised, so
 * all five were re-CREATEd on every connection for the life of the account.
 *
 * It is the same shape as the lease's own `LEASE-PEEK-MISSES-PREFIXED-META`, and this is the
 * benign half of it: every CREATE came back "already exists" and was swallowed. Nothing broke —
 * it cost five round trips per connect and hid, which is why it needed finding rather than
 * noticing.
 *
 * ── WHY THIS IS A FAKE CLIENT AND NOT GreenMail ───────────────────────────────────────────
 *
 * The claim is about what the adapter SENDS, and the interesting server is one this suite has no
 * instance of — GreenMail is flat, so the defect is unreachable on it. The injected-client seam
 * (`imap.sentresolve.test.ts` uses it for the same reason) puts the prefixed server's LIST and
 * NAMESPACE answers under the test's control and counts the CREATEs directly.
 */

interface FakeFolder { path: string }

/**
 * A server with a personal-namespace prefix, answering the way Dovecot-through-`ImapFlow` does:
 * NAMESPACE declares `INBOX.`, and every LIST row already carries it.
 */
function prefixedClient(folders: FakeFolder[], opts: { announce?: boolean } = {}) {
  const created: string[] = [];
  const announce = opts.announce ?? true;
  return {
    created,
    capabilities: new Map<string, boolean>([["IDLE", true]]),
    mailbox: false as const,
    get namespace() {
      return announce ? { prefix: "INBOX.", delimiter: "." } : undefined;
    },
    get namespaces() {
      return announce ? { personal: [{ prefix: "INBOX.", delimiter: "." }] } : undefined;
    },
    async list() {
      return folders.map((f) => ({
        path: f.path,
        name: f.path.split(".").pop()!,
        delimiter: ".",
        flags: new Set<string>(),
        specialUse: undefined,
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

/** The five, as this server already spells them. */
const PREFIXED = OHMAIL_FOLDERS.map((f) => `INBOX.${f.replace("/", ".")}`);

describe("ensureFolders on a server with a personal-namespace prefix", () => {
  it("THE DEFECT: folders the server already lists are recognised, and nothing is re-created", async () => {
    const fake = prefixedClient([{ path: "INBOX" }, ...PREFIXED.map((path) => ({ path }))]);
    const adapter = new ImapAdapter(cfg, { client: fake });
    await adapter.connect();

    await adapter.ensureFolders(FIXTURE_DOOR);

    expect(fake.created, "every watched folder was re-CREATEd on a server that already had it")
      .toEqual([]);
  });

  it("…and on the SECOND connect too — the cost was per-connection, for ever", async () => {
    const fake = prefixedClient([{ path: "INBOX" }, ...PREFIXED.map((path) => ({ path }))]);
    const adapter = new ImapAdapter(cfg, { client: fake });
    await adapter.connect();

    await adapter.ensureFolders(FIXTURE_DOOR);
    await adapter.ensureFolders(FIXTURE_DOOR);

    expect(fake.created).toEqual([]);
  });

  it("a genuinely ABSENT folder is created at the SPELLING THE ADAPTER ADDRESSES", async () => {
    /*
     * ── THIS CASE USED TO ASSERT THE OPPOSITE, AND IT WAS WRONG ─────────────────────────
     *
     * It expected the CREATE at the resolution's own prefixed path (`INBOX.ohmail.News`), on the
     * reasoning that naming the prefix beats trusting the server to place a root-named folder.
     * Review showed what that costs: `toServerPath` is deliberately UNPREFIXED because `ImapFlow`
     * prepends the namespace prefix to everything it sends, so creating at the prefixed name made
     * the adapter write to one address and read from another.
     *
     * The assertion is therefore the RELATION and not a literal: whatever the adapter would send
     * for this folder is what it must have created. Corrected rather than deleted, because the
     * old expectation is exactly the defect and this is where somebody would come looking.
     */
    const fake = prefixedClient([{ path: "INBOX" }]);
    const adapter = new ImapAdapter(cfg, { client: fake });
    await adapter.connect();

    await adapter.ensureFolders(FIXTURE_DOOR);

    expect(fake.created).toEqual(OHMAIL_FOLDERS.map((f) => adapter.toServerPath(f)));
  });

  it("the negative control: a folder set missing ONE is created, and only that one", async () => {
    // Without this the two green cases above are indistinguishable from an `ensureFolders` that
    // creates nothing at all — which is exactly what a broken resolution returning "found" for
    // everything would look like.
    const present = PREFIXED.slice(1);
    const fake = prefixedClient([{ path: "INBOX" }, ...present.map((path) => ({ path }))]);
    const adapter = new ImapAdapter(cfg, { client: fake });
    await adapter.connect();

    await adapter.ensureFolders(FIXTURE_DOOR);

    // Same correction as the case above: the address the adapter uses, not the wire path.
    expect(fake.created).toEqual([adapter.toServerPath(OHMAIL_FOLDERS[0]!)]);
  });

  it("a server that answers no NAMESPACE still resolves, off the LIST", async () => {
    /*
     * `ImapFlow`'s NAMESPACE handler can end a connection with no namespace at all (its own
     * catch swallows a throw on a NIL personal list), so this is reachable in production and not
     * only in a fake. The derived branch accepts a prefix whose parent the server LISTS — here
     * `INBOX` — which is the same rule the lease resolution uses.
     */
    const fake = prefixedClient(
      [{ path: "INBOX" }, ...PREFIXED.map((path) => ({ path }))],
      { announce: false },
    );
    const adapter = new ImapAdapter(cfg, { client: fake });
    await adapter.connect();

    await adapter.ensureFolders(FIXTURE_DOOR);

    expect(fake.created).toEqual([]);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE ADAPTER MUST ADDRESS WHAT IT CREATED — one alphabet, and whose folder is it
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Two defects the review found in the fix above, both of which it INTRODUCED. Recorded together
 * because they are the same mistake seen from two sides: a resolution written for a READ was
 * given authority over a WRITE, and a read may be occasionally wrong in ways a create may not.
 */
describe("ensureFolders writes where the rest of the adapter reads", () => {
  /** The reviewer's client: LIST delimiter and NAMESPACE are independently controllable. */
  function client(folders: { path: string }[], announce: boolean, rowDelimiter: string | undefined) {
    const created: string[] = [];
    return {
      created,
      capabilities: new Map<string, boolean>([["IDLE", true]]),
      mailbox: false as const,
      get namespace() { return announce ? { prefix: "INBOX.", delimiter: "." } : undefined; },
      get namespaces() { return announce ? { personal: [{ prefix: "INBOX.", delimiter: "." }] } : undefined; },
      async list() {
        return folders.map((f) => ({
          path: f.path, name: f.path, delimiter: rowDelimiter,
          flags: new Set<string>(), specialUse: undefined,
        }));
      },
      async mailboxCreate(path: string) { created.push(path); folders.push({ path }); return { path }; },
      async getMailboxLock(path: string) { return { path, release() {} }; },
      async search() { return [] as number[]; },
      async logout() { /* nothing to tear down */ },
      close() { /* nothing to tear down */ },
    };
  }

  it("CREATE and the address the rest of the adapter uses are the same path", async () => {
    /*
     * ── THE DEFECT THE FIX INTRODUCED ───────────────────────────────────────────────────
     *
     * `ensureFolders` began creating at the RESOLUTION's spelling, which prefers the NAMESPACE
     * delimiter, while every other call site — move, SELECT, setFlags — addresses
     * `toServerPath(canonical)`, which took the LIST's. `metaAlphabet`'s own docstring calls the
     * disagreement "not hypothetical".
     *
     * `rowDelimiter: undefined` IS THE WHOLE TRIGGER: with a delimiter on the rows the two agree
     * and this case is green for the wrong reason. Without one the adapter's fallback was "/",
     * so it created `INBOX.ohmail.News` and then addressed `ohmail/News` — a second folder
     * tree on every connect, and every organize move landing on NONEXISTENT.
     *
     * The assertion is the RELATION, not a literal path, so it cannot go green again the moment
     * the precedence changes underneath it.
     */
    const fake = client([], true, undefined);
    const adapter = new ImapAdapter(cfg, { client: fake });
    await adapter.connect();

    await adapter.ensureFolders(FIXTURE_DOOR);

    for (const canonical of OHMAIL_FOLDERS) {
      expect(
        fake.created,
        `created a folder the adapter cannot address: it will send ${adapter.toServerPath(canonical)}`,
      ).toContain(adapter.toServerPath(canonical));
    }
  });

  it("the RESOLUTION recognises what the adapter created — no re-create on the second connect", async () => {
    /*
     * ── THE ASSERTION THAT ACTUALLY GUARDS THE ONE-ALPHABET RULE ────────────────────────
     *
     * The relation above is true by construction now that the CREATE uses `toServerPath`, so it
     * pins the create path and NOTHING about the delimiter. This is the case that does.
     *
     * `ensureFolders` writes with `toServerPath` (the adapter's alphabet) and decides existence
     * with `resolveOhmailFolder` (the resolution's). If those two disagree the adapter creates a
     * folder, fails to recognise it on the next connect, and creates it again — for ever. That is
     * the original defect, re-entered through the back door.
     *
     * `rowDelimiter: undefined` with NAMESPACE `"."` is exactly the disagreement: the adapter's
     * LIST-derived fallback is `"/"` while the resolution reads `"."` off the namespace. Reading
     * the namespace delimiter FIRST in `connect()` is what collapses them to one answer, and
     * reverting that turns this red.
     */
    const folders: { path: string }[] = [];
    const fake = client(folders, true, undefined);
    const adapter = new ImapAdapter(cfg, { client: fake });
    await adapter.connect();

    await adapter.ensureFolders(FIXTURE_DOOR);
    const afterFirst = fake.created.length;
    await adapter.ensureFolders(FIXTURE_DOOR);

    expect(afterFirst, "the first connect created nothing at all").toBe(OHMAIL_FOLDERS.length);
    expect(
      fake.created.length,
      "the second connect re-created folders it had just made — the adapter and the resolution "
      + "are spelling the same folder two different ways",
    ).toBe(afterFirst);
  });

  it("a customer's own folder ending in our name does NOT suppress the CREATE", async () => {
    /*
     * With no NAMESPACE the resolution's derived branch accepts any prefix whose parent the
     * server LISTs — so `Backup.ohmail.News` was adopted as ours and the CREATE was skipped.
     * That trade is argued and accepted for the LEASE READ, where a wrong answer is one wrong
     * answer bounded by two-matches-is-a-refusal. It does not transfer: a create that never
     * happens leaves the folder missing for the life of the account, and every later move into
     * `ohmail/News` fails NONEXISTENT.
     *
     * `AmbiguousMetaFolderError` does not rescue it — that needs two hits, and the real folder
     * is absent, so one hit is exactly the failing case.
     */
    const folders = [{ path: "INBOX" }, { path: "Backup" }, { path: "Backup.ohmail.News" }];
    const fake = client(folders, false, ".");
    const adapter = new ImapAdapter(cfg, { client: fake });
    await adapter.connect();

    await adapter.ensureFolders(FIXTURE_DOOR);

    expect(
      fake.created,
      "a customer's own Backup.ohmail.News was adopted as ours and our folder never created",
    ).toContain(adapter.toServerPath("ohmail/News"));
    // …and the customer's folder is untouched: we create our own, we never adopt or rename theirs.
    expect(fake.created).not.toContain("Backup.ohmail.News");
  });

  it("a folder under the personal root IS ours — the strict half must not create twice", async () => {
    // The other side of the rule. Without this, "create whenever the prefix is not empty" would
    // pass the case above and re-create all five on every connect, which is the original defect.
    const present = OHMAIL_FOLDERS.map((f) => `INBOX.${f.replace("/", ".")}`);
    const fake = client(
      [{ path: "INBOX" }, ...present.map((path) => ({ path }))], false, ".",
    );
    const adapter = new ImapAdapter(cfg, { client: fake });
    await adapter.connect();

    await adapter.ensureFolders(FIXTURE_DOOR);

    expect(fake.created).toEqual([]);
  });
});
