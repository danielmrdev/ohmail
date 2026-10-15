import { beforeEach, describe, expect, it } from "vitest";

import { memoryImapServer, type MemoryImapServer } from "./_metaworld.js";
import { claimRaw, FIXTURE_KEY, FIXTURE_MAILBOX, settingsRaw } from "./_lease-fixtures.js";
import { resetMetaMemos } from "../../src/adapters/meta-memo.js";
import {
  META_ENUM_RECORDS_MAX, formatAck, formatRequest, makeRequestOrganizerIo,
} from "../../src/adapters/organizer-lease.js";

/**
 * THE SWEEP TAKES OUR OWN CLAIMS OLDER THAN A DAY (META-SHRINK-AHEAD-OF-THE-GATE). Same walk as the
 * stale acks, by INTERNALDATE: a claim of this install's a day old is residue whoever wrote it. It
 * never takes another install's claim, a request, the settings document, mail with no ohmail
 * discriminator, or a claim of ours younger than the cutoff.
 */

const META = "INBOX.ohmail._meta";
const NOW = new Date("2026-10-04T10:00:00.000Z");
const DAY = 24 * 3_600_000;
const back = (ms: number): Date => new Date(NOW.getTime() - ms);
const toServerPath = (c: string): string => c.replace(/\//g, ".");

beforeEach(() => { resetMetaMemos(); });

function seeded(): { server: MemoryImapServer; swept: number[]; kept: Map<number, string> } {
  const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
  const swept: number[] = [];
  const kept = new Map<number, string>();
  const keep = (raw: string, at: Date): void => { kept.set(server.seed(META, raw, at), raw); };
  keep(claimRaw({ installId: "them", heartbeat: back(3 * DAY), nonce: "them-old" }), back(3 * DAY));
  keep(claimRaw({ installId: "them", heartbeat: back(5_000), nonce: "them-live" }), back(5_000));
  keep(settingsRaw(1, "us", back(4 * DAY)), back(4 * DAY));
  keep(formatRequest({
    requestId: "00000000-0000-4000-8000-000000000001", kind: "profile.update", mailboxId: FIXTURE_MAILBOX,
    installId: "us", organizerKind: "cloud", decidedAt: back(3 * DAY), key: FIXTURE_KEY, payload: {},
  }), back(3 * DAY));
  keep("Subject: a newsletter filed here\r\nX-Ohmail-Install-Id: us\r\n\r\nbody", back(9 * DAY));
  for (let i = 0; i < 3; i++) {
    swept.push(server.seed(META, claimRaw({ installId: "us", heartbeat: back(2 * DAY + i), nonce: `us-${i}` }), back(2 * DAY + i)));
  }
  swept.push(server.seed(META, formatAck({
    requestId: "00000000-0000-4000-8000-000000000002", mailboxId: FIXTURE_MAILBOX, outcome: "applied",
    ackedAt: back(3 * DAY), key: FIXTURE_KEY,
  }), back(3 * DAY)));
  keep(claimRaw({ installId: "us", heartbeat: back(30_000), nonce: "us-live" }), back(30_000));
  keep(claimRaw({ installId: "us", heartbeat: back(6 * 3_600_000), nonce: "us-hours" }), back(6 * 3_600_000));
  return { server, swept, kept };
}

const byUid = (s: MemoryImapServer): Map<number, string> =>
  new Map(s.tree.get(META)!.messages.map((m) => [m.uid, m.raw]));

describe("the sweep shrinks _meta by our own day-old claims", () => {
  it("takes our stale claims and the stale ack, and leaves everything else byte-identical", async () => {
    const { server, swept, kept } = seeded();
    const io = makeRequestOrganizerIo(server, toServerPath, { installId: "us", mailboxId: "mb" });
    expect(await io.sweepStaleAcks!(back(DAY))).toBe(swept.length);
    const after = byUid(server);
    for (const uid of swept) expect(after.has(uid), `uid ${uid} survived the sweep`).toBe(false);
    for (const [uid, raw] of kept) expect(after.get(uid), `uid ${uid} was touched`).toBe(raw);
  });

  it("another install's sweep takes none of our claims", async () => {
    const { server, kept, swept } = seeded();
    const io = makeRequestOrganizerIo(server, toServerPath, { installId: "someone-else", mailboxId: "mb" });
    expect(await io.sweepStaleAcks!(back(DAY)), "only the stale ack is everybody's").toBe(1);
    expect(byUid(server).size).toBe(kept.size + swept.length - 1);
  });

  it("a folder past the read ceiling falls by a thousand records a pass", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    for (let i = 0; i < META_ENUM_RECORDS_MAX - 1_199; i++) server.seed(META, `Subject: filed ${i}\r\n\r\nb`, back(9 * DAY));
    for (let i = 0; i < 1_200; i++) {
      server.seed(META, claimRaw({ installId: "us", heartbeat: back(2 * DAY + i), nonce: `us-${i}` }), back(2 * DAY + i));
    }
    expect(server.tree.get(META)!.messages.length).toBe(META_ENUM_RECORDS_MAX + 1);
    const io = makeRequestOrganizerIo(server, toServerPath, { installId: "us", mailboxId: "mb" });
    expect(await io.sweepStaleAcks!(back(DAY))).toBe(1_000);
    expect(server.tree.get(META)!.messages.length).toBeLessThanOrEqual(META_ENUM_RECORDS_MAX);
  }, 60_000);
});
