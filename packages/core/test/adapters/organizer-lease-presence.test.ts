import { describe, expect, it } from "vitest";

import { memoryImapServer, type MemoryImapServer } from "./_metaworld.js";
import {
  CLAIM_PROTOCOL,
  META_RECORDS_MAX_PER_FETCH,
  formatAck,
  formatClaim,
  makeLeaseIo,
  makeLeasePeekIo,
  makeRequestOrganizerIo,
  readLeasePeek,
  runLeaseGate,
  type LeaseSelf,
} from "../../src/adapters/organizer-lease.js";

/**
 * The lease's three presence searches on a server that answers an empty-value HEADER term with
 * nothing, the way Infomaniak answers the settings search: the peek and the
 * election's claim set, both read only once the newest-records window is truncated, and the
 * stale-ack sweep. Each is driven over the same folder on the `rfc` double as the control, while
 * another install holds a live lease.
 */

const NOW = new Date("2026-09-04T12:00:00.000Z");
const META = "INBOX.ohmail._meta";
const toServerPath = (canonical: string): string => canonical.replace(/\//g, ".");
const ID = { installId: "test-install", mailboxId: "test-mailbox" };
const MODES = ["rfc", "empty-matches-nothing"] as const;

function self(installId = "us"): LeaseSelf {
  return { installId, kind: "cloud", displayName: "Cloud", lastNonce: null };
}

/** Another install's live claim, freshly renewed. */
function incumbentClaim(): string {
  return formatClaim({
    installId: "incumbent-install", kind: "local", displayName: "The Kitchen Mac",
    claimedAt: new Date(NOW.getTime() - 600_000), heartbeat: new Date(NOW.getTime() - 5_000),
    nonce: "incumbent-nonce", authorizedAt: new Date(NOW.getTime() - 600_000),
    capabilities: ["requests"], protocol: CLAIM_PROTOCOL,
  });
}

/** The holder's claim ON TOP of a folder past the window: the window itself sees it. */
function heldOverAFullFolder(mode: (typeof MODES)[number]): MemoryImapServer {
  const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], headerSearch: mode });
  for (let i = 0; i < META_RECORDS_MAX_PER_FETCH + 10; i++) {
    server.seed(META, `Subject: newsletter ${i}\r\n\r\nbody`);
  }
  server.seed(META, incumbentClaim());
  return server;
}

const appends = (server: MemoryImapServer): string[] =>
  server.log.filter((l) => l.startsWith(`append ${META}`));

for (const mode of MODES) {
  describe(`the lease reads a live holder on a ${mode} server`, () => {
    it("the election over a full folder stands down and appends nothing", async () => {
      const server = heldOverAFullFolder(mode);

      const res = await runLeaseGate({
        capabilities: [], io: makeLeaseIo(server, toServerPath, ID), self: self(), now: NOW,
        newNonce: () => "n-us", log: () => undefined,
      });

      expect(res.verdict.verdict, `${mode}: a live holder was read as nobody`).toBe("stand_down");
      expect(appends(server), `${mode}: a second claim was appended`).toEqual([]);
    });

    it("the peek over a full folder names the holder", async () => {
      const server = heldOverAFullFolder(mode);

      const peek = await readLeasePeek({ io: makeLeasePeekIo(server, toServerPath), now: NOW });

      expect(peek.state, `${mode}: the peek told a person nobody organizes the mailbox`).toBe("held");
      expect(peek.holders.map((h) => h.installId)).toEqual(["incumbent-install"]);
    });

    it("the ack sweep removes the stale acknowledgements and keeps the live one", async () => {
      const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], headerSearch: mode });
      const key = "k".repeat(43);
      const old = new Date(NOW.getTime() - 72 * 3_600_000);
      const ack = (id: string, at: Date): string =>
        formatAck({ requestId: id, mailboxId: ID.mailboxId, outcome: "applied", ackedAt: at, key });
      for (let i = 0; i < 3; i++) server.seed(META, ack(`stale-${i}`, old), old);
      server.seed(META, ack("live", NOW), NOW);
      const io = makeRequestOrganizerIo(server, toServerPath, ID);
      if (io.sweepStaleAcks === undefined) throw new Error("this io has no sweepStaleAcks");

      const swept = await io.sweepStaleAcks(new Date(NOW.getTime() - 24 * 3_600_000));

      expect(swept, `${mode}: the stale acknowledgements were not swept`).toBe(3);
      const left = server.tree.get(META)!.messages.map((m) => /X-Ohmail-Request-Id: (\S+)/i.exec(m.raw)?.[1]);
      expect(left, `${mode}: the live acknowledgement did not survive`).toEqual(["live"]);
    });
  });
}
