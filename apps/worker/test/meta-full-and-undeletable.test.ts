import { beforeEach, describe, expect, it } from "vitest";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  LeaseUnavailableError, META_ENUM_RECORDS_MAX, formatClaim, makeLeaseIo, makeRequestOrganizerIo, peekMemo, runLeaseGate,
  type LeaseSelf,
} from "@trafficflow/core/adapters/organizer-lease";
import { memoryImapServer, type MemoryImapServer } from "../../../packages/core/test/adapters/_metaworld.js";
import { shrinkMetaOnRefusal } from "../src/request-drain.js";

/**
 * A FOLDER ALREADY TOO FULL TO READ, ON A SERVER THAT TAKES NO DELETE (META-FULL-AND-UNDELETABLE-READS-
 * FULL). The gate refuses at the read, so no renew cleanup ever counts; the refused arm's sweep is
 * the only delete this install attempts. Its proven refusal now counts toward k, so after three the
 * gate's probe runs first and the folder reads `meta_undeletable` — the sentence a person can act on.
 */
const META = "INBOX.ohmail._meta";
let ID = { installId: "us", mailboxId: "mb-full-undeletable" };
const t0 = new Date("2026-10-04T10:00:00.000Z");
const DAY = 86_400_000;
const toServerPath = (c: string): string => c.replace(/\//g, ".");
/* A fresh mailbox id per case: the meta memory is in-process and keyed by (install, mailbox). */
let cases = 0;
beforeEach(() => { ID = { installId: "us", mailboxId: `mb-full-${++cases}` }; });

/** Past the ceiling: our claims from three days back, filed mail, and today's foreign renewal last. */
function fullWorld(): MemoryImapServer {
  const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
  const old = new Date(t0.getTime() - 3 * DAY);
  for (let i = 0; i < META_ENUM_RECORDS_MAX - 300; i++) server.seed(META, `Subject: filed ${i}\r\n\r\nb`, old);
  for (let i = 0; i < 300; i++) {
    const hb = new Date(old.getTime() - i * 1_000);
    server.seed(META, formatClaim({ installId: ID.installId, kind: "cloud", displayName: "Cloud", heartbeat: hb,
      claimedAt: hb, nonce: `old-${i}`, authorizedAt: null, capabilities: [] }), hb);
  }
  const now = new Date(t0.getTime() - 60_000);
  server.seed(META, formatClaim({ installId: "them", kind: "local", displayName: "Them", heartbeat: now,
    claimedAt: now, nonce: "them", authorizedAt: null, capabilities: [] }), now);
  return server;
}

async function round(server: MemoryImapServer, at: Date): Promise<string> {
  const self: LeaseSelf = { installId: ID.installId, kind: "cloud", displayName: "Cloud", lastNonce: null };
  try {
    const r = await runLeaseGate({ io: makeLeaseIo(server, toServerPath, ID), self, now: at, capabilities: [] });
    return r.verdict.verdict;
  } catch (err) {
    if (!(err instanceof LeaseUnavailableError)) throw err;
    await shrinkMetaOnRefusal(err, {
      ...ID, accountId: "acct",
      adapter: { requestOrganizerIo: (id: typeof ID) => makeRequestOrganizerIo(server, toServerPath, id) } as unknown as MailboxAdapter,
    }, at, () => {});
    return err.op;
  }
}

describe("a full folder that takes no delete reads meta_undeletable", () => {
  it("three refused sweeps on the refused arm, then the gate's probe names the delete", async () => {
    const server = fullWorld();
    server.startLyingAboutDeletes();
    const ops: string[] = [];
    for (let i = 0; i < 6; i++) ops.push(await round(server, new Date(t0.getTime() + i * 60_000)));
    expect(ops.slice(0, 3), "the folder was not refused for its size first").toEqual(Array(3).fill("meta_folder_full"));
    expect(ops.slice(3), "a full folder whose deletes fail read full for ever").toEqual(Array(3).fill("meta_undeletable"));
  }, 60_000);

  it("CONTROL: on a server that deletes, the sweep lands and the folder never reads meta_undeletable", async () => {
    const server = fullWorld();
    const ops: string[] = [];
    for (let i = 0; i < 6; i++) ops.push(await round(server, new Date(t0.getTime() + i * 60_000)));
    expect(ops).not.toContain("meta_undeletable");
    expect(server.tree.get(META)!.messages.length).toBeLessThanOrEqual(META_ENUM_RECORDS_MAX);
  }, 60_000);

  it("the delete restored: the probe lands and the folder shrinks with no press", async () => {
    const server = fullWorld();
    server.startLyingAboutDeletes();
    for (let i = 0; i < 4; i++) await round(server, new Date(t0.getTime() + i * 60_000));
    server.stopLyingAboutDeletes();
    const ops: string[] = [];
    for (let i = 4; i < 7; i++) ops.push(await round(server, new Date(t0.getTime() + i * 60_000)));
    expect(ops[0], "a landed probe still refused the gate by name").not.toBe("meta_undeletable");
    expect(server.tree.get(META)!.messages.length).toBeLessThanOrEqual(META_ENUM_RECORDS_MAX);
  }, 60_000);
});

/* LOW-3: a refused sweep batch aims the probe only at a claim of ours. */
describe("the sweep's refusal aims the probe at our own claim or nothing", () => {
  const sweepOnce = async (server: MemoryImapServer): Promise<void> => {
    await shrinkMetaOnRefusal(new LeaseUnavailableError("full", { op: "meta_folder_full" }), {
      ...ID, accountId: "acct",
      adapter: { requestOrganizerIo: (id: typeof ID) => makeRequestOrganizerIo(server, toServerPath, id) } as unknown as MailboxAdapter,
    }, t0, () => {});
  };
  const old = new Date(t0.getTime() - 3 * DAY);

  it("a batch of acks only probes nothing", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    for (let i = 0; i < 5; i++) server.seed(META, `X-Ohmail-Ack: 1\r\nSubject: ohmail ack ${i}\r\n\r\nb`, old);
    server.seed(META, "Subject: filed today\r\n\r\nb", t0);
    server.startLyingAboutDeletes();
    await sweepOnce(server);
    const memo = peekMemo(ID)?.memo;
    expect(memo?.cleanupRefusals, "the refusal was not counted").toBe(1);
    expect(memo?.undeletableUid, "the probe was aimed at an ack").toBeUndefined();
  });

  it("CONTROL: a batch holding a claim of ours aims the probe at it", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    for (let i = 0; i < 3; i++) server.seed(META, `X-Ohmail-Ack: 1\r\nSubject: ohmail ack ${i}\r\n\r\nb`, old);
    const ours = server.seed(META, formatClaim({ installId: ID.installId, kind: "cloud", displayName: "Cloud", heartbeat: old,
      claimedAt: old, nonce: "old", authorizedAt: null, capabilities: [] }), old);
    server.seed(META, "Subject: filed today\r\n\r\nb", t0);
    server.startLyingAboutDeletes();
    await sweepOnce(server);
    expect(peekMemo(ID)?.memo.undeletableUid).toBe(ours);
  });
});
