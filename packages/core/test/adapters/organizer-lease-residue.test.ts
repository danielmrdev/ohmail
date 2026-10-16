import { beforeEach, describe, expect, it } from "vitest";

import { memoryImapServer, type MemoryImapServer } from "./_metaworld.js";
import { INCUMBENT, INCUMBENT_NONCE, LEASE_NOW, claimRaw, foreign600, gateOutcome } from "./_lease-fixtures.js";
import { resetMetaMemos } from "../../src/adapters/meta-memo.js";
import { createLogger, ALLOWED_FIELDS } from "../../src/log.js";
import {
  DEFAULT_STALE_AFTER_MS, RESIDUE_REMOVE_MAX_PER_PASS, claimResidue, decideLease, makeLeaseIo,
  type ClaimRecord, type LeaseSelf, type LeaseVerdict, type OrganizerClaim, type TakeoverAuthorization,
} from "../../src/adapters/organizer-lease.js";

/**
 * FOREIGN CLAIM RESIDUE, REMOVED WITHOUT CHANGING AN ELECTION (ARCH-LEASE-BLIND-SEARCH L8-L10, L19;
 * ARCH-META-ENUMERATOR-RULING §1.4). A confirmed organizer removes other installs' claims no
 * election can rank; `decideLease` over the folder with and without them must agree on the
 * verdict, the reason, the winning install and `authorized`, for every reader.
 */

const META = "INBOX.ohmail._meta";
const toServerPath = (canonical: string): string => canonical.replace(/\//g, ".");
const W = DEFAULT_STALE_AFTER_MS;
const MIN = 60_000;

beforeEach(() => { resetMetaMemos(); });

// ── L8: THE PROPERTY ─────────────────────────────────────────────────────────────────────────

/** A deterministic PRNG, so a counterexample is a seed a person can replay. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Case { claims: ClaimRecord[]; readers: LeaseSelf[]; takeover: TakeoverAuthorization | null }

/**
 * Random folders over every shape the ruling names: several installs and clones sharing an id,
 * presses (some implausibly far ahead), join and takeover, protocol 1 and 2, an unknown kind,
 * malformed records, 2099 writer stamps, and server stamps that disagree with the writer's.
 * Heartbeats span fresh, one window, two-plus windows and days; the newest may be in the future.
 */
function randomCase(rnd: () => number, now: Date): Case {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const at = (ms: number): Date => new Date(now.getTime() + ms);
  const ages = [-5_000, -60_000, -8 * MIN, -12 * MIN, -19 * MIN, -21 * MIN, -45 * MIN, -3 * 3_600_000, -86_400_000, 4 * MIN];
  const stamp = (): Date => (rnd() < 0.06 ? new Date("2099-01-01T00:00:00.000Z") : at(pick(ages) - Math.floor(rnd() * 30_000)));
  const installs = ["self", "x", "y", "z"].slice(0, 1 + Math.floor(rnd() * 4));
  const claims: ClaimRecord[] = [];
  let ref = 1;
  for (const installId of installs) {
    const n = 1 + Math.floor(rnd() * 5);
    const claimedAt = at(-Math.floor(rnd() * 5) * 3_600_000);
    for (let i = 0; i < n; i++) {
      if (rnd() < 0.05) { claims.push({ malformed: true, reason: "fixture", ref: ref++ }); continue; }
      const writer = stamp();
      const server = rnd() < 0.5 ? null : (rnd() < 0.5 ? writer : stamp());
      const press = rnd() < 0.3 ? (rnd() < 0.1 ? new Date("2099-06-01T00:00:00.000Z") : at(pick(ages))) : null;
      const c: OrganizerClaim = {
        installId, kind: rnd() < 0.08 ? "unknown" : pick(["local", "cloud", "mobile"] as const),
        protocol: rnd() < 0.1 ? 2 : 1, heartbeat: writer, writerStamp: writer, serverStamp: server,
        claimedAt: rnd() < 0.2 ? at(-Math.floor(rnd() * 3) * 3_600_000) : claimedAt, displayName: installId,
        nonce: `${installId}-${rnd() < 0.15 ? "clone" : "n"}-${i}`, authorizedAt: press,
        intent: rnd() < 0.3 ? "join" : "takeover", capabilities: [], ref: ref++,
      };
      claims.push(c);
    }
  }
  const nonces = claims.filter((c): c is OrganizerClaim => !("malformed" in c)).map((c) => c.nonce);
  const readers = [...installs, "newcomer"].map((installId): LeaseSelf => ({
    installId, kind: "cloud", displayName: installId, lastNonce: rnd() < 0.4 ? null : pick([...nonces, "unrelated"]),
  }));
  const takeover = rnd() < 0.3 ? { authorizedAt: at(pick([-MIN, 0, -2 * 3_600_000])), intent: pick(["join", "takeover"] as const) } : null;
  return { claims, readers, takeover };
}

/** The four things residue removal must not move, read off one verdict. */
function shapeOf(v: LeaseVerdict): string {
  if (v.verdict === "organize") return `organize:${v.authorized}`;
  if (v.verdict === "stand_down") return `stand_down:${v.reason}:${v.by?.installId ?? "-"}`;
  return `available:${v.by?.installId ?? "-"}`;
}

function neutral(c: Case, reader: LeaseSelf, now: Date): string | null {
  const residue = new Set<ClaimRecord>(claimResidue(c.claims, reader, now, W));
  const without = c.claims.filter((x) => !residue.has(x));
  const input = { self: reader, now, staleAfterMs: W, takeover: c.takeover };
  const before = decideLease({ ...input, claims: c.claims });
  const after = decideLease({ ...input, claims: without });
  if (shapeOf(before) !== shapeOf(after)) return `${shapeOf(before)} became ${shapeOf(after)}`;
  if (before.verdict === "organize" && after.verdict === "organize") {
    const gone = new Set([...residue].map((r) => r.ref));
    const expected = before.displace.filter((r) => !gone.has(r)).map(String).sort().join(",");
    if (expected !== after.displace.map(String).sort().join(",")) return "displace differed by more than the residue";
  }
  return null;
}

describe("L8: removing claim residue never changes an election", () => {
  /**
   * Thousands of seeded folders, every reader of each, at a fixed `now` and one a window later.
   * MUTATIONS WATCHED RED, each alone: drop the not-live test (condition 4, both clocks); drop the
   * not-coalesce-winner test (condition 3, the winner check with its stability check); drop the
   * malformed filter. The protocol filter changes no election at one instant, so its arm is L9's.
   */
  it("the verdict, reason, winning install and authorization agree with and without the residue", () => {
    const rnd = mulberry32(0x5eed_0026);
    let removedSomewhere = 0;
    const failures: string[] = [];
    for (let n = 0; n < 4_000 && failures.length < 3; n++) {
      const c = randomCase(rnd, LEASE_NOW);
      for (const now of [LEASE_NOW, new Date(LEASE_NOW.getTime() + W)]) {
        for (const reader of c.readers) {
          removedSomewhere += claimResidue(c.claims, reader, now, W).length;
          const bad = neutral(c, reader, now);
          if (bad !== null) failures.push(`case ${n} reader ${reader.installId} at +${now.getTime() - LEASE_NOW.getTime()}: ${bad}`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect(removedSomewhere, "the generator never produced residue, so the property measured nothing").toBeGreaterThan(500);
  });

  /**
   * THE NON-TRANSITIVE FOLD, BY HAND. `compareRecency` orders two believable writer stamps by the
   * writer and anything with an unbelievable one by the server: a (writer newer than b, server an
   * hour old), b (fresh on the server), c (writer 2099) fold a > b > c > a. Folded in order, c wins;
   * remove a and b wins — b is live, c was not, and b's older tenure beats A. So X keeps all three.
   *
   * MUTATION WATCHED RED: drop the stability check and A, organizing, is told to stand down.
   */
  it("an install whose winner would change without its residue keeps every record", () => {
    const now = LEASE_NOW;
    const at = (ms: number): Date => new Date(now.getTime() + ms);
    const x = (ref: number, writer: Date, server: Date, nonce: string): OrganizerClaim => ({
      installId: "x", kind: "local", protocol: 1, heartbeat: writer, writerStamp: writer, serverStamp: server,
      claimedAt: at(-2 * 3_600_000), displayName: "x", nonce, authorizedAt: null, intent: "takeover", capabilities: [], ref,
    });
    const a = x(2, at(-30 * MIN), at(-60 * MIN), "x-a");
    const b = x(3, at(-40 * MIN), at(-MIN), "x-b");
    const c = x(4, new Date("2099-01-01T00:00:00.000Z"), at(-45 * MIN), "x-c");
    const ours: OrganizerClaim = {
      installId: "self", kind: "cloud", protocol: 1, heartbeat: at(-30_000), writerStamp: at(-30_000), serverStamp: at(-30_000),
      claimedAt: at(-3_600_000), displayName: "self", nonce: "self-n", authorizedAt: null, intent: "takeover", capabilities: [], ref: 1,
    };
    const self: LeaseSelf = { installId: "self", kind: "cloud", displayName: "self", lastNonce: "self-n" };
    const claims = [ours, a, b, c];

    expect(shapeOf(decideLease({ self, claims, now })), "the fixture no longer elects A").toBe("organize:false");
    expect(shapeOf(decideLease({ self, claims: [ours, b, c], now })), "the fixture no longer folds to b without a")
      .toBe("stand_down:organized_elsewhere:local:x");
    expect(claimResidue(claims, self, now, W), "a record whose removal changes the winner was residue").toEqual([]);
  });
});

// ── L9 / L10: THE CLEANUP ON THE WIRE ────────────────────────────────────────────────────────

const selfA = (lastNonce: string): LeaseSelf => ({ installId: INCUMBENT, kind: "local", displayName: "A", lastNonce });
const claimsBy = (server: MemoryImapServer, installId: string): string[] =>
  server.tree.get(META)!.messages.map((m) => m.raw)
    .filter((r) => /^X-Ohmail-Lease: 1\r?$/m.test(r) && new RegExp(`^X-Ohmail-Install-Id: ${installId}\\r?$`, "m").test(r));
const expungeSizes = (server: MemoryImapServer): number[] =>
  server.log.filter((l) => l.startsWith(`delete ${META} `)).map((l) => l.slice(`delete ${META} `.length).split(",").length);

/** A's live claim, thousands of superseded claims of X, X's newest, a malformed claim, and two each of protocol 2 and an unknown kind. */
function pile(): MemoryImapServer {
  const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
  const a = foreign600()[0]!;
  server.seed(META, a.raw, a.internalDate);
  for (let i = 0; i < 3_000; i++) {
    const hb = new Date(LEASE_NOW.getTime() - 5 * 3_600_000 + i * 1_000);
    server.seed(META, claimRaw({ installId: "install-x", heartbeat: hb, nonce: `x-${i}` }), hb);
  }
  const newest = new Date(LEASE_NOW.getTime() - 3 * 3_600_000);
  server.seed(META, claimRaw({ installId: "install-x", heartbeat: newest, nonce: "x-newest" }), newest);
  server.seed(META, "X-Ohmail-Lease: 1\r\nX-Ohmail-Lease: 1\r\nX-Ohmail-Install-Id: install-m\r\n\r\nmalformed\r\n",
    new Date(LEASE_NOW.getTime() - 5 * 3_600_000));
  /* Two stale records each of a newer protocol and of an unknown kind: the older is no winner, so
     only the protocol and kind filters keep it (a lone record is kept by condition 3 already). */
  for (const [h, n] of [[6, "a"], [5, "b"]] as const) {
    const at = new Date(LEASE_NOW.getTime() - h * 3_600_000);
    server.seed(META, claimRaw({ installId: "install-p2", heartbeat: at, nonce: `p2-${n}`, protocol: 2 }), at);
    server.seed(META, claimRaw({ installId: "install-k", heartbeat: at, nonce: `k-${n}` })
      .replace("X-Ohmail-Organizer-Kind: local", "X-Ohmail-Organizer-Kind: toaster"), at);
  }
  return server;
}

describe("L9: the residue drains in bounded passes, and only residue goes", () => {
  /**
   * MUTATIONS WATCHED RED: drop the cap (one pass takes the whole pile); drop the protocol filter; drop the
   * kind filter; drop the not-winner test (the stability check then keeps X's whole pile).
   */
  it("≤ 1 000 per pass, ≤ 200 per EXPUNGE, three passes; X's newest and the unrankable claims stay", async () => {
    const server = pile();
    let last = INCUMBENT_NONCE;
    const said: Array<Record<string, unknown>> = [];
    for (let pass = 1; pass <= 3; pass++) {
      const before = claimsBy(server, "install-x").length;
      const out = await gateOutcome({
        io: makeLeaseIo(server, toServerPath, { installId: INCUMBENT, mailboxId: "mbx" }), self: selfA(last),
        now: new Date(LEASE_NOW.getTime() + pass * 60_000), nonce: `a-${pass}`,
        log: (e, d) => { if (e === "lease_claim_residue") said.push(d); },
      });
      expect(out.word).toBe("organize");
      last = `a-${pass}`;
      expect(before - claimsBy(server, "install-x").length, `pass ${pass} removed more foreign records than a pass may`)
        .toBeLessThanOrEqual(RESIDUE_REMOVE_MAX_PER_PASS);
    }
    expect(Math.max(...expungeSizes(server)), "one EXPUNGE carried more than 200 uids").toBeLessThanOrEqual(200);
    expect(said[2], "the residue had not drained after three passes").toMatchObject({ remaining: 0 });
    expect(claimsBy(server, "install-x"), "X's newest claim went, or its residue stayed").toHaveLength(1);
    expect(claimsBy(server, "install-x")[0]).toContain("x-newest");
    expect(claimsBy(server, "install-m"), "a malformed claim was treated as residue").toHaveLength(1);
    expect(claimsBy(server, "install-p2"), "a claim of a newer protocol was treated as residue").toHaveLength(2);
    expect(claimsBy(server, "install-k"), "a claim of an unknown kind was treated as residue").toHaveLength(2);
    expect(claimsBy(server, INCUMBENT), "our own older claims were left behind").toHaveLength(1);
  });

  /** MUTATION WATCHED RED: let count mode remove, and the pile shrinks. */
  it("residue: \"count\" removes no foreign record and logs the plan; our own older claim still goes", async () => {
    const server = pile();
    const said: Array<Record<string, unknown>> = [];
    const out = await gateOutcome({
      io: makeLeaseIo(server, toServerPath, { installId: INCUMBENT, mailboxId: "mbx" }), self: selfA(INCUMBENT_NONCE),
      nonce: "a-1", residue: "count", log: (e, d) => { if (e === "lease_claim_residue") said.push(d); },
    });
    expect(out.word).toBe("organize");
    expect(said).toEqual([{ residue: 3_000, removed: 0, remaining: 3_000 }]);
    expect(claimsBy(server, "install-x")).toHaveLength(3_001);
    expect(claimsBy(server, INCUMBENT)).toHaveLength(1);
  });
});

describe("L10: a mixed fleet — a blind old build appending beside a new organizer", () => {
  /** X, an older build on a blind server, appends a fresh claim a minute and never confirms it. */
  function xAppends(server: MemoryImapServer, t: Date, press: Date | null): void {
    server.seed(META, claimRaw({ installId: "install-x", heartbeat: t, claimedAt: t, nonce: `x-${t.getTime()}`, authorizedAt: press }), t);
  }

  /** MUTATION WATCHED RED: drop the not-live test and X's fresh claims go, while A still organizes. */
  it("A organizes every minute for an hour, and X never holds more than 21 records", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], headerSearch: "blind" });
    for (const r of foreign600()) server.seed(META, r.raw, r.internalDate);
    let last = INCUMBENT_NONCE;
    let most = 0;
    for (let m = 1; m <= 60; m++) {
      const t = new Date(LEASE_NOW.getTime() + m * MIN);
      xAppends(server, new Date(t.getTime() - 20_000), null);
      const out = await gateOutcome({
        io: makeLeaseIo(server, toServerPath, { installId: INCUMBENT, mailboxId: "mbx" }), self: selfA(last), now: t, nonce: `a-${m}`,
      });
      expect(out.word, `minute ${m}`).toBe("organize");
      last = `a-${m}`;
      most = Math.max(most, claimsBy(server, "install-x").length);
    }
    expect(most, "X's pile grew past two windows of claims").toBeLessThanOrEqual(21);
    expect(claimsBy(server, "install-x").length, "X's live claims were removed").toBeGreaterThanOrEqual(19);
  });

  /**
   * THE RESIDUAL, ASSERTED (LEASE-BLIND-PRESSED-OLD-BUILD): X re-presents a press newer than A's,
   * so A stands down and nobody organizes. A press on A wins rule 6, displaces X, and keeps winning
   * while X goes on appending under its older press.
   */
  it("a pressed X stands A down; a newer press on A takes the mailbox and holds it", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], headerSearch: "blind" });
    for (const r of foreign600()) server.seed(META, r.raw, r.internalDate);
    const xPress = new Date(LEASE_NOW.getTime() - 30 * MIN);
    const t1 = new Date(LEASE_NOW.getTime() + MIN);
    xAppends(server, new Date(t1.getTime() - 20_000), xPress);
    const io = (): ReturnType<typeof makeLeaseIo> => makeLeaseIo(server, toServerPath, { installId: INCUMBENT, mailboxId: "mbx" });

    const residual = await gateOutcome({ io: io(), self: selfA(INCUMBENT_NONCE), now: t1, nonce: "a-1" });
    expect(residual.word, "the residual is no longer what the ruling files").toBe("stand_down:install-x");

    const t2 = new Date(LEASE_NOW.getTime() + 2 * MIN);
    xAppends(server, new Date(t2.getTime() - 20_000), xPress);
    const pressed = await gateOutcome({
      io: io(), self: selfA(INCUMBENT_NONCE), now: t2, nonce: "a-2", takeover: { authorizedAt: t2, intent: "takeover" },
    });
    expect(pressed.word).toBe("organize");
    expect(pressed.result?.verdict.verdict === "organize" && pressed.result.verdict.authorized).toBe(true);

    let last = "a-2";
    for (let m = 3; m <= 12; m++) {
      const t = new Date(LEASE_NOW.getTime() + m * MIN);
      xAppends(server, new Date(t.getTime() - 20_000), xPress);
      const out = await gateOutcome({ io: io(), self: selfA(last), now: t, nonce: `a-${m}` });
      expect(out.word, `minute ${m}: X's older press took the mailbox back`).toBe("organize");
      last = `a-${m}`;
    }
  });
});

// ── L19: THE FIELDS REACH THE LINE ───────────────────────────────────────────────────────────

describe("L19: every field the lease's new lines carry survives the real logger", () => {
  const LINES: Record<string, Record<string, unknown>> = {
    lease_meta_enumerated: { records: 601, claims: 1, total: 601 },
    lease_enum_refused: { code: "over_ceiling", records: 0, total: 20_001, ceiling: 20_000 },
    lease_enum_blind: { records: 601, total: 601 },
    lease_claim_residue: { residue: 3_000, removed: 1_000, remaining: 2_000 },
  };
  for (const [event, detail] of Object.entries(LINES)) {
    it(`${event} keeps ${Object.keys(detail).join(", ")}`, () => {
      const lines: string[] = [];
      const log = createLogger({ service: "worker", sink: (l) => { lines.push(l); } });
      log.info(event, detail);
      const emitted = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
      for (const [f, v] of Object.entries(detail)) {
        expect(ALLOWED_FIELDS, `${f} is off the census`).toContain(f);
        expect(emitted[f], `${f} was dropped by the logger`).toEqual(v);
      }
    });
  }
});
