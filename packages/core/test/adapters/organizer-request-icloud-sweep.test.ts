import { describe, expect, it } from "vitest";

import { memoryImapServer } from "./_metaworld.js";
import { foreign600 } from "./_lease-fixtures.js";

import {
  RequestUnavailableError,
  formatAck,
  makeRequestOrganizerIo,
  type LeaseImapClient,
  type RequestOrganizerIo,
} from "@trafficflow/core/adapters/organizer-lease";

/**
 * A PROVIDER THAT REFUSES THE COMPOUND SEARCH IS STILL SWEPT. Measured on two production iCloud
 * mailboxes, 2026-09-16: `meta_ack_sweep_failed` logged over and over, and hardly a sweep or
 * compaction all day. iCloud refuses `HEADER X-Ohmail-Ack "" BEFORE <date> UID lo:hi` and
 * imapflow resolves `false`; a blind server answers it with nothing. The sweep now reads its uid
 * windows by FETCH on every provider (FIX-026, L15), so neither answer can stop the one thing that
 * makes `ohmail/_meta` smaller.
 */
const META = "INBOX.ohmail._meta";
const sweepPath = (canonical: string): string => canonical.replace(/\//g, ".");
const NOW = new Date("2026-09-16T09:00:00.000Z");
const KEY = "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk";
const IDENTITY = { installId: "test-install", mailboxId: "test-mailbox" };
const CUTOFF = new Date(NOW.getTime() - 24 * 3_600_000);
const OLD = new Date(NOW.getTime() - 72 * 3_600_000);

function ackRaw(id: string): string {
  return formatAck({
    requestId: id, mailboxId: IDENTITY.mailboxId, outcome: "applied", ackedAt: NOW, key: KEY,
  });
}

/**
 * `sweepStaleAcks` is optional on the interface and always present on this io — narrowed once, so
 * a case that drives a REFUSAL reads as a refusal rather than as a missing method.
 */
function sweepOf(io: RequestOrganizerIo): (before: Date) => Promise<number> {
  const sweep = io.sweepStaleAcks;
  if (sweep === undefined) throw new Error("this io has no sweepStaleAcks");
  return async (before) => sweep.call(io, before);
}

/** A server whose SEARCH resolves `false` — iCloud's answer, not a rejection. */
function refusesSearch(server: LeaseImapClient): LeaseImapClient {
  return { ...server, async search(): Promise<false> { return false; } };
}

describe("the ack sweep on a server that refuses the compound search", () => {
  it("still removes the stale acknowledgements", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    for (let i = 0; i < 12; i++) server.seed(META, ackRaw(`a-${i}`), OLD);
    const client = refusesSearch(server);

    const swept = await sweepOf(makeRequestOrganizerIo(client, sweepPath, IDENTITY))(CUTOFF);

    expect(swept, "a refused search left the folder exactly as full as it was").toBe(12);
    expect(server.tree.get(META)?.messages.length, "the records are still in the folder").toBe(0);
  });

  /**
   * ONE SET WHATEVER THE SERVER'S SEARCH DOES: header presence of `1` (the set `HEADER <name> ""`
   * reached) and an INTERNALDATE below a cutoff floored to midnight, and nothing else — so a sweep
   * covers the same records on every provider. (Was: the compound form and its fallback agree.)
   */
  it("removes the same records on a server that answers SEARCH and one that refuses it", async () => {
    const seed = (server: ReturnType<typeof memoryImapServer>): void => {
      server.seed(META, ackRaw("stale-1"), OLD);
      server.seed(META, ackRaw("stale-2"), OLD);
      // Fresh: inside the cutoff, so no sweep may take it.
      server.seed(META, ackRaw("fresh"), NOW);
      // Not an ack at all: no discriminator, so no sweep may take it.
      server.seed(META, "Subject: somebody else's note\r\n\r\nnot ours", OLD);
    };
    const accepting = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const refusing = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    seed(accepting);
    seed(refusing);

    const onAccepting = await sweepOf(makeRequestOrganizerIo(accepting, sweepPath, IDENTITY))(CUTOFF);
    const onRefusing = await sweepOf(makeRequestOrganizerIo(refusesSearch(refusing), sweepPath, IDENTITY))(CUTOFF);

    expect(onAccepting, "the two stale records were not taken").toBe(2);
    expect(onRefusing, "a refused SEARCH changed what the sweep covers").toBe(onAccepting);
    const left = (s: ReturnType<typeof memoryImapServer>): string[] =>
      (s.tree.get(META)?.messages ?? []).map((m) => m.raw.slice(0, 40));
    expect(left(refusing), "the two servers were left holding different folders").toEqual(left(accepting));
  });

  /**
   * L15: A BLIND SERVER IS SWEPT. The ruling's fixture carries acks past their life among other
   * records; a server whose header SEARCH answers nothing gave the SEARCH form an empty window,
   * read as "none stale", with no log line. By FETCH the 100 go, and only they. The refused shape
   * stays green beside it, and no mode issues a SEARCH at all.
   *
   * MUTATION WATCHED RED: put the SEARCH-first branch back and the blind arm sweeps 0.
   */
  for (const mode of ["blind", "refused", "rfc"] as const) {
    it(`L15 (${mode} header search): the stale acks of a large folder are swept, nothing else`, async () => {
      const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], headerSearch: mode });
      const fixture = foreign600(NOW);
      for (const r of fixture) server.seed(META, r.raw, r.internalDate);
      const before = server.tree.get(META)!.messages.length;

      let swept = 0;
      for (let pass = 0; pass < 3; pass++) swept += await sweepOf(makeRequestOrganizerIo(server, sweepPath, IDENTITY))(CUTOFF);

      expect(swept, "a server whose header search answers nothing was swept of nothing").toBe(100);
      expect(server.tree.get(META)!.messages.length).toBe(before - 100);
      expect(server.log.filter((l) => l.startsWith("search ")), "the sweep asked SEARCH").toEqual([]);
    });
  }

  /**
   * A connection that cannot fetch has no way to identify a stale record, and the refusal says so
   * by name rather than reporting a sweep with nothing to do.
   */
  it("refuses by name when the folder cannot be fetched", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, ackRaw("a-1"), OLD);
    const { search: _s, fetch: _f, ...rest } = server;
    const client = rest as unknown as LeaseImapClient;

    const outcome = await sweepOf(makeRequestOrganizerIo(client, sweepPath, IDENTITY))(CUTOFF)
      .catch((e: unknown) => e);

    expect(outcome).toBeInstanceOf(RequestUnavailableError);
    expect((outcome as RequestUnavailableError).op).toBe("sweep_acks");
    expect((outcome as RequestUnavailableError).code,
      "the refusal carries no code, so a log line cannot tell it from any other sweep refusal")
      .toBe("sweep_no_reader");
  });
});
