import { describe, it, expect } from "vitest";
import { FOLDER_PAGE_MAX, ImapAdapter } from "../../src/adapters/imap.js";

/**
 * THE JUNK WINDOW'S SEARCH-APPEND READ — `searchFolderPage` (FOLDERS-SPEC.md §16.2's table:
 * "async search-append with a timeout"). The list read is a sequence window over the newest
 * page; this is the folder asked for the OLDER thing a person is looking for, once, bounded.
 *
 * What is pinned, each watched red under a mutation before landing (2026-08-27):
 *
 *  · ONE server-side `UID SEARCH` carrying BOTH terms (`OR FROM SUBJECT`) — the provider's own
 *    scan, one round trip — and ONE UID fetch of at most `FOLDER_PAGE_MAX` of the NEWEST hits:
 *    a folder of many hits fetches 50 UIDs and says `truncated` (mutation: fetch every hit ⇒ red on
 *    the fetch length; drop the sort ⇒ red on which 50);
 *  · read-only: nothing is created, no flag is set — the fetch is envelope/flags only;
 *  · a MISSING folder is `null` (the degrade), an EMPTY folder is a real zero-item answer, a
 *    blank query asks the server nothing (mutation: search on a blank term ⇒ red);
 *  · a TRANSPORT failure propagates so the caller can say "could not be searched" rather than
 *    "no folder" (mutation: fold it into the null branch ⇒ red).
 */

interface FakeMsg { uid: number; subject: string; from: string; date: Date }

function makeFakeClient(byFolder: Record<string, FakeMsg[]>) {
  const searches: unknown[] = [];
  const fetched: number[][] = [];
  const created: string[] = [];
  let open: string | null = null;
  const msgs = (): FakeMsg[] => byFolder[open!] ?? [];
  const client = {
    searches, fetched, created,
    usable: true,
    capabilities: new Map<string, boolean>([["IDLE", true]]),
    mailbox: false as unknown,
    async list() {
      return Object.keys(byFolder).map((path) => ({
        path, name: path.split("/").pop()!, delimiter: "/", flags: new Set<string>(),
      }));
    },
    async mailboxCreate(path: string) { created.push(path); return { path }; },
    async getMailboxLock(path: string) {
      if (!(path in byFolder)) throw new Error(`NO ${path}`);
      open = path;
      client.mailbox = { path, exists: msgs().length, uidValidity: 7n };
      return { path, release() { /* nothing */ } };
    },
    /** `OR FROM SUBJECT`, case-folded — what a real server does with the two terms. */
    async search(q: { or?: Array<{ from?: string; subject?: string }> }, _o: unknown) {
      searches.push(q);
      const terms = (q.or ?? []).map((t) => (t.from ?? t.subject ?? "").toLowerCase());
      return msgs()
        .filter((m) => terms.some((t) => t.length > 0
          && (m.subject.toLowerCase().includes(t) || m.from.toLowerCase().includes(t))))
        .map((m) => m.uid);
    },
    async *fetch(range: number[] | string, _q: unknown, _o?: unknown) {
      if (!Array.isArray(range)) throw new Error(`search fetch must be a UID list, got ${String(range)}`);
      fetched.push([...range]);
      const list = msgs();
      for (const uid of range) {
        const seq = list.findIndex((m) => m.uid === uid) + 1;
        const m = list[seq - 1];
        if (!m) continue;
        yield {
          uid: m.uid, seq,
          envelope: { subject: m.subject, from: [{ name: null, address: m.from }], date: m.date, messageId: `<mid-${m.uid}@x>` },
          flags: new Set<string>(),
          internalDate: m.date,
        };
      }
    },
    async fetchOne() { return null; },
    async logout() { /* nothing */ },
    close() { /* nothing */ },
  };
  return client;
}

const cfg = { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } };

async function adapterOver(byFolder: Record<string, FakeMsg[]>) {
  const fake = makeFakeClient(byFolder);
  const adapter = new ImapAdapter(cfg, { client: fake });
  await adapter.connect();
  return { adapter, fake };
}

const junkOf = (n: number, over: (i: number) => Partial<FakeMsg> = () => ({})): FakeMsg[] =>
  Array.from({ length: n }, (_, i) => ({
    uid: i + 1, subject: `junk ${i + 1}`, from: `s${i + 1}@example.invalid`,
    date: new Date(Date.UTC(2026, 0, 1) + (i + 1) * 60_000),
    ...over(i),
  }));

describe("searchFolderPage — the bounded, read-only search-append", () => {
  it("ONE search with both terms, ONE fetch of the newest cap — a folder with more hits than the cap answers the cap and says truncated", async () => {
    const { adapter, fake } = await adapterOver({ Junk: junkOf(300, () => ({ subject: "Lottery winner" })) });
    const page = await adapter.searchFolderPage("Junk", "lottery", { limit: 5000 });
    expect(page).not.toBeNull();
    expect(page!.items).toHaveLength(FOLDER_PAGE_MAX);
    expect(page!.truncated).toBe(true);
    expect(page!.uidValidity).toBe("7");
    // The provider was asked ONCE, with both halves of the question.
    expect(fake.searches).toHaveLength(1);
    expect(fake.searches[0]).toEqual({ or: [{ from: "lottery" }, { subject: "lottery" }] });
    // The WORK was bounded: one UID fetch naming exactly the 50 newest hits.
    expect(fake.fetched).toHaveLength(1);
    expect(fake.fetched[0]).toHaveLength(FOLDER_PAGE_MAX);
    expect(page!.items[0]!.uid).toBe(300);
    expect(page!.items.at(-1)!.uid).toBe(251);
    expect(fake.created).toEqual([]);
  });

  it("a FROM hit and a SUBJECT hit both come back, newest first, and a partial match is not truncated", async () => {
    const { adapter } = await adapterOver({
      Junk: junkOf(6, (i) => (i === 1 ? { from: "invoice@acme.invalid" } : i === 4 ? { subject: "Your ACME invoice" } : {})),
    });
    const page = await adapter.searchFolderPage("Junk", "acme");
    expect(page!.items.map((i) => i.uid)).toEqual([5, 2]);
    expect(page!.truncated).toBe(false);
    expect(page!.items[0]!.from.address).toBe("s5@example.invalid");
    expect(page!.items[1]!.from.address).toBe("invoice@acme.invalid");
  });

  it("a BLANK query asks the server nothing; an EMPTY folder answers a real zero-item page", async () => {
    const { adapter, fake } = await adapterOver({ Junk: junkOf(3), Empty: [] });
    expect(await adapter.searchFolderPage("Junk", "   ")).toEqual({ uidValidity: "7", items: [], truncated: false });
    expect(fake.searches).toEqual([]);
    expect(await adapter.searchFolderPage("Empty", "junk")).toEqual({ uidValidity: "7", items: [], truncated: false });
    expect(fake.searches).toEqual([]);
  });

  it("a MISSING folder is null (the degrade); a TRANSPORT failure propagates", async () => {
    const { adapter, fake } = await adapterOver({ Junk: junkOf(3) });
    expect(await adapter.searchFolderPage("NoSuchFolder", "junk")).toBeNull();
    fake.getMailboxLock = async (_path: string) => {
      fake.usable = false;
      throw new Error("Connection not available");
    };
    await expect(adapter.searchFolderPage("Junk", "junk")).rejects.toThrow("Connection not available");
  });
});

describe("searchFolderPage — a REFUSED search is a failure, not an empty answer", () => {
  it("imapflow answers `false` for a failed SEARCH; that propagates so the caller says unreachable", async () => {
    const { adapter, fake } = await adapterOver({ Junk: junkOf(3) });
    fake.search = async () => false as unknown as number[];
    await expect(adapter.searchFolderPage("Junk", "junk")).rejects.toThrow("refused the SEARCH");
    expect(fake.fetched).toEqual([]);
  });
});
