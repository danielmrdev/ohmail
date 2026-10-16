import { describe, expect, it } from "vitest";

import { memoryImapServer } from "./_metaworld.js";
import { INCUMBENT, LEASE_NOW, foreign600 } from "./_lease-fixtures.js";
import {
  answerLeasePeek,
  makeLeasePeekIo,
  DEFAULT_STALE_AFTER_MS,
  formatClaim,
  parseClaim,
  peekLease,
  readLeasePeek,
  LeaseUnavailableError,
  MetaEnumRefusedError, META_ENUM_RECORDS_MAX, metaFolderFullSentence,
  type ClaimRecord,
  type LeasePeekIo,
} from "../../src/adapters/organizer-lease.js";

/**
 * THE PEEK — reporting who holds a mailbox, without deciding anything and without writing.
 *
 * The three states map onto the gate's three verdicts for a foreign claim, and that correspondence
 * is the property worth testing: a preview that disagreed with the gate that runs afterwards would
 * show somebody one thing and then do another.
 */

const NOW = new Date("2026-08-05T12:00:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

function claim(opts: {
  installId: string;
  kind: "local" | "cloud";
  heartbeat: Date;
  claimedAt?: Date;
  displayName?: string;
}): ClaimRecord {
  const raw = formatClaim({
    authorizedAt: null, capabilities: [],
    installId: opts.installId,
    kind: opts.kind,
    displayName: opts.displayName ?? `${opts.installId} machine`,
    heartbeat: opts.heartbeat,
    claimedAt: opts.claimedAt ?? opts.heartbeat,
    nonce: `n-${opts.installId}`,
  });
  const parsed = parseClaim(raw);
  if (!parsed) throw new Error("fixture is not a claim");
  return parsed;
}

/** A message that says it is a claim and is not readable as one. */
const UNREADABLE = "X-Ohmail-Lease: 1\r\nSubject: x\r\n\r\n";

describe("peekLease — the three states", () => {
  it("an EMPTY folder is `none`, because nobody has ever organized this mailbox", () => {
    const peek = peekLease({ claims: [], now: NOW });
    expect(peek.state).toBe("none");
    expect(peek.holders).toEqual([]);
    expect(peek.unreadable).toBe(0);
  });

  it("a claim renewed inside the window is `held`, and names the machine", () => {
    const peek = peekLease({
      claims: [claim({ installId: "i-1", kind: "local", heartbeat: ago(60_000), displayName: "Studio iMac" })],
      now: NOW,
    });
    expect(peek.state).toBe("held");
    expect(peek.holders).toHaveLength(1);
    expect(peek.holders[0]!.kind).toBe("local");
    expect(peek.holders[0]!.displayName).toBe("Studio iMac");
    /* `active` is the DTO's word for this and `fresh` is the peek's; the peek must not grow the
       DTO's name. Read as a KEY, because `.active` is not on `LeaseHolder` at all — asserting a
       property the type already forbids does not compile (found by an explicit `tsc --noEmit`
       over this dir, which no script in this package runs) and could never have failed. */
    expect(Object.keys(peek.holders[0]!)).not.toContain("active");
    expect(peek.holders[0]!.fresh).toBe(true);
  });

  /**
   * The preview sees what the gate sees, raw duplicates included: a fresh record in a format
   * this build cannot rank refuses even an authorized takeover (`decideLease` rule 1/2, over
   * the RAW list), and coalescing keeps only the newest record per install — so a
   * higher-protocol record hiding behind a rankable sibling must surface here as `unknown` and
   * fresh, not as an ordinary holder with an offerable takeover that will no-op for ever.
   */
  it("reports an install as `unknown` when a fresh record it left cannot be ranked", () => {
    const hidden = parseClaim(formatClaim({
      authorizedAt: null, capabilities: [],
      installId: "i-1", kind: "cloud", displayName: "ohmail Cloud",
      heartbeat: ago(60_000), claimedAt: ago(600_000), nonce: "n-old",
      protocol: 2,
    }));
    const sibling = claim({ installId: "i-1", kind: "cloud", heartbeat: ago(30_000) });
    const peek = peekLease({ claims: [hidden!, sibling], now: NOW });
    expect(peek.state).toBe("held");
    expect(peek.holders).toHaveLength(1);
    expect(peek.holders[0]!.kind).toBe("unknown");
    expect(peek.holders[0]!.fresh).toBe(true);
  });

  it("a claim nobody has renewed is `stopped` — the organizer left without releasing", () => {
    const peek = peekLease({
      claims: [claim({ installId: "i-1", kind: "cloud", heartbeat: ago(DEFAULT_STALE_AFTER_MS + 1000) })],
      now: NOW,
    });
    expect(peek.state).toBe("stopped");
    expect(peek.holders[0]!.fresh).toBe(false);
  });

  it("`stopped` and NOT `none` when the only evidence is an unreadable claim", () => {
    // A message that announces itself as a claim and is then unparseable is EVIDENCE THAT SOMEBODY
    // CLAIMED. Reading it as an empty folder would tell a user nobody has ever organized a mailbox
    // that plainly has an organizer's bookkeeping in it, and would invite a takeover on that basis.
    const parsed = parseClaim(UNREADABLE);
    expect(parsed).not.toBeNull();
    const peek = peekLease({ claims: [parsed!], now: NOW });
    expect(peek.state).toBe("stopped");
    expect(peek.unreadable).toBe(1);
    expect(peek.holders).toEqual([]);
  });

  it("ONE FRESH CLAIM AMONG STALE ONES IS STILL `held`", () => {
    // The dangerous direction: a folder that has accumulated old claims from installs that came
    // and went, plus one live organizer. Reporting the majority, or the newest-looking by any
    // measure other than freshness, would say "stopped" about a mailbox somebody is organizing.
    const peek = peekLease({
      claims: [
        claim({ installId: "old-a", kind: "local", heartbeat: ago(DEFAULT_STALE_AFTER_MS * 3) }),
        claim({ installId: "live", kind: "cloud", heartbeat: ago(5_000) }),
        claim({ installId: "old-b", kind: "local", heartbeat: ago(DEFAULT_STALE_AFTER_MS * 2) }),
      ],
      now: NOW,
    });
    expect(peek.state).toBe("held");
    // Freshest first, so a caller that renders "holders[0]" renders the one that matters.
    expect(peek.holders.map((h) => h.kind)).toEqual(["cloud", "local", "local"]);
    expect(peek.holders[0]!.fresh).toBe(true);
  });

  it("A HEARTBEAT IN THE FUTURE IS FRESH — two machines have two clocks", () => {
    // Same fail-safe direction the gate takes: believing a skewed peer is alive is how both sides
    // avoid concluding they are the organizer.
    const peek = peekLease({
      claims: [claim({ installId: "i-1", kind: "local", heartbeat: new Date(NOW.getTime() + 60_000) })],
      now: NOW,
    });
    expect(peek.state).toBe("held");
  });

  it("coalesces to one entry per install, newest heartbeat — a crashed renew leaves two", () => {
    // Renewing is append-then-expunge, so a crash between the two steps leaves two claims from one
    // install. Reporting both would show a user two organizers where there is one.
    const peek = peekLease({
      claims: [
        claim({ installId: "same", kind: "local", heartbeat: ago(400_000), displayName: "old write" }),
        claim({ installId: "same", kind: "local", heartbeat: ago(1_000), displayName: "new write" }),
      ],
      now: NOW,
    });
    expect(peek.holders).toHaveLength(1);
    expect(peek.holders[0]!.displayName).toBe("new write");
    expect(peek.state).toBe("held");
  });

  it("respects an explicit window, so the peek and the gate cannot judge freshness differently", () => {
    const hb = ago(60_000);
    expect(peekLease({ claims: [claim({ installId: "i", kind: "local", heartbeat: hb })], now: NOW, staleAfterMs: 30_000 }).state)
      .toBe("stopped");
    expect(peekLease({ claims: [claim({ installId: "i", kind: "local", heartbeat: hb })], now: NOW, staleAfterMs: 120_000 }).state)
      .toBe("held");
  });
});

describe("readLeasePeek — an IO failure is never `nobody holds it`", () => {
  it("wraps a failing list in LeaseUnavailableError rather than reporting an empty folder", async () => {
    const io: LeasePeekIo = {
      listClaims: () => Promise.reject(new Error("FETCH refused")),
    };
    await expect(readLeasePeek({ io, now: NOW })).rejects.toBeInstanceOf(LeaseUnavailableError);
    // And it names WHICH operation, so an operator is not left guessing between a folder that
    // could not be created and one that could not be read.
    await readLeasePeek({ io, now: NOW }).catch((e: unknown) => {
      expect((e as LeaseUnavailableError).op).toBe("list_claims");
    });
  });

  it("reads a real claim off a raw message the way the gate would", async () => {
    const raw = formatClaim({
      authorizedAt: null, capabilities: [],
      installId: "i-1", kind: "cloud", displayName: "ohmail Cloud",
      heartbeat: ago(1000), claimedAt: ago(90_000), nonce: "n",
    });
    const io: LeasePeekIo = { listClaims: () => Promise.resolve([{ ref: 1, raw }]) };
    const peek = await readLeasePeek({ io, now: NOW });
    expect(peek.state).toBe("held");
    expect(peek.holders[0]!.displayName).toBe("ohmail Cloud");
    // `claimedAt` is preserved and distinct from the heartbeat: how long they have held it, as
    // opposed to when they last checked in.
    expect(peek.holders[0]!.claimedAt.toISOString()).toBe(ago(90_000).toISOString());
  });

  /**
   * THE FAULT'S OWN NAME SURVIVES THE PEEK. `readLeasePeek` used to stamp `list_claims` on
   * everything its IO threw, so a FULL `ohmail/_meta` — the one lease fault that does not heal by
   * waiting — reached an operator under the name of the one that does. The gate already keeps a
   * classed refusal's own words; these two cases hold the peek to the same rule, and the ordinary
   * list fault above is the positive control that nothing else moved.
   */
  it("a FULL _meta reads as `meta_folder_full` at the peek, the name the gate gives it", async () => {
    const io: LeasePeekIo = {
      listClaims: () => Promise.reject(new MetaEnumRefusedError("over_ceiling", { rows: 0, total: 700, ceiling: META_ENUM_RECORDS_MAX })),
    };
    const seen: Array<[string, Record<string, unknown>]> = [];
    const err = await readLeasePeek({ io, now: NOW, log: (e, d) => seen.push([e, d]) })
      .then(() => null, (e: unknown) => e as LeaseUnavailableError);
    expect(err).toBeInstanceOf(LeaseUnavailableError);
    expect(err!.op, "a full folder still reports as a plain failed list").toBe("meta_folder_full");
    // The counts still reach the log and the sentence — the fault gains a name, it does not lose
    // anything it already carried.
    expect(seen.map(([e]) => e)).toEqual(["lease_enum_refused"]);
    expect(err!.message).toBe(metaFolderFullSentence(700, META_ENUM_RECORDS_MAX));
  });

  it("a refusal that ALREADY names its op keeps it — the peek never re-labels one", async () => {
    const io: LeasePeekIo = {
      listClaims: () => Promise.reject(
        new LeaseUnavailableError("the folder could not be resolved", { op: "ensure_meta" }),
      ),
    };
    const err = await readLeasePeek({ io, now: NOW })
      .then(() => null, (e: unknown) => e as LeaseUnavailableError);
    expect(err!.op, "an already-classed refusal was re-wrapped as a list failure").toBe("ensure_meta");
    expect(err!.message).toBe("the folder could not be resolved");
  });

  it("a message that is NOT a claim is invisible — a stray in _meta is not evidence", async () => {
    // Without the `X-Ohmail-Lease` discriminator every stray message in the folder would read as
    // an organizer, and `state` would be `stopped` for a mailbox nobody has ever organized.
    const io: LeasePeekIo = {
      listClaims: () => Promise.resolve([{ ref: 1, raw: "Subject: a note to self\r\n\r\nhello" }]),
    };
    expect((await readLeasePeek({ io, now: NOW })).state).toBe("none");
  });
});

/**
 * L11: THE PEEK OVER `foreign600`, ON A SERVER WHOSE HEADER SEARCH ANSWERS NOTHING OR REFUSES.
 * At base the blind shape answered `free` from the same blind search the gate used — a person was
 * offered a Start that could never land — and the refused shape answered `unreadable`. The peek
 * reads what the gate reads now, the whole folder, and names A on both.
 *
 * MUTATION WATCHED RED: restore the peek's search arm and the blind arm answers `free`.
 */
describe("L11: the peek names the holder past the window, whatever SEARCH answers", () => {
  const META = "INBOX.ohmail._meta";
  for (const mode of ["blind", "refused"] as const) {
    it(`${mode}: answers held, naming A`, async () => {
      const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], headerSearch: mode });
      for (const r of foreign600(LEASE_NOW)) server.seed(META, r.raw, r.internalDate);

      const answered = await answerLeasePeek({ io: makeLeasePeekIo(server, (c) => c.replace(/\//g, ".")), now: LEASE_NOW });

      expect(answered.answer, "a held mailbox was answered as free or unreadable").toBe("held");
      expect(answered.answer === "held" ? answered.holder.installId : null).toBe(INCUMBENT);
      expect(server.log.filter((l) => l.startsWith("append "))).toEqual([]);
    });
  }
});
