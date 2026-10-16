import { describe, expect, it } from "vitest";
import { memoryImapServer } from "./_metaworld.js";
import {
  runLeaseGate, makeLeaseIo, formatClaim, clockSkewRefusal, ownClockSkewMs, clockSkewBoundMs,
  makeClockCorrectionWatch, CLOCK_CORRECTION_TOLERANCE_MS,
  CLAIM_PROTOCOL, DEFAULT_STALE_AFTER_MS, MAX_FUTURE_SKEW_MS, LeaseUnavailableError,
  LeaseClockSkewError, CLOCK_SKEW_WINDOW_FRACTION,
  META_FOLDER, type LeaseSelf, type RawClaimMessage,
} from "../../src/adapters/organizer-lease.js";

/**
 * ═══ AN INSTALL WHOSE CLOCK IS WRONG REFUSES TO CLAIM ══════════════════════════════════════
 *
 * `LEASE-DEAD-CLOCK-WRITER-CLAIMS`. A machine whose clock is wrong by years can be displaced from
 * a mailbox it is actively organizing and not notice — two organizers for as long as the clock is
 * wrong. No READER-side rule can fix it: believe an old-looking heartbeat and the seventy-three-year
 * lockout is back, disbelieve it and a live organizer is displaced. They are one decision read from
 * two sides, so the cure is on the writer.
 *
 * THE READING IS A PAIR THE RECORD ALREADY CARRIES: `X-Ohmail-Heartbeat` is the install's clock,
 * IMAP INTERNALDATE is the server's, and their difference is that install's skew — independent of
 * the reader's clock and of how old the folder is. A comparison against `now` was tried first and
 * is unsound: it cannot tell "my clock is ahead" from "nothing has been appended here for a long
 * time", and refusing on the second is the lockout from the writer's side. Every fixture with a
 * fixed clock read as days of skew under that form, which is how it was caught.
 */

const TEST_META_ID = { installId: "us", mailboxId: "mbx" };
const SERVER_PATH = "ohmail._meta";
const toServerPath = (c: string): string => c.split("/").join(".");
const selfOf = (installId: string): LeaseSelf => ({
  installId, kind: "local", displayName: `${installId} machine`, lastNonce: null,
});

/** The server's clock, which every record below is stamped against. */
const SERVER_NOW = new Date("2026-09-07T09:00:00.000Z");

/**
 * A folder holding ONE claim by `installId`, whose heartbeat sits `skewMs` from the server's stamp.
 *
 * The heartbeat is what the install's own clock said; the INTERNALDATE is what the server said. A
 * healthy install produces `skewMs: 0`.
 */
function worldWithOwnClaim(installId: string, skewMs: number): ReturnType<typeof memoryImapServer> {
  const server = memoryImapServer({ folders: [SERVER_PATH] });
  const raw = formatClaim({
    protocol: CLAIM_PROTOCOL,
    installId,
    kind: "local",
    displayName: `${installId} machine`,
    claimedAt: new Date(SERVER_NOW.getTime() + skewMs),
    heartbeat: new Date(SERVER_NOW.getTime() + skewMs),
    nonce: `n-${installId}`,
    authorizedAt: null,
    capabilities: [],
  });
  // The stamp is EXPLICIT, so the pair diverges on purpose — the fake's default is agreement.
  server.seed(SERVER_PATH, raw, SERVER_NOW);
  return server;
}

/**
 * A RUNNING PROCESS, and that is not a detail. `worldWithOwnClaim` seeds the record under
 * `n-<installId>`, and the bound these cases measure is about a record THIS process wrote: a
 * `self` with no armed nonce is a fresh LAUNCH, which the gate deliberately gives one renewal so a
 * record measurable under the clock it has now can exist at all. Arming the seeded nonce is what
 * makes every case below ask the question it is named for; the launch case arms `null` explicitly.
 */
const gate = async (
  server: ReturnType<typeof memoryImapServer>, installId: string, staleAfterMs?: number,
): Promise<unknown> => runLeaseGate({
  capabilities: [],
  io: makeLeaseIo(server, toServerPath, TEST_META_ID),
  self: { ...selfOf(installId), lastNonce: `n-${installId}` },
  // The install's OWN clock, which is `SERVER_NOW + skew` in the cases below — but the refusal does
  // not read it, which is the property under test.
  now: SERVER_NOW,
  ...(staleAfterMs !== undefined ? { staleAfterMs } : {}),
});

describe("the writer's own clock decides whether it may claim", () => {
  it("refuses when this install's clock is AHEAD of the server by more than the tolerance", async () => {
    const server = worldWithOwnClaim("us", MAX_FUTURE_SKEW_MS + 1_000);
    const before = server.tree.get(SERVER_PATH)!.messages.length;
    const err = await gate(server, "us").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseUnavailableError);
    expect((err as { op: string }).op, "the refusal names a provider fault instead of the machine")
      .toBe("clock_skew");
    expect((err as Error).message).toContain("ahead of");
    // NOTHING WAS WRITTEN. A gate that refuses after appending has already claimed the mailbox.
    expect(server.tree.get(SERVER_PATH)!.messages.length,
      "the refusal appended a claim on its way out").toBe(before);
  });

  it("refuses when this install's clock is BEHIND by more than a quarter of the window", async () => {
    // The row's own measurement: at a one-minute window, a lag well inside it is enough for a reader
    // to find nothing renewing and take the mailbox with this install's live record in `displace`.
    // A quarter of that window is 15 s, so 16 s already refuses — the bound now stops the sequence
    // well before the record it wrote can read as residue anywhere.
    const server = worldWithOwnClaim("us", -16_000);
    const err = await gate(server, "us", 60_000).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseUnavailableError);
    expect(err, "the refusal lost the numbers the sentence quotes").toBeInstanceOf(LeaseClockSkewError);
    expect((err as { op: string }).op).toBe("clock_skew");
    expect((err as Error).message).toContain("behind");
    expect((err as LeaseClockSkewError).offByMinutes, "a sub-minute skew rounded to zero minutes")
      .toBe(1);
  });

  it("a quarter of the window is ADMITTED — the bound is a fraction, and it has a top side", async () => {
    // 14 s inside a 60 s window, on the same fixture that refuses at 16 s. Without this the
    // refusal could be tightened to nothing and no test would notice.
    const server = worldWithOwnClaim("us", -14_000);
    const res = await gate(server, "us", 60_000) as { verdict: { verdict: string } };
    expect(res.verdict.verdict, "the bound refuses an install with a nearly-right clock")
      .toBe("organize");
  });

  it("61s of lag at the DEFAULT window is fine — the bound is the window, not a constant", async () => {
    const server = worldWithOwnClaim("us", -61_000);
    const res = await gate(server, "us") as { verdict: { verdict: string } };
    expect(res.verdict.verdict, "the behind bound stopped tracking the configured window")
      .toBe("organize");
  });

  it("an install whose clocks AGREE organizes — the positive control", async () => {
    const server = worldWithOwnClaim("us", 0);
    const res = await gate(server, "us") as { verdict: { verdict: string } };
    expect(res.verdict.verdict, "the rule refuses an install with nothing wrong with it")
      .toBe("organize");
    // The renew appends and then expunges our older claim, so the COUNT is unchanged and the proof
    // is the nonce: the record standing is the one this gate wrote, not the one it read.
    const standing = server.tree.get(SERVER_PATH)!.messages.map((m) => m.raw).join("\n");
    expect(standing, "the gate said organize and wrote no claim").not.toContain("n-us");
    expect(standing).toContain("X-Ohmail-Install-Id: us");
  });

  it("ANOTHER install's broken clock does not stop us — the skew is per install", async () => {
    const server = worldWithOwnClaim("them", MAX_FUTURE_SKEW_MS * 100);
    // `them` is 1000 minutes ahead, which makes its stamp unbelievable to every reader, so the
    // folder reads as quiet and we may organize. What must NOT happen is our own gate refusing on
    // a fault that belongs to a different machine.
    const err = await gate(server, "us").then(() => null, (e: unknown) => e);
    expect((err as { op?: string } | null)?.op, "we refused on somebody else's clock")
      .not.toBe("clock_skew");
  });

  it("says the clock is wrong ONCE, and again only after it has been right in between", async () => {
    /**
     * A wrong clock lasts days and this gate runs every poll, so the unlatched form wrote
     * thousands of identical lines and buried the one that mattered. The latch is per IO — one
     * connection's view of one mailbox — which is the granularity the person's own fix clears.
     */
    /* BEHIND by more than the bound (150 s at the default window) and well inside the staleness
       window, so the corrected arm below is an ordinary continuation rather than a second refusal
       wearing a different name. */
    const BEHIND = -200_000;
    const server = worldWithOwnClaim("us", BEHIND);
    const io = makeLeaseIo(server, toServerPath, TEST_META_ID);
    const lines: string[] = [];
    /**
     * ONE PROCESS, MANY CYCLES — and the nonce is threaded, as the permit and the runtime thread
     * it. A `self` rebuilt with `lastNonce: null` at every call is a fresh LAUNCH each time, which
     * is a different question: the gate costs a launch one renewal so a record measurable under
     * the clock it has NOW exists, and a fixture that relaunches every cycle would never reach the
     * refusal this case is about.
     */
    let armed: string | null = "n-us";
    const runAt = async (now: Date): Promise<unknown> => runLeaseGate({
      capabilities: [], io, self: { ...selfOf("us"), lastNonce: armed }, now,
      log: (event: string) => { lines.push(event); },
    }).then(
      (r) => { armed = r.nonce ?? armed; return r; },
      (e: unknown) => e,
    );
    const run = async (): Promise<unknown> => runAt(SERVER_NOW);
    const said = (): number => lines.filter((l) => l === "lease_clock_skew_refused").length;

    expect(await run()).toBeInstanceOf(LeaseUnavailableError);
    expect(await run()).toBeInstanceOf(LeaseUnavailableError);
    expect(await run()).toBeInstanceOf(LeaseUnavailableError);
    expect(said(), "three refused cycles wrote three identical lines").toBe(1);

    /* ── THE CLOCK IS SET, AND IT IS THE INSTALL'S CLOCK THAT MOVES ─────────────────────────
     *
     * This used to rewrite the stored record's INTERNALDATE, which is the SERVER's stamp on a
     * message already in the folder — correcting a computer's clock does not reach back and change
     * that. So the case could not meet the failure it is named for: the record's two stamps are
     * IMMUTABLE and their discrepancy is what the gate measures, so a person who corrects their
     * clock is refused by the same record for ever, and the sentence blames the clock they just
     * fixed. The correction is modelled where it happens — this install's `now` — and the record
     * the server holds is left exactly as it was written.
     *
     * `CORRECTED_NOW` is `SERVER_NOW` shifted so that this install's clock and the server's agree
     * from here on; the record in the folder still carries the 200 s discrepancy it was written
     * with, which is the whole premise. */
    const CORRECTED_NOW = new Date(SERVER_NOW.getTime());
    /* THE CORRECTION IS A LAUNCH: a person sets the clock and the app is restarted around it, so
       the process's memory of what it wrote starts empty. That is the state the refusal must not
       survive — and the residual, stated: a process that keeps running across a correction goes on
       measuring the record it wrote with the wrong clock until it is next launched. */
    armed = null;
    const ok = await runAt(CORRECTED_NOW) as { verdict?: { verdict?: string } };
    expect(ok.verdict?.verdict, "a corrected clock still could not claim").toBe("organize");
    expect(said(), "the admitted cycle wrote a refusal line").toBe(1);

    /* AND IT GOES WRONG AGAIN — this install's clock, an hour out, measured against the record
       the admitted cycle above wrote with the corrected one. A second episode is a second thing
       worth reading about, and the latch has to have been dropped for it to be said. */
    /* ── AND IT GOES WRONG AGAIN, WHICH IS A RECORD AND NOT A `now` ──────────────────────────
     *
     * The refusal reads a STORED PAIR — a heartbeat and the server's stamp on the same message —
     * so moving this install's clock changes nothing about records already written, and the
     * fixture's own appends always agree (see `stampedAt`). A second episode is therefore a second
     * RECORD, written by this process with a clock an hour ahead: seeded with both stamps stated,
     * newest by server time so it is the one measured, and its nonce armed so it is a record this
     * process wrote rather than one it inherited. */
    server.seed(SERVER_PATH, formatClaim({
      protocol: CLAIM_PROTOCOL, installId: "us", kind: "local", displayName: "us machine",
      claimedAt: SERVER_NOW, heartbeat: new Date(SERVER_NOW.getTime() + 3_600_000),
      nonce: "n-again", authorizedAt: null, capabilities: [],
    }), new Date(SERVER_NOW.getTime() + 1));
    armed = "n-again";
    expect(await run()).toBeInstanceOf(LeaseUnavailableError);
    expect(said(), "the second episode was swallowed by the first episode's latch").toBe(2);
  });

  /**
   * ══ THE SAME CORRECTION, ON A PROCESS THAT KEPT RUNNING ════════════════════════════════════
   *
   * The case above models the correction as a LAUNCH — `armed = null` — and states the residual it
   * leaves: a process that keeps running goes on measuring the record it wrote with the wrong
   * clock. That residual is the whole of this case. The household sequence is the ordinary one: a
   * computer's clock is wrong, ohmail says so, the person fixes it, and nothing happens, because
   * the app was never restarted around the fix.
   *
   * The nonce is threaded exactly as the permit threads it and is NOT cleared, which is the only
   * difference from the sibling above.
   */
  it("a clock corrected WITHOUT a relaunch clears the refusal, once", async () => {
    const BEHIND = -200_000;
    const server = worldWithOwnClaim("us", BEHIND);
    const io = makeLeaseIo(server, toServerPath, TEST_META_ID);
    const lines: string[] = [];
    let armed: string | null = "n-us";
    let corrected = false;
    const runAt = async (now: Date): Promise<unknown> => runLeaseGate({
      capabilities: [], io, now,
      self: { ...selfOf("us"), lastNonce: armed, ...(corrected ? { clockCorrected: true } : {}) },
      log: (event: string) => { lines.push(event); },
    }).then(
      (r) => {
        armed = r.nonce ?? armed;
        /* SPENT BY THE CYCLE THAT READ IT — the one-shot rule this module already holds. */
        corrected = false;
        return r;
      },
      (e: unknown) => { corrected = false; return e; },
    );

    expect(await runAt(SERVER_NOW), "the precondition: a wrong clock refuses")
      .toBeInstanceOf(LeaseUnavailableError);

    /* THE PERSON FIXES THE CLOCK AND DOES NOT RESTART. This install's `now` agrees with the
       server's from here; the record in the folder still carries the 200 s it was written with,
       and this process still remembers writing it — which is what used to refuse for ever. */
    corrected = true;
    const ok = await runAt(SERVER_NOW) as { verdict?: { verdict?: string } };
    expect(ok.verdict?.verdict, "a clock corrected without a relaunch still could not claim")
      .toBe("organize");

    /* AND THE REFUSAL IS GONE RATHER THAN QUIETER: the admitted cycle wrote no skew line at all.
       THE ONCE IS NOT ASSERTED HERE. A further cycle in THIS fixture ties on server time — the
       fake stamps an append with the record's own heartbeat (`stampedAt`), so the renewal a
       corrected clock writes carries the same INTERNALDATE as the seeded record it replaces, and
       what a third cycle reads is that tie rather than the bound. The spending of the one-shot is
       measured in the case below, on a record whose stamps are stated. */
    expect(lines.filter((l) => l === "lease_clock_skew_refused"), "the admitted cycle still refused")
      .toHaveLength(1);
  });

  /**
   * ══ AND THE BOUND, FROM THE OTHER SIDE: THE ONE-SHOT IS SPENT ══════════════════════════════
   *
   * One correction buys ONE renewal, so that a record measurable under the current clock can exist
   * at all — never a standing exemption, which would be the writer-side check switched off by
   * anybody who can set a flag.
   *
   * THE SECOND RECORD IS SEEDED AND NOT WRITTEN BY THE GATE, and that is the whole reason this
   * case is shaped the way it is: `memoryImapServer` stamps its own appends with an INTERNALDATE
   * that AGREES with the heartbeat, so a renewal this fixture performs always has zero skew and
   * could never represent "the renewal a correction licensed was itself written under a clock that
   * is still wrong". Letting the gate write it would be a control taken from a subject that lacks
   * the property under test — it passed for that reason before this comment existed. So the record
   * is stated: both stamps, 200 s apart, newest by server time so it is the one measured, and its
   * nonce armed so it is a record THIS process wrote.
   */
  it("spends the correction on ONE renewal — a clock still wrong is refused again", async () => {
    const BEHIND = -200_000;
    const server = worldWithOwnClaim("us", BEHIND);
    const io = makeLeaseIo(server, toServerPath, TEST_META_ID);
    let armed: string | null = "n-us";
    let corrected = false;
    const run = async (): Promise<unknown> => runLeaseGate({
      capabilities: [], io, now: SERVER_NOW,
      self: { ...selfOf("us"), lastNonce: armed, ...(corrected ? { clockCorrected: true } : {}) },
      log: () => {},
    }).then(
      (r) => { armed = r.nonce ?? armed; corrected = false; return r; },
      (e: unknown) => { corrected = false; return e; },
    );

    expect(await run(), "the precondition: a wrong clock refuses").toBeInstanceOf(LeaseUnavailableError);
    corrected = true;
    const admitted = await run() as { verdict?: { verdict?: string } };
    expect(admitted.verdict?.verdict, "the correction bought no renewal at all").toBe("organize");

    /* THE RENEWAL THAT CORRECTION LICENSED, WRITTEN UNDER A CLOCK THAT IS STILL 200 s OUT —
       stated rather than performed, for the reason in the block above. */
    server.seed(SERVER_PATH, formatClaim({
      protocol: CLAIM_PROTOCOL, installId: "us", kind: "local", displayName: "us machine",
      claimedAt: SERVER_NOW, heartbeat: new Date(SERVER_NOW.getTime() + 1 + BEHIND),
      nonce: "n-still-wrong", authorizedAt: null, capabilities: [],
    }), new Date(SERVER_NOW.getTime() + 1));
    armed = "n-still-wrong";

    expect(await run(), "a wrong clock bought a standing exemption rather than one renewal")
      .toBeInstanceOf(LeaseUnavailableError);
  });

  it("a record the server did not stamp is UNKNOWN, and unknown refuses nothing", async () => {
    const server = memoryImapServer({ folders: [SERVER_PATH] });
    const raw = formatClaim({
      protocol: CLAIM_PROTOCOL, installId: "us", kind: "local", displayName: "us machine",
      claimedAt: SERVER_NOW, heartbeat: new Date(SERVER_NOW.getTime() + MAX_FUTURE_SKEW_MS * 10),
      nonce: "n-us", authorizedAt: null, capabilities: [],
    });
    server.seed(SERVER_PATH, raw, SERVER_NOW);
    // The stamp is removed after the fact, which is what a provider that does not report
    // INTERNALDATE looks like from here.
    for (const m of server.tree.get(SERVER_PATH)!.messages) {
      (m as { internalDate: Date | null }).internalDate = null as unknown as Date;
    }
    const res = await gate(server, "us").then((r) => r, (e: unknown) => e);
    expect(res, "an unreported server clock was read as a broken one")
      .not.toBeInstanceOf(LeaseUnavailableError);
  });
});

/**
 * ══ THE WATCH BEHIND THE ONE-SHOT ══════════════════════════════════════════════════════════════
 *
 * Both clocks are injected, so these are readings and not races. The property is that the WALL
 * clock moving ALONE is a correction and the two moving TOGETHER is time passing.
 */
describe("the clock-correction watch", () => {
  const rig = (): { tick: (wallMs: number, monoMs: number) => number } => {
    let w = 1_000_000;
    let m = 500;
    const watch = makeClockCorrectionWatch({ wall: () => w, mono: () => m });
    return {
      tick: (wallMs: number, monoMs: number): number => { w += wallMs; m += monoMs; return watch(); },
    };
  };

  it("counts nothing while the two clocks advance together — the positive control", () => {
    const r = rig();
    expect(r.tick(60_000, 60_000), "an ordinary minute read as a correction").toBe(0);
    expect(r.tick(60_000, 60_000)).toBe(0);
    /* SLEW, not a step: half a millisecond per second over a minute is 30 ms, well inside. */
    expect(r.tick(60_030, 60_000), "NTP slew read as a correction").toBe(0);
  });

  it("sees the wall clock SET, in both directions", () => {
    expect(rig().tick(60_000 + 200_000, 60_000), "a clock set forwards was missed").toBe(1);
    expect(rig().tick(60_000 - 200_000, 60_000), "a clock set backwards was missed").toBe(1);
  });

  it("counts ONE step once, however often it is read", () => {
    const r = rig();
    expect(r.tick(200_000, 1_000)).toBe(1);
    expect(r.tick(1_000, 1_000), "the same correction was counted twice").toBe(1);
    expect(r.tick(1_000, 1_000)).toBe(1);
    /* AND A SECOND EPISODE IS A SECOND COUNT — a latch that never moves again is no better than
       a one-shot, and this is the reading that tells the two apart. */
    expect(r.tick(-200_000, 1_000), "a second correction did not move the count").toBe(2);
  });

  it("admits AT the tolerance and refuses past it — the bound is the bound", () => {
    const T = CLOCK_CORRECTION_TOLERANCE_MS;
    expect(rig().tick(1_000 + T, 1_000), "the tolerance itself was called a correction").toBe(0);
    expect(rig().tick(1_000 + T + 1, 1_000), "a step one ms past the tolerance was missed").toBe(1);
  });

  /**
   * THE REASON IT IS A COUNT. Two mailboxes in one process both need the renewal a correction
   * licenses; a boolean spent by whichever gate ran first would leave the second refusing for ever.
   * Each runtime latches the count it has acted on, so both see the same step exactly once.
   */
  it("gives every mailbox in one process the same correction, once each", () => {
    const r = rig();
    let seenA = r.tick(0, 0);
    let seenB = seenA;
    const n1 = r.tick(200_000, 1_000);
    expect(n1 !== seenA, "mailbox A missed the correction").toBe(true);
    expect(n1 !== seenB, "mailbox B missed the correction the first gate spent").toBe(true);
    seenA = n1; seenB = n1;
    const n2 = r.tick(1_000, 1_000);
    expect(n2 !== seenA, "mailbox A re-admitted without a second correction").toBe(false);
    expect(n2 !== seenB, "mailbox B re-admitted without a second correction").toBe(false);
  });
});

describe("the two predicates, in isolation", () => {
  const rec = (heartbeat: Date, internalDate: Date | null, installId = "us"): RawClaimMessage => ({
    ref: 1,
    raw: formatClaim({
      protocol: CLAIM_PROTOCOL, installId, kind: "local", displayName: `${installId} machine`,
      claimedAt: heartbeat, heartbeat, nonce: "n", authorizedAt: null, capabilities: [],
    }),
    internalDate,
  });

  it("reads OUR skew and nobody else's, and `null` when we wrote nothing here", () => {
    const ours = rec(new Date(SERVER_NOW.getTime() + 5_000), SERVER_NOW);
    const theirs = rec(new Date(SERVER_NOW.getTime() + 900_000), SERVER_NOW, "them");
    expect(ownClockSkewMs([ours, theirs], "us")).toBe(5_000);
    expect(ownClockSkewMs([theirs], "us")).toBeNull();
    expect(ownClockSkewMs([rec(SERVER_NOW, null)], "us")).toBeNull();
  });

  it("ONE bound in both directions, a quarter of the window, admitting AT it", () => {
    const stale = 60_000;
    const quarter = stale / CLOCK_SKEW_WINDOW_FRACTION;
    expect(clockSkewBoundMs(stale)).toBe(quarter);
    // AT the bound, admitted; one tick past it, refused — on both sides, and the two sides answer
    // with the same figure. The directions used to differ by a factor of ten at this window.
    expect(clockSkewRefusal({ skewMs: quarter, staleAfterMs: stale })).toBeNull();
    expect(clockSkewRefusal({ skewMs: quarter + 1, staleAfterMs: stale })?.bound).toBe("ahead");
    expect(clockSkewRefusal({ skewMs: -quarter, staleAfterMs: stale })).toBeNull();
    expect(clockSkewRefusal({ skewMs: -quarter - 1, staleAfterMs: stale })?.bound).toBe("behind");
    expect(clockSkewRefusal({ skewMs: quarter + 1, staleAfterMs: stale })?.boundMs).toBe(quarter);
    expect(clockSkewRefusal({ skewMs: -quarter - 1, staleAfterMs: stale })?.boundMs).toBe(quarter);
    expect(clockSkewRefusal({ skewMs: null, staleAfterMs: stale })).toBeNull();
  });

  it("a window ABOVE the believability cutoff holds the WRITER to the cutoff", () => {
    /**
     * `LEASE-WINDOW-ABOVE-SKEW-CUTOFF`. A configured window of 40 minutes has a ten-minute
     * quarter, which is exactly the cutoff; anything longer would license this install to stamp a
     * heartbeat further ahead than any reader will believe — a record inside its own lease that
     * every reader excludes from the renewal evidence, which is the row's sequence. The tolerance
     * is NOT widened to meet the window (that is the seventy-three-year lockout with a shorter
     * number); the writer is held to the smaller of the two.
     */
    expect(clockSkewBoundMs(MAX_FUTURE_SKEW_MS * 4)).toBe(MAX_FUTURE_SKEW_MS);
    expect(clockSkewBoundMs(DEFAULT_STALE_AFTER_MS * 100)).toBe(MAX_FUTURE_SKEW_MS);
    expect(clockSkewRefusal({
      skewMs: MAX_FUTURE_SKEW_MS + 1, staleAfterMs: DEFAULT_STALE_AFTER_MS * 100,
    })?.boundMs).toBe(MAX_FUTURE_SKEW_MS);
    // And the default window's quarter is well under it — the cap is a ceiling, not the rule.
    expect(clockSkewBoundMs(DEFAULT_STALE_AFTER_MS)).toBe(DEFAULT_STALE_AFTER_MS / 4);
  });

  it("the folder it reads is the lease's own", () => {
    expect(META_FOLDER).toBe("ohmail/_meta");
  });
});
