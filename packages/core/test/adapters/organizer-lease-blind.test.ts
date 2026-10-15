import { beforeEach, describe, expect, it } from "vitest";

import { headerSearchesIn, memoryImapServer, type MemoryImapOptions, type MemoryImapServer } from "./_metaworld.js";
import {
  INCUMBENT, INCUMBENT_NONCE, LEASE_NOW, foreign600, gateOutcome, settingsRaw,
} from "./_lease-fixtures.js";
import { makeProfileIo, readOrganizerProfile, tidyOrganizerProfile } from "../../src/adapters/organizer-profile.js";
import { resetMetaMemos } from "../../src/adapters/meta-memo.js";
import { META_ENUM_RECORDS_MAX, makeLeaseIo, type LeaseSelf } from "../../src/adapters/organizer-lease.js";

/**
 * THE LEASE READS EVERY CLAIM, WHATEVER SEARCH ANSWERS (ARCH-LEASE-BLIND-SEARCH L1-L7, L12-L14).
 * Past the record window the election, the read-back, the custody check, the baseline and the
 * release read the whole folder by one header FETCH proved complete by the server's count. A server
 * whose header SEARCH answers nothing (`blind`) or refuses (`refused`) decides nothing any more.
 */

const META = "INBOX.ohmail._meta";
const toServerPath = (canonical: string): string => canonical.replace(/\//g, ".");
const IDENTITY = (installId: string) => ({ installId, mailboxId: "mailbox-blind" });

beforeEach(() => { resetMetaMemos(); });

function world(opts: MemoryImapOptions = {}): MemoryImapServer {
  const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], ...opts });
  for (const r of foreign600()) server.seed(META, r.raw, r.internalDate);
  return server;
}

const selfOf = (installId: string, lastNonce: string | null = null): LeaseSelf =>
  ({ installId, kind: installId === INCUMBENT ? "local" : "cloud", displayName: `${installId} machine`, lastNonce });

const appends = (server: MemoryImapServer): string[] => server.log.filter((l) => l.startsWith(`append ${META}`));
const claimsOf = (server: MemoryImapServer, installId: string): number =>
  server.tree.get(META)!.messages.filter((m) =>
    /^X-Ohmail-Lease: 1\r?$/m.test(m.raw.split(/\r?\n\r?\n/)[0]!)
    && new RegExp(`^X-Ohmail-Install-Id: ${installId}\\r?$`, "m").test(m.raw)).length;

describe("L1: an election past the window stands down to the incumbent the window cannot see", () => {
  for (const mode of ["blind", "refused"] as const) {
    it(`${mode} header search: an unpressed install stands down by A and appends nothing`, async () => {
      const server = world({ headerSearch: mode });
      const io = makeLeaseIo(server, toServerPath, IDENTITY("install-b"));

      const out = await gateOutcome({ io, self: selfOf("install-b") });

      expect(out.word, "the election could not see the incumbent under the pile").toBe(`stand_down:${INCUMBENT}`);
      expect(appends(server), "a stand-down wrote a claim").toHaveLength(0);
      expect(claimsOf(server, "install-b")).toBe(0);
    });
  }

  it("rfc header search (the control): the same install stands down by A", async () => {
    const server = world({ headerSearch: "rfc" });
    const out = await gateOutcome({ io: makeLeaseIo(server, toServerPath, IDENTITY("install-b")), self: selfOf("install-b") });
    expect(out.word).toBe(`stand_down:${INCUMBENT}`);
    expect(appends(server)).toHaveLength(0);
  });
});

describe("L2: the incumbent renews past the window on a blind server", () => {
  it("A organizes, holds exactly one claim after, and the lease asked no header SEARCH", async () => {
    const server = world({ headerSearch: "blind" });
    const io = makeLeaseIo(server, toServerPath, IDENTITY(INCUMBENT));

    const out = await gateOutcome({ io, self: selfOf(INCUMBENT, INCUMBENT_NONCE), nonce: "nonce-a-2" });

    expect(claimsOf(server, INCUMBENT), "the renewal left its old claim beside the new one").toBe(1);
    expect(out.word, "the incumbent could not renew its own lease").toBe("organize");
    expect(headerSearchesIn(server.log), "the lease asked the server a header SEARCH").toEqual([]);
  });
});

describe("L3: the folder does not grow by a claim per cycle", () => {
  it("ten gates of A over 601 records on a blind server leave one A claim", async () => {
    const server = world({ headerSearch: "blind" });
    const io = makeLeaseIo(server, toServerPath, IDENTITY(INCUMBENT));
    let last = INCUMBENT_NONCE;
    const words: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const nonce = `nonce-a-${i + 1}`;
      const out = await gateOutcome({
        io, self: selfOf(INCUMBENT, last), nonce, now: new Date(LEASE_NOW.getTime() + i * 30_000),
      });
      words.push(out.word);
      if (out.result?.nonce) last = out.result.nonce;
    }
    expect(claimsOf(server, INCUMBENT), "each cycle added a claim nothing removed").toBe(1);
    expect(words).toEqual(Array(10).fill("organize"));
    expect(server.tree.get(META)!.messages).toHaveLength(601);
  });
});


describe("L4: the two-organizer corner — the folder shrinks between the election and the read-back", () => {
  /**
   * A is live and buried; B holds a NEWER press that only asked to JOIN; between B's election and
   * its read-back 150 settings copies are tidied away, so the read-back fits the window. At base
   * B's blind election saw nothing, appended, and its complete read-back ranked B's newer press
   * first: two organizers. Complete on both reads, B stands down at the election.
   *
   * MUTATION WATCHED RED: restore the search arm and B organizes beside A.
   */
  it("B with a newer join press stands down to A at the election, and writes nothing", async () => {
    const server = world({
      headerSearch: "blind",
      onBetweenReads: (s, read) => {
        if (read !== 1) return;
        const f = s.tree.get(META)!;
        let gone = 0;
        f.messages = f.messages.filter((m) => !(/^X-Ohmail-Profile:/m.test(m.raw) && gone++ < 150));
      },
    });
    const out = await gateOutcome({
      io: makeLeaseIo(server, toServerPath, IDENTITY("install-b")), self: selfOf("install-b"),
      takeover: { authorizedAt: LEASE_NOW, intent: "join" },
    });
    expect(out.word, "a join press organized beside a live incumbent").toBe(`stand_down:${INCUMBENT}`);
    expect(appends(server)).toHaveLength(0);
    expect(server.tree.get(META)!.messages.length, "the tidy between the reads never ran").toBe(451);
  });
});

describe("L5: a read that cannot prove it saw the whole folder refuses", () => {
  /** A full window of other records and A's live claim LAST, so a listing cut short by the server misses it. */
  function lateClaimWorld(opts: MemoryImapOptions): MemoryImapServer {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], ...opts });
    const all = foreign600();
    for (const r of all.slice(1)) server.seed(META, r.raw, r.internalDate);
    for (let i = 0; i < 49; i++) server.seed(META, `Subject: late stray ${i}\r\n\r\nbody\r\n`);
    server.seed(META, all[0]!.raw, all[0]!.internalDate);
    return server;
  }

  /** MUTATION WATCHED RED: drop the rows-versus-count check and B takes arm 4 and appends. */
  it("a FETCH that stops short of the folder's rows refuses `incomplete` and appends nothing", async () => {
    const server = lateClaimWorld({ fetchTruncatesAt: 550 });
    const events: Array<[string, Record<string, unknown>]> = [];
    const out = await gateOutcome({
      io: makeLeaseIo(server, toServerPath, IDENTITY("install-b")), self: selfOf("install-b"),
      log: (e, d) => { events.push([e, d]); },
    });
    expect(out.word, "a listing short of the server's count was decided on").toBe("LeaseUnavailableError:list_claims");
    expect(appends(server)).toHaveLength(0);
    expect(events.find(([e]) => e === "lease_enum_refused")?.[1]).toMatchObject({ code: "incomplete", total: 650 });
  });

  it("a count one high on the first asking is re-asked, and the read is admitted", async () => {
    const server = lateClaimWorld({ statusOvercount: { by: 1, answers: 2 } });
    const out = await gateOutcome({ io: makeLeaseIo(server, toServerPath, IDENTITY("install-b")), self: selfOf("install-b") });
    expect(out.word).toBe(`stand_down:${INCUMBENT}`);
  });

  it("ADMIT: the whole listing proceeds to the election", async () => {
    const server = lateClaimWorld({});
    const out = await gateOutcome({ io: makeLeaseIo(server, toServerPath, IDENTITY("install-b")), self: selfOf("install-b") });
    expect(out.word).toBe(`stand_down:${INCUMBENT}`);
    expect(appends(server)).toHaveLength(0);
  });
});

describe("L6: the own-claim control — our last claim must come back recognised", () => {
  async function renewedOnce(): Promise<{ server: MemoryImapServer; ownUid: number; nonce: string }> {
    const server = world({ headerSearch: "blind" });
    const io = makeLeaseIo(server, toServerPath, IDENTITY(INCUMBENT));
    const out = await gateOutcome({ io, self: selfOf(INCUMBENT, INCUMBENT_NONCE), nonce: "nonce-a-2" });
    expect(out.word).toBe("organize");
    return { server, ownUid: server.tree.get(META)!.nextUid - 1, nonce: "nonce-a-2" };
  }

  /** MUTATION WATCHED RED: drop the probe and the refusal is `headerless`, with no blind line. */
  it("our claim's row answered with no headers refuses `blind` by name and appends nothing", async () => {
    const { server, ownUid, nonce } = await renewedOnce();
    server.misbehave({ headersBlankFor: [ownUid] });
    const before = appends(server).length;
    const events: string[] = [];
    const out = await gateOutcome({
      io: makeLeaseIo(server, toServerPath, IDENTITY(INCUMBENT)), self: selfOf(INCUMBENT, nonce),
      now: new Date(LEASE_NOW.getTime() + 30_000), nonce: "nonce-a-3", log: (e) => { events.push(e); },
    });
    expect(out.word).toBe("LeaseUnavailableError:list_claims");
    expect(events, "the refusal did not name the own-claim control").toContain("lease_enum_blind");
    expect(appends(server).length).toBe(before);
  });

  it("ADMIT: our claim really expunged — the memo is forgotten and the election proceeds", async () => {
    const { server, ownUid, nonce } = await renewedOnce();
    const f = server.tree.get(META)!;
    f.messages = f.messages.filter((m) => m.uid !== ownUid);
    const out = await gateOutcome({
      io: makeLeaseIo(server, toServerPath, IDENTITY(INCUMBENT)), self: selfOf(INCUMBENT, nonce),
      now: new Date(LEASE_NOW.getTime() + 30_000), nonce: "nonce-a-3",
    });
    expect(out.word, "a vanished own claim stopped the election").toBe("organize");
  });
});

describe("L7: the enumeration's one ceiling, at the shipping constant", () => {
  function sized(n: number, withIncumbent: boolean): MemoryImapServer {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const strays = withIncumbent ? n - 1 : n;
    if (withIncumbent) server.seed(META, foreign600()[0]!.raw, new Date(LEASE_NOW.getTime() - 5_000));
    for (let i = 0; i < strays; i++) server.seed(META, `Subject: s${i}\r\n\r\n.\r\n`);
    return server;
  }

  /** MUTATION WATCHED RED: drop the pre-check, and the FETCH is sent before the refusal. */
  it(`${META_ENUM_RECORDS_MAX + 1} records refuse over_ceiling before any FETCH and append nothing`, async () => {
    const server = sized(META_ENUM_RECORDS_MAX + 1, true);
    const events: Array<[string, Record<string, unknown>]> = [];
    const out = await gateOutcome({
      io: makeLeaseIo(server, toServerPath, IDENTITY("install-b")), self: selfOf("install-b"),
      log: (e, d) => { events.push([e, d]); },
    });
    expect(out.word).toBe("LeaseUnavailableError:meta_folder_full");
    expect(events.find(([e]) => e === "lease_enum_refused")?.[1])
      .toMatchObject({ code: "over_ceiling", total: META_ENUM_RECORDS_MAX + 1, ceiling: META_ENUM_RECORDS_MAX });
    expect(server.log.filter((l) => l.startsWith(`fetch ${META} `)), "a FETCH went out over the ceiling").toEqual([]);
    expect(appends(server)).toHaveLength(0);
  });

  /** MUTATION WATCHED RED: `>` to `>=` and the read-back at exactly the ceiling refuses. */
  it(`ADMIT: the incumbent renews over ${META_ENUM_RECORDS_MAX - 1}, its read-back reading exactly ${META_ENUM_RECORDS_MAX}`, async () => {
    const server = sized(META_ENUM_RECORDS_MAX - 1, true);
    const out = await gateOutcome({
      io: makeLeaseIo(server, toServerPath, IDENTITY(INCUMBENT)), self: selfOf(INCUMBENT, INCUMBENT_NONCE), nonce: "nonce-a-2",
    });
    expect(out.word).toBe("organize");
    expect(server.tree.get(META)!.messages).toHaveLength(META_ENUM_RECORDS_MAX - 1);
  });
});

describe("L12: the release past the window", () => {
  /** MUTATION WATCHED RED: keep the window read and the release refuses `over_ceiling`. */
  it("650 records: our claims are found and removed, our settings copies kept", async () => {
    const server = world({ headerSearch: "blind" });
    for (let i = 0; i < 49; i++) server.seed(META, `Subject: stray ${i}\r\n\r\n.\r\n`);
    const io = makeLeaseIo(server, toServerPath, IDENTITY(INCUMBENT));

    const found = (await io.findOwnRecords!(INCUMBENT)) ?? [];
    const ours = found.filter((m) => new RegExp(`^X-Ohmail-Install-Id: ${INCUMBENT}\\r?$`, "m").test(m.raw)
      && /^X-Ohmail-Lease: 1\r?$/m.test(m.raw));
    expect(ours, "the release could not find our claim past the window").toHaveLength(1);
    await io.removeClaims(ours.map((m) => m.ref));

    expect(claimsOf(server, INCUMBENT)).toBe(0);
    expect(server.tree.get(META)!.messages.filter((m) => /^X-Ohmail-Profile:/m.test(m.raw)), "a settings copy was expunged")
      .toHaveLength(300);
  });
});

describe("L14: at or under the window the wire is what it was", () => {
  /**
   * Records within the window: the claim read is one STATUS and one `FETCH 1:*`, byte for byte the commands the
   * base build sent (read off the base build with this same case).
   *
   * MUTATION WATCHED RED: force the enumeration below the window and the log differs.
   */
  it("499 records: STATUS messages, then FETCH 1:*, and nothing else", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const all = foreign600();
    for (const r of all.slice(0, 499)) server.seed(META, r.raw, r.internalDate);
    const io = makeLeaseIo(server, toServerPath, IDENTITY("install-b"));
    await io.listClaims();
    const mark = server.log.length;

    const records = await io.listClaims();

    expect(server.log.slice(mark)).toEqual([`select ${META}`, `status ${META} messages`, `fetch ${META} 1:*`]);
    // The window keeps what the lease's door keeps: claims, never the settings or acks beside them.
    expect(records).toHaveLength(all.slice(0, 499).filter((r) => r.kind === "claim").length);
  });
});

describe("L20: the settings tidy and the lease rescue a blind folder together", () => {
  /** A's live claim, 700 superseded settings copies of A's, and A's current document. */
  function settingsPile(copies: number): MemoryImapServer {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], headerSearch: "blind" });
    const a = foreign600()[0]!;
    server.seed(META, a.raw, a.internalDate);
    for (let i = 0; i < copies; i++) {
      const at = new Date(LEASE_NOW.getTime() - 86_400_000 + i * 1_000);
      server.seed(META, settingsRaw(i, INCUMBENT, at), at);
    }
    const current = new Date(LEASE_NOW.getTime() - 3_600_000);
    server.seed(META, settingsRaw(copies, INCUMBENT, current), current);
    return server;
  }
  const profileIo = (server: MemoryImapServer) => makeProfileIo(server, toServerPath, IDENTITY(INCUMBENT));

  /**
   * The lease organizes on the first pass past the window; the tidy then drains the pile — count
   * first, then remove, 100 a pass — and once the folder is back under 500 the lease reads it by
   * the window again, the L14 wire shape.
   */
  it("700 copies: organize at once, count then remove, and the lease returns to the window", async () => {
    const server = settingsPile(700);
    let last = INCUMBENT_NONCE;
    let pass = 0;
    const gate = async (): Promise<string[]> => {
      pass += 1;
      const events: string[] = [];
      const out = await gateOutcome({
        io: makeLeaseIo(server, toServerPath, IDENTITY(INCUMBENT)), self: selfOf(INCUMBENT, last),
        now: new Date(LEASE_NOW.getTime() + pass * 30_000), nonce: `a-${pass}`, log: (e) => { events.push(e); },
      });
      expect(out.word, `gate ${pass}`).toBe("organize");
      last = `a-${pass}`;
      return events;
    };

    expect(await gate(), "the first pass did not read past the window").toContain("lease_meta_enumerated");
    const counted = await tidyOrganizerProfile({ io: profileIo(server), installId: INCUMBENT, mode: "count", now: LEASE_NOW });
    expect(counted).toMatchObject({ removed: 0, remaining: 700 });
    for (let i = 0; i < 3; i++) {
      await tidyOrganizerProfile({ io: profileIo(server), installId: INCUMBENT, mode: "remove", now: LEASE_NOW });
      await gate();
    }
    expect(server.tree.get(META)!.messages.length, "the tidy did not bring the folder under the window")
      .toBeLessThanOrEqual(500);

    const io = makeLeaseIo(server, toServerPath, IDENTITY(INCUMBENT));
    await io.listClaims();
    const mark = server.log.length;
    await io.listClaims();
    expect(server.log.slice(mark)).toEqual([`select ${META}`, `status ${META} messages`, `fetch ${META} 1:*`]);
    expect(await gate(), "the lease still enumerates a folder back under the window").not.toContain("lease_meta_enumerated");
  });

  /** MUTATION WATCHED RED: keep the settings read's old ceiling and this is `profile_meta_too_full`. */
  it("6 000 copies: the settings read and the lease both read the folder, one ceiling for both", async () => {
    const server = settingsPile(6_000);
    const read = await readOrganizerProfile(profileIo(server), { now: LEASE_NOW });
    expect(read.state, "the settings read refused a folder under the shared ceiling").toBe("found");
    const out = await gateOutcome({
      io: makeLeaseIo(server, toServerPath, IDENTITY(INCUMBENT)), self: selfOf(INCUMBENT, INCUMBENT_NONCE), nonce: "a-1",
    });
    expect(out.word).toBe("organize");
  });
});
