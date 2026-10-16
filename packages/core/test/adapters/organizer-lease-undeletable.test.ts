import { beforeEach, describe, expect, it } from "vitest";

import { memoryImapServer, type MemoryImapOptions, type MemoryImapServer } from "./_metaworld.js";
import { peekMemo, resetMetaMemos } from "../../src/adapters/meta-memo.js";
import {
  LeaseUnavailableError, META_CLEANUP_REFUSALS_MAX, META_ENUM_RECORDS_MAX, formatClaim, makeLeaseIo, runLeaseGate,
  type LeaseSelf,
} from "../../src/adapters/organizer-lease.js";

/**
 * A SERVER THAT TAKES NO DELETE IN `ohmail/_meta` STOPS THE RENEWALS (META-RENEW-WITHOUT-EXPUNGE).
 * Every renew appends and its cleanup is proved per batch, so k proven refusals in a row stop the
 * appends: the gate probes one own claim first and, when it still stands, refuses `meta_undeletable`
 * with nothing appended and nothing read. A cleanup that could not be VERIFIED counts for nothing.
 */

const META = "INBOX.ohmail._meta";
const ID = { installId: "us", mailboxId: "mb-undeletable" };
const t0 = new Date("2026-10-04T10:00:00.000Z");
const toServerPath = (c: string): string => c.replace(/\//g, ".");

beforeEach(() => { resetMetaMemos(); });

/** The ruled k, as a literal: a loop bounded by the constant under test hangs when it is mutated. */
const K = 3;

type Outcome = { verdict: string } | { op: string };
type Line = { event: string; detail: Record<string, unknown> };

/** One install renewing every minute against one server, its nonce carried as a host carries it. */
function install(server: MemoryImapServer) {
  const self: LeaseSelf = { installId: ID.installId, kind: "cloud", displayName: "Cloud", lastNonce: null };
  const lines: Line[] = [];
  let at = t0.getTime();
  return {
    lines,
    async gate(): Promise<Outcome> {
      at += 60_000;
      try {
        const r = await runLeaseGate({
          io: makeLeaseIo(server, toServerPath, ID), self, now: new Date(at), capabilities: [],
          log: (event, detail) => { lines.push({ event, detail }); },
        });
        if (r.nonce !== null) self.lastNonce = r.nonce;
        return { verdict: r.verdict.verdict };
      } catch (err) {
        if (err instanceof LeaseUnavailableError) return { op: err.op };
        throw err;
      }
    },
  };
}

function world(opts: MemoryImapOptions = {}): MemoryImapServer {
  return memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], ...opts });
}

const ours = (s: MemoryImapServer): number[] => s.tree.get(META)!.messages
  .filter((m) => /^X-Ohmail-Install-Id: us\r?$/m.test(m.raw)).map((m) => m.uid);

describe("renewals stop on a folder that takes no delete", () => {
  it("k is three", () => { expect(META_CLEANUP_REFUSALS_MAX).toBe(K); });

  it("a lying delete: k proven refusals, then meta_undeletable with nothing appended", async () => {
    const server = world();
    const us = install(server);
    expect(await us.gate()).toEqual({ verdict: "organize" });
    const first = ours(server)[0]!;
    server.startLyingAboutDeletes();
    for (let i = 0; i < K; i++) expect(await us.gate()).toEqual({ verdict: "organize" });
    const standing = ours(server).length;
    expect(standing, "each refused renew should still have appended one").toBe(1 + K);

    for (let i = 0; i < 3; i++) expect(await us.gate()).toEqual({ op: "meta_undeletable" });
    expect(ours(server).length, "a blocked install kept appending claims").toBe(standing);
    const said = us.lines.filter((l) => l.event === "lease_meta_undeletable");
    expect(said.length, "the probe is logged on every blocked cycle").toBe(3);
    expect(said[0]!.detail).toMatchObject({ uid: first, code: "still_present" });
  });

  it("a refused EXPUNGE counts the same, under its own code", async () => {
    const server = world();
    const us = install(server);
    await us.gate();
    server.misbehave({ expungeRefused: true });
    for (let i = 0; i < K; i++) await us.gate();
    expect(await us.gate()).toEqual({ op: "meta_undeletable" });
    expect(us.lines.find((l) => l.event === "lease_meta_undeletable")!.detail.code).toBe("expunge_refused");
  });

  it("CONTROL: a cleanup nobody could verify neither counts nor blocks", async () => {
    const server = world();
    const fetch = server.fetch.bind(server);
    // The custody read-back (a bare uid FETCH) fails; every other read answers.
    server.fetch = ((range, query, opts) => (query.headers === undefined && query.internalDate === undefined
      ? (async function* () { throw new Error("connection reset by peer"); })()
      : fetch(range, query, opts))) as MemoryImapServer["fetch"];
    const us = install(server);
    await us.gate();
    server.startLyingAboutDeletes();
    for (let i = 0; i < 2 * K; i++) {
      expect(await us.gate(), "an unverifiable cleanup was counted as a refusal").toEqual({ verdict: "organize" });
    }
  });

  /* The read-back fails for the first k cleanups and works after: those k count for nothing, so
     the block comes k PROVEN refusals later. MUTATION WATCHED RED: count `unreadable`. */
  it("unverifiable cleanups do not count: the block waits for k proven ones", async () => {
    const server = world();
    const fetch = server.fetch.bind(server);
    let unreadable = K;
    server.fetch = ((range, query, opts) => (query.headers === undefined && query.internalDate === undefined && unreadable-- > 0
      ? (async function* () { throw new Error("connection reset by peer"); })()
      : fetch(range, query, opts))) as MemoryImapServer["fetch"];
    const us = install(server);
    await us.gate();
    server.startLyingAboutDeletes();
    for (let i = 0; i < 2 * K; i++) expect(await us.gate(), `gate ${i + 1} after the fault`).toEqual({ verdict: "organize" });
    expect(await us.gate()).toEqual({ op: "meta_undeletable" });
  });

  it("a cleanup that lands resets the count", async () => {
    const server = world();
    const us = install(server);
    await us.gate();
    server.startLyingAboutDeletes();
    for (let i = 0; i < K - 1; i++) await us.gate();
    server.stopLyingAboutDeletes();
    expect(await us.gate()).toEqual({ verdict: "organize" });
    expect(ours(server).length, "the landed cleanup left our older claims").toBe(1);
    server.startLyingAboutDeletes();
    for (let i = 0; i < K; i++) {
      expect(await us.gate(), "a reset count blocked early").toEqual({ verdict: "organize" });
    }
    expect(await us.gate()).toEqual({ op: "meta_undeletable" });
  });

  it("the delete permission restored: the probe lands, the renew runs and the folder shrinks", async () => {
    const server = world();
    const us = install(server);
    await us.gate();
    server.startLyingAboutDeletes();
    for (let i = 0; i < K; i++) await us.gate();
    expect(await us.gate()).toEqual({ op: "meta_undeletable" });
    const before = ours(server).length;
    server.stopLyingAboutDeletes();
    expect(await us.gate()).toEqual({ verdict: "organize" });
    expect(ours(server).length).toBeLessThan(before);
    expect(ours(server).length, "the renew after the probe did not clean up").toBe(1);
  });

  it("without UIDPLUS: a plain EXPUNGE the probe lands takes every flagged record, accepted", async () => {
    const server = world({ noUidplus: true });
    const us = install(server);
    await us.gate();
    server.misbehave({ expungeRefused: true });
    for (let i = 0; i < K; i++) await us.gate();
    expect(await us.gate()).toEqual({ op: "meta_undeletable" });
    server.heal("expungeRefused");
    expect(await us.gate()).toEqual({ verdict: "organize" });
    expect(ours(server).length).toBe(1);
  });

  it("a renumbered folder forgets the probe and the ordinary gate runs", async () => {
    const server = world();
    const us = install(server);
    await us.gate();
    server.startLyingAboutDeletes();
    for (let i = 0; i < K; i++) await us.gate();
    expect(await us.gate()).toEqual({ op: "meta_undeletable" });
    server.renumber(META);
    expect(await us.gate(), "a uid from the old numbering was probed in the new one").toEqual({ verdict: "organize" });
  });

  /* LOW-2: a claim under OUR install id with another nonce, younger than the
     window, is a shared-id sibling's, and the probe never aims at it. The deletes fail from the
     first gate, so the sibling is still there to be chosen. MUTATION WATCHED RED: the exclusion
     forced true. */
  it("a same-id sibling claim inside the window is never the probe's target", async () => {
    const server = world();
    const hb = new Date(t0.getTime() - 60_000);
    const sibling = server.seed(META, formatClaim({ installId: ID.installId, kind: "cloud", displayName: "Twin",
      heartbeat: hb, claimedAt: hb, nonce: "sibling-nonce", authorizedAt: null, capabilities: [] }), hb);
    server.startLyingAboutDeletes();
    const us = install(server);
    for (let i = 0; i < K; i++) expect(await us.gate()).toEqual({ verdict: "organize" });
    for (let i = 0; i < 3; i++) expect(await us.gate()).toEqual({ op: "meta_undeletable" });
    const probed = us.lines.filter((l) => l.event === "lease_meta_undeletable").map((l) => l.detail.uid);
    expect(probed.length).toBe(3);
    expect(probed, "the probe aimed at a sibling's live claim").not.toContain(sibling);
  });

  /* LOW-3: the remembered uid is stamped with the generation of the read
     that NAMED it, the election — not the verify read after it. The generation moves between the
     two inside one pass. (A later gate cannot probe it wrongly today: a generation mismatch already
     resets the count, so the stamp itself is the guard.) MUTATION WATCHED RED: the verify's. */
  it("the remembered uid carries the election's generation", async () => {
    const server = world();
    const append = server.append.bind(server);
    let bump = false;
    server.append = (async (...a: Parameters<MemoryImapServer["append"]>) => {
      const reply = await append(...a);
      if (bump) { bump = false; server.tree.get(META)!.uidValidity += 1; }
      return reply;
    }) as MemoryImapServer["append"];
    const us = install(server);
    await us.gate();
    const named = server.tree.get(META)!.uidValidity;
    server.startLyingAboutDeletes();
    bump = true;
    expect(await us.gate()).toEqual({ verdict: "organize" });
    const held = peekMemo(ID);
    expect(held?.memo.cleanupRefusals).toBe(1);
    expect(held?.memo.undeletableUid).toBeTypeOf("number");
    expect(held?.generation, "stamped with a read that did not name the uid").toBe(named);
  });

  /**
   * BOTH FAULTS: the folder past the read ceiling AND undeletable. The probe runs before the read,
   * so the sentence is the one whose cure works (a permission); a person told to move mail out of
   * a folder that takes no delete cannot. MUTATION WATCHED RED: probe after the read.
   */
  it("undeletable outranks full when both hold", async () => {
    const server = world();
    for (let i = 0; i < META_ENUM_RECORDS_MAX - 5; i++) server.seed(META, `Subject: filed ${i}\r\n\r\nb`);
    const us = install(server);
    await us.gate();
    server.startLyingAboutDeletes();
    for (let i = 0; i < K; i++) expect(await us.gate()).toEqual({ verdict: "organize" });
    for (let i = 0; i < 4; i++) server.seed(META, `Subject: filed late ${i}\r\n\r\nb`);
    expect(server.tree.get(META)!.messages.length).toBeGreaterThan(META_ENUM_RECORDS_MAX);
    expect(await us.gate()).toEqual({ op: "meta_undeletable" });
  }, 60_000);

  /** LOW-1: our own append crossing the ceiling is said on THAT pass. */
  it("a folder at exactly the ceiling that our own append crosses reads meta_folder_full", async () => {
    const server = world();
    for (let i = 0; i < META_ENUM_RECORDS_MAX; i++) server.seed(META, `Subject: filed ${i}\r\n\r\nb`);
    const us = install(server);
    expect(await us.gate()).toEqual({ op: "meta_folder_full" });
  }, 60_000);
});
