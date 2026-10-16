import { describe, expect, it } from "vitest";
import { ImapAdapter, isImapBoundExceeded } from "../../src/adapters/imap.js";

/**
 * `folderStatus` — the mailbox self-check's one server read. Over an injected client, so every
 * answer shape the driver can produce is reachable: a real STATUS, the NotFound imapflow throws for
 * a folder its LIST no longer names, a `false` on a live and on a dead socket, a reply short of a
 * counter, and a STATUS that never answers. Every case asserts the only command sent was STATUS.
 */

type StatusImpl = (path: string, query: Record<string, boolean>) => Promise<unknown>;

function fakeClient(status: StatusImpl, delimiter = "/") {
  const calls: string[] = [];
  const client = {
    calls,
    usable: true,
    closed: 0,
    capabilities: new Map<string, boolean>(),
    mailbox: false as unknown,
    async list() {
      calls.push("list");
      return [{ path: "INBOX", name: "INBOX", delimiter, flags: new Set<string>() }];
    },
    async status(path: string, query: Record<string, boolean>) {
      calls.push(`status ${path} ${Object.keys(query).sort().join(",")}`);
      return status(path, query);
    },
    async logout() { calls.push("logout"); },
    close() { client.closed += 1; client.usable = false; },
  };
  return client;
}

const cfg = { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } };

async function over(status: StatusImpl, delimiter?: string) {
  const fake = fakeClient(status, delimiter);
  const adapter = new ImapAdapter(cfg, { client: fake });
  await adapter.connect();
  fake.calls.length = 0;
  return { adapter, fake };
}

const never = (): Promise<never> => new Promise<never>(() => { /* a server that never answers */ });

describe("folderStatus — one STATUS, nothing else", () => {
  it("answers the three counters, the epoch as a string, and asks for exactly those three", async () => {
    const { adapter, fake } = await over(async () => ({ path: "INBOX", messages: 12, uidValidity: 1700000001n, uidNext: 40 }));
    expect(await adapter.folderStatus("INBOX", 1_000)).toEqual({ k: "status", messages: 12, uidValidity: "1700000001", uidNext: 40 });
    expect(fake.calls).toEqual(["status INBOX messages,uidNext,uidValidity"]);
  });

  it("addresses the server's path, not the canonical one", async () => {
    const { adapter, fake } = await over(async () => ({ messages: 0, uidValidity: 3n, uidNext: 1 }), ".");
    await adapter.folderStatus("Archive/2019", 1_000);
    expect(fake.calls).toEqual(["status Archive.2019" + " messages,uidNext,uidValidity"]);
  });

  it("a folder the server no longer has is `absent`, a refusal on a live socket `refused`", async () => {
    const gone = await over(async () => { throw Object.assign(new Error("Mailbox doesn't exist"), { code: "NotFound" }); });
    expect(await gone.adapter.folderStatus("Old", 1_000)).toEqual({ k: "absent" });
    const no = await over(async () => false);
    expect(await no.adapter.folderStatus("INBOX", 1_000)).toEqual({ k: "refused" });
  });

  it("a `false` from a socket that died under the command is `dropped`, not a refusal", async () => {
    const holder: { fake?: ReturnType<typeof fakeClient> } = {};
    const { adapter, fake } = await over(async () => { holder.fake!.usable = false; return false; });
    holder.fake = fake;
    expect(await adapter.folderStatus("INBOX", 1_000)).toEqual({ k: "dropped" });
  });

  it("a reply without MESSAGES or UIDVALIDITY is `short` — it compares nothing", async () => {
    const noCount = await over(async () => ({ uidValidity: 9n, uidNext: 3 }));
    expect(await noCount.adapter.folderStatus("INBOX", 1_000)).toEqual({ k: "short" });
    const noEpoch = await over(async () => ({ messages: 4, uidNext: 3 }));
    expect(await noEpoch.adapter.folderStatus("INBOX", 1_000)).toEqual({ k: "short" });
  });

  it("a STATUS that never answers throws the breach inside its deadline and retires the connection", async () => {
    const { adapter, fake } = await over(never);
    const started = Date.now();
    const err = await adapter.folderStatus("INBOX", 60).then(() => null, (e: unknown) => e);
    expect(isImapBoundExceeded(err)).toBe(true);
    expect(Date.now() - started).toBeLessThan(60 * 20);
    expect(fake.closed).toBeGreaterThan(0);
    // The next folder is not queued behind the hung command: it answers at once, unasked.
    const before = fake.calls.length;
    expect(await adapter.folderStatus("Archive", 60)).toEqual({ k: "dropped" });
    expect(fake.calls.length).toBe(before);
  });

  it("POSITIVE CONTROL — an answer inside the deadline is a reading, not a breach", async () => {
    const { adapter, fake } = await over(() => new Promise((ok) => setTimeout(() => ok({ messages: 1, uidValidity: 5n, uidNext: 2 }), 10)));
    expect(await adapter.folderStatus("INBOX", 500)).toMatchObject({ k: "status", messages: 1 });
    expect(fake.closed).toBe(0);
  });
});
