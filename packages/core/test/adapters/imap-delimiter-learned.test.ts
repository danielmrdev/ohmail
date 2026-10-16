import { describe, expect, it } from "vitest";
import { ImapAdapter, ImapConnectionClosedError } from "../../src/adapters/imap.js";
import { META_FOLDER } from "../../src/adapters/organizer-lease.js";

/**
 * NO SERVER PATH FROM A DELIMITER NOBODY LEARNED (IMAP-ADAPTER-UNLEARNED-DELIMITER-SILENT). The
 * adapter started at `/`, so a path built before `connect()` read as a flat server's: `ohmail/_meta`
 * unmapped, on a server that files it as `INBOX.ohmail._meta`. The delimiter is `null` until the
 * login learns it, and every translator and IO accessor refuses in the class both hosts read as a
 * connection that ended. Nothing in production reaches an accessor before `connect()`; this is the
 * door for a caller bug. Mutation watched red: the null check in the translators removed.
 */

const cfg = { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } };

function fakeClient(delimiter: string | null) {
  return {
    capabilities: new Map<string, boolean>([["IDLE", true]]),
    mailbox: false as const,
    async list() {
      return ["INBOX", "Sent"].map((path) => ({
        path, name: path, delimiter, flags: new Set<string>(), specialUse: undefined,
      }));
    },
    async logout() { /* nothing to tear down */ },
    close() { /* nothing to tear down */ },
  };
}

const identity = { installId: "i-1", mailboxId: "m-1" };

describe("the hierarchy delimiter is learned at login, never assumed", () => {
  it("refuses every translator and every IO accessor before connect() has answered", () => {
    const adapter = new ImapAdapter(cfg, { client: fakeClient(".") });
    const refusals: Record<string, unknown> = {};
    const attempts: Record<string, () => unknown> = {
      toServerPath: () => adapter.toServerPath(META_FOLDER),
      toCanonical: () => adapter.toCanonical("INBOX.ohmail._meta"),
      hierarchyDelimiter: () => adapter.hierarchyDelimiter(),
      leaseIo: () => adapter.leaseIo(identity),
      profileIo: () => adapter.profileIo(identity),
      leasePeekIo: () => adapter.leasePeekIo(),
      requestReaderIo: () => adapter.requestReaderIo(),
      requestOrganizerIo: () => adapter.requestOrganizerIo(identity),
    };
    for (const [name, attempt] of Object.entries(attempts)) {
      try { attempt(); refusals[name] = "answered"; } catch (err) { refusals[name] = err; }
    }
    for (const [name, err] of Object.entries(refusals)) {
      expect(err, `${name} answered before connect()`).toBeInstanceOf(ImapConnectionClosedError);
      expect((err as ImapConnectionClosedError).code).toBe("EIMAPCLOSED");
      expect((err as Error).message).toMatch(/connect\(\) has not completed/);
    }
  });

  it("POSITIVE CONTROL — after connect() the server's delimiter maps every path", async () => {
    const adapter = new ImapAdapter(cfg, { client: fakeClient(".") });
    await adapter.connect();
    expect(adapter.hierarchyDelimiter()).toBe(".");
    expect(adapter.toServerPath(META_FOLDER)).toBe("ohmail._meta");
    expect(adapter.toCanonical("ohmail._meta")).toBe(META_FOLDER);
    expect(() => adapter.leaseIo(identity)).not.toThrow();
    expect(() => adapter.leasePeekIo()).not.toThrow();
  });

  it("a server that names no delimiter gets `/` as a learned default, said once", async () => {
    const lines: string[] = [];
    const adapter = new ImapAdapter(cfg, { client: fakeClient(null), log: (event) => { lines.push(event); } });
    await adapter.connect();
    expect(adapter.toServerPath(META_FOLDER)).toBe(META_FOLDER);
    expect(lines).toEqual(["imap_delimiter_defaulted"]);
  });
});
