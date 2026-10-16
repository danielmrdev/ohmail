import { describe, it, expect } from "vitest";
import { ImapAdapter } from "../src/adapters/imap.js";

/**
 * `fetchByUid` RESOLVES THE SENT PATH WITHOUT RE-LISTING THE FOLDER INVENTORY.
 *
 * It used to go through `foldersToScan()`, whose LIST-STATUS arm issues a full `client.list()`
 * on EVERY call — and the junk-restore pass fetches in four-message chunks, so fifty candidates
 * in one folder paid thirteen complete folder-inventory scans to resolve a value the adapter
 * memoises for the connection's life (review round 2). The only thing `fetchByUid` ever needed
 * was the Sent path for the `ownAuthored` stamp, and `findSentForScan` answers that from its
 * memo after the first resolution.
 *
 * The pin: two targeted fetches against a LIST-STATUS server cost exactly ONE `list()` — the
 * memoising resolution — and not one per call. Mutation: put `foldersToScan()` back in
 * `fetchByUid` and this counts two.
 */
function fakeClient(opts: { sent?: boolean; serve?: number[] } = {}) {
  const state = { lists: 0 };
  const client = {
    capabilities: new Set(["LIST-STATUS"]),
    mailbox: { uidValidity: 1n },
    list: async () => {
      state.lists += 1;
      return opts.sent === false
        ? []
        : [{ path: "Sent", specialUse: "\\Sent", flags: new Set<string>(), delimiter: "/" }];
    },
    getMailboxLock: async () => ({ release: () => {} }),
    // Two-pass shape: the size probe answers first, the source fetch second. `serve` empty ⇒
    // every asked UID is `absent`.
    fetch: (_range: unknown, query: Record<string, unknown>) => (async function* () {
      for (const uid of opts.serve ?? []) {
        if (query.size) yield { uid, size: 10 };
        else yield { uid, source: Buffer.from("From: a@b\r\n\r\nx"), flags: new Set<string>() };
      }
    })(),
  };
  return { client, state };
}

describe("fetchByUid — the sent-path resolution is memoised, never a per-call LIST", () => {
  it("two targeted fetches cost one LIST, not one each", async () => {
    const adapter = new ImapAdapter({
      host: "example.invalid", port: 993, secure: true, auth: { user: "u", pass: "p" },
    });
    const { client, state } = fakeClient();
    (adapter as unknown as { delimiter: string }).delimiter = "/"; // what connect() learns on a flat server
    (adapter as unknown as { client: unknown }).client = client;

    const first = await adapter.fetchByUid("INBOX", [7]);
    expect(first.absent).toEqual([7]);
    const second = await adapter.fetchByUid("INBOX", [8]);
    expect(second.absent).toEqual([8]);

    expect(state.lists, "the folder inventory was re-listed per targeted fetch").toBe(1);
  });

  it("a NO-SENT server costs one LIST too — the negative answer is memoised behind a clock", async () => {
    // `findSentForScan` deliberately re-asks a null per SCAN cycle (a Sent folder created later
    // must start being watched). A targeted fetch has no discovery duty per call, so without its
    // own negative memo a no-Sent account paid one full inventory LIST per four-message chunk —
    // review round 3, after round 2's fix covered only the positive path.
    const adapter = new ImapAdapter({
      host: "example.invalid", port: 993, secure: true, auth: { user: "u", pass: "p" },
    });
    const { client, state } = fakeClient({ sent: false });
    (adapter as unknown as { delimiter: string }).delimiter = "/"; // what connect() learns on a flat server
    (adapter as unknown as { client: unknown }).client = client;

    const first = await adapter.fetchByUid("INBOX", [7]);
    expect(first.absent).toEqual([7]);
    const second = await adapter.fetchByUid("INBOX", [8]);
    expect(second.absent).toEqual([8]);

    expect(state.lists, "the negative Sent answer was re-asked per targeted fetch").toBe(1);
  });

  it("a positive resolution learned INSIDE the window outranks the cached negative", async () => {
    // The scan or the send path can discover/create the Sent folder while the targeted memo
    // still holds a null. A retry fetched from that folder must carry `ownAuthored` — un-stamped,
    // planChange routes the user's own outbound mail as inbound (review round 4).
    const adapter = new ImapAdapter({
      host: "example.invalid", port: 993, secure: true, auth: { user: "u", pass: "p" },
    });
    const { client } = fakeClient({ sent: false, serve: [7] });
    (adapter as unknown as { delimiter: string }).delimiter = "/"; // what connect() learns on a flat server
    (adapter as unknown as { client: unknown }).client = client;

    await adapter.fetchByUid("INBOX", [7]);   // caches the negative
    // The scan learns the Sent path mid-window (its own memo field, set without a LIST here).
    (adapter as unknown as { scanSentFolder: string | null }).scanSentFolder = "Sent";

    const out = await adapter.fetchByUid("Sent", [7]);
    expect(out.creates).toHaveLength(1);
    expect(out.creates[0]!.ownAuthored, "the cached negative masked a known Sent path").toBe(true);
  });
});
