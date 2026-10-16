import { describe, expect, it } from "vitest";

import { memoryImapServer } from "./_metaworld.js";

import {
  META_FOLDER,
  META_RECORDS_MAX_PER_FETCH,
  REQUEST_PAYLOAD_MAX_BYTES,
  REQUEST_PROTOCOL,
  REQUEST_REFUSAL_REASONS,
  acksIn,
  canonicalRequest,
  decodeRequestPayload,
  formatAck,
  formatClaim,
  formatRequest,
  isAckRecord,
  isMalformedRequest,
  isRequestRecord,
  isRequestKind,
  makeRequestOrganizerIo,
  makeRequestReaderIo,
  parseAck,
  parseClaim,
  parseRequestEnvelope,
  requestEnvelopesIn,
  classifyMetaRecord,
  META_RECORD_KINDS,
  RequestUnavailableError,
  signRequest,
  verifyRequestEnvelope,
  verifyRequestSignature,
  type LeaseImapClient,
  type MalformedRequestRecord,
  type RawMetaMessage,
  type RequestEnvelope,
  type RequestInput,
  type RequestRecord,
} from "@trafficflow/core/adapters/organizer-lease";

/** The io seams refuse a memory they cannot attribute, so every fixture states one. */
const TEST_META_ID = { installId: "test-install", mailboxId: "test-mailbox" };

/**
 * THE FORMAT LAYER for a reader's decision, mirroring `formatClaim` / `parseClaim`'s own suite in
 * shape. Pure, so every case here is a fact about the wire format rather than about a server.
 *
 * ── WHAT CHANGED WITH THE SIGNATURE, AND WHY THE PARSE IS NOW TWO STEPS ─────────────────────
 *
 * `parseRequest` used to read the headers AND decode the payload in one call. It cannot any more,
 * and the split is the security property rather than a refactor: an organizer must verify that a
 * record came from a holder of the account's key BEFORE it spends a base64 decode and a
 * `JSON.parse` on an attacker-chosen string. So `parseRequestEnvelope` reads and bounds the
 * headers and stops with the payload still encoded, and `decodeRequestPayload` is the second half
 * a caller reaches only after `verifyRequestEnvelope` has answered.
 */

const NOW = new Date("2026-09-03T12:00:00.000Z");
/** Any string works as an HMAC key; production keys are fixed-length base64url strings. */
const KEY = "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk";
const OTHER_KEY = "wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww";
const MAILBOX = "22222222-2222-4222-8222-222222222222";

function input(over: Partial<RequestInput> = {}): RequestInput {
  return {
    requestId: "11111111-1111-4111-8111-111111111111",
    kind: "screener.decide",
    mailboxId: MAILBOX,
    installId: "reader-install",
    organizerKind: "cloud",
    decidedAt: NOW,
    payload: { scope: "sender", decision: "yes", address: "person@example.com" },
    key: KEY,
    ...over,
  };
}

/** Parse + verify + decode, the way the drain does it, for the cases that expect all three to pass. */
function readWhole(raw: string, key = KEY): RequestRecord {
  const env = parseRequestEnvelope(raw);
  expect(env).not.toBeNull();
  expect(isMalformedRequest(env!)).toBe(false);
  expect(verifyRequestEnvelope(env as RequestEnvelope, key)).toBe(true);
  const decoded = decodeRequestPayload(env as RequestEnvelope);
  expect(isMalformedRequest(decoded)).toBe(false);
  return decoded as RequestRecord;
}

describe("formatRequest / parseRequestEnvelope — round trip", () => {
  it("round-trips every field", () => {
    const r = readWhole(formatRequest(input()));
    expect(r.requestId).toBe("11111111-1111-4111-8111-111111111111");
    expect(r.kind).toBe("screener.decide");
    expect(r.mailboxId).toBe(MAILBOX);
    expect(r.installId).toBe("reader-install");
    expect(r.organizerKind).toBe("cloud");
    expect(r.decidedAt.getTime()).toBe(NOW.getTime());
    expect(r.protocol).toBe(REQUEST_PROTOCOL);
    expect(r.payload).toEqual({ scope: "sender", decision: "yes", address: "person@example.com" });
  });

  it("carries the ref through when one is given", () => {
    const parsed = parseRequestEnvelope(formatRequest(input()), 42);
    expect((parsed as RequestEnvelope).ref).toBe(42);
  });

  /**
   * ── THE WHOLE POINT OF SHARING THE FOLDER: THIS MUST NEVER COLLIDE WITH A CLAIM OR A PROFILE
   * RECORD ────────────────────────────────────────────────────────────────────────────────────
   */
  it("never emits X-Ohmail-Lease or X-Ohmail-Profile — the two other record types in this folder", () => {
    const raw = formatRequest(input());
    expect(raw).not.toMatch(/X-Ohmail-Lease/i);
    expect(raw).not.toMatch(/X-Ohmail-Profile/i);
  });

  it("is invisible to parseClaim — a claim reader must not mistake it for a claim", () => {
    expect(parseClaim(formatRequest(input()))).toBeNull();
  });

  it("a claim is invisible to parseRequestEnvelope", () => {
    const claimRaw = [
      "X-Ohmail-Lease: 1",
      "X-Ohmail-Organizer-Kind: cloud",
      "X-Ohmail-Install-Id: them",
      "X-Ohmail-Protocol: 1",
      "X-Ohmail-Heartbeat: 2026-09-03T12:00:00.000Z",
      "X-Ohmail-Claimed-At: 2026-09-03T12:00:00.000Z",
      "X-Ohmail-Display-Name: Cloud",
      "X-Ohmail-Nonce: n",
      "Subject: ohmail organizer claim",
      "",
      "body",
      "",
    ].join("\r\n");
    expect(parseRequestEnvelope(claimRaw)).toBeNull();
  });

  it("a stray message with no discriminator is invisible", () => {
    expect(parseRequestEnvelope("Subject: hello\r\n\r\nbody\r\n")).toBeNull();
  });

  it("refuses a payload past the byte ceiling rather than truncating it", () => {
    const huge = { note: "x".repeat(REQUEST_PAYLOAD_MAX_BYTES * 2) };
    expect(() => formatRequest(input({ payload: huge }))).toThrow(/ceiling/);
  });

  /**
   * A record with no key behind it is refused by every organizer, so writing one leaves an
   * unverifiable message in a shared folder for nothing. The type makes the key required; this
   * holds the runtime half, because a caller with an EMPTY key still typechecks.
   */
  it("refuses to write a record with no key at all", () => {
    expect(() => formatRequest(input({ key: "" }))).toThrow(/request key/);
  });

  it("flattens CR/LF in a header-safe field so it cannot inject a header line", () => {
    const raw = formatRequest(input({ installId: "evil\r\nX-Injected: 1" }));
    expect(raw).not.toMatch(/^X-Injected:/m);
    expect(raw).toMatch(/X-Ohmail-Install-Id: evil X-Injected: 1\r\n/);
  });

  /**
   * The signature is taken over the HEADER-SAFE values, not the raw inputs. If it were taken over
   * the raw ones, a field that changes under `headerSafe` would be signed as one string and read
   * back as another — and this install would write records its own organizer refuses.
   */
  it("a record whose fields change under headerSafe still verifies", () => {
    const raw = formatRequest(input({ installId: "evil\r\nX-Injected: 1" }));
    const env = parseRequestEnvelope(raw) as RequestEnvelope;
    expect(verifyRequestEnvelope(env, KEY)).toBe(true);
  });
});

describe("parseRequestEnvelope — malformed evidence, never silently absent", () => {
  const RH = {
    request: "X-Ohmail-Request",
    requestId: "X-Ohmail-Request-Id",
    requestKind: "X-Ohmail-Request-Kind",
    mailboxId: "X-Ohmail-Request-Mailbox",
    installId: "X-Ohmail-Install-Id",
    organizerKind: "X-Ohmail-Organizer-Kind",
    decidedAt: "X-Ohmail-Decided-At",
    protocol: "X-Ohmail-Protocol",
    payload: "X-Ohmail-Request-Payload",
    sig: "X-Ohmail-Request-Sig",
  } as const;

  function rawWith(fields: Partial<Record<keyof typeof RH, string>>, extra: string[] = []): string {
    const defaults: Record<keyof typeof RH, string> = {
      request: "1",
      requestId: "11111111-1111-4111-8111-111111111111",
      requestKind: "screener.decide",
      mailboxId: MAILBOX,
      installId: "them",
      organizerKind: "cloud",
      decidedAt: "2026-09-03T12:00:00.000Z",
      protocol: "1",
      payload: Buffer.from("{}", "utf8").toString("base64url"),
      sig: "unused-here",
    };
    const merged = { ...defaults, ...fields };
    const lines = (Object.keys(RH) as (keyof typeof RH)[])
      .map((k) => `${RH[k]}: ${merged[k]}`)
      .concat(extra)
      .concat(["", "body", ""]);
    return lines.join("\r\n");
  }

  const bad = (raw: string): MalformedRequestRecord => parseRequestEnvelope(raw) as MalformedRequestRecord;

  it("a duplicate X-Ohmail-Request is malformed, never invisible", () => {
    const parsed = parseRequestEnvelope(rawWith({}, [`${RH.request}: 0`]));
    expect(parsed).not.toBeNull();
    expect((parsed as MalformedRequestRecord).malformed).toBe(true);
  });

  it("a duplicate field is malformed", () => {
    expect(bad(rawWith({}, [`${RH.installId}: someone-else`])).malformed).toBe(true);
  });

  /** The signature header is duplicate-checked too — two signatures is evidence, not a choice. */
  it("a duplicate signature header is malformed", () => {
    expect(bad(rawWith({}, [`${RH.sig}: second`])).malformed).toBe(true);
  });

  it("no request id is malformed", () => {
    expect(bad(rawWith({ requestId: "" })).malformed).toBe(true);
  });

  it("no mailbox id is malformed", () => {
    expect(bad(rawWith({ mailboxId: "" })).malformed).toBe(true);
  });

  it("an unreadable decided-at is malformed", () => {
    expect(bad(rawWith({ decidedAt: "not-a-date" })).malformed).toBe(true);
  });

  /**
   * Refused before decoding, and proven by SIZE rather than by trusting a reason string: an
   * oversized payload must never reach `JSON.parse` at all, because a hostile record would
   * otherwise buy an attacker-chosen amount of parsing work for free.
   */
  it("refuses an oversized encoded payload WITHOUT decoding it — the read-side bound", () => {
    const parsed = bad(rawWith({ payload: "A".repeat(REQUEST_PAYLOAD_MAX_BYTES + 1) }));
    expect(parsed.malformed).toBe(true);
    expect(parsed.reason).toMatch(/byte ceiling|exceeds/);
  });

  it("an ordinary well-formed payload, far under the ceiling, is never refused on length", () => {
    expect(isMalformedRequest(parseRequestEnvelope(formatRequest(input()))!)).toBe(false);
  });

  it("refuses an oversized requestId/kind/mailbox/installId — every field is bounded", () => {
    expect(bad(rawWith({ requestId: "x".repeat(200) })).malformed).toBe(true);
    expect(bad(rawWith({ requestKind: "x".repeat(200) })).malformed).toBe(true);
    expect(bad(rawWith({ mailboxId: "x".repeat(200) })).malformed).toBe(true);
    expect(bad(rawWith({ installId: "x".repeat(400) })).malformed).toBe(true);
  });

  it("an unrecognised protocol is malformed", () => {
    expect(bad(rawWith({ protocol: "0" })).malformed).toBe(true);
  });

  /**
   * An ABSENT signature is not a malformed record — it is an UNAUTHENTICATED one, and the two get
   * different dispositions from the drain (a refusal that names `unauthenticated`, versus one that
   * names `malformed`). Collapsing them would lose that distinction in the log an operator reads.
   */
  it("an absent signature parses, with an empty sig — it is unauthenticated, not malformed", () => {
    const raw = rawWith({}).split("\r\n").filter((l) => !l.startsWith(RH.sig)).join("\r\n");
    const parsed = parseRequestEnvelope(raw);
    expect(isMalformedRequest(parsed!)).toBe(false);
    expect((parsed as RequestEnvelope).sig).toBe("");
    expect(verifyRequestEnvelope(parsed as RequestEnvelope, KEY)).toBe(false);
  });

  /**
   * A kind this build has never heard of is NOT malformed — it parses, so the organizer's drain
   * can see it and leave it STANDING rather than have it sit invisible because a parser dropped it.
   */
  it("an unrecognised kind still parses — the drain decides what to do with it", () => {
    const parsed = parseRequestEnvelope(rawWith({ requestKind: "rule.delete_everything" }));
    expect(isMalformedRequest(parsed!)).toBe(false);
    expect((parsed as RequestEnvelope).kind).toBe("rule.delete_everything");
    expect(isRequestKind((parsed as RequestEnvelope).kind)).toBe(false);
  });

  it("REQUEST_KINDS matches the closed set the migration's CHECK carries", () => {
    expect(isRequestKind("screener.decide")).toBe(true);
    expect(isRequestKind("rule.create")).toBe(true);
    expect(isRequestKind("rule.update")).toBe(true);
    expect(isRequestKind("rule.delete")).toBe(true);
    expect(isRequestKind("something.else")).toBe(false);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE SIGNATURE — the whole of a record's authenticity
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
describe("signRequest / verifyRequestSignature", () => {
  const fields = {
    requestId: "r1", kind: "screener.decide", mailboxId: MAILBOX, installId: "i",
    decidedAt: NOW.toISOString(), protocol: 1, encodedPayload: "e30",
  };

  it("verifies what it signed", () => {
    expect(verifyRequestSignature(KEY, fields, signRequest(KEY, fields))).toBe(true);
  });

  it("refuses a signature made under a DIFFERENT key — the whole point of the key", () => {
    expect(verifyRequestSignature(KEY, fields, signRequest(OTHER_KEY, fields))).toBe(false);
  });

  it("refuses when ANY signed field is changed", () => {
    const sig = signRequest(KEY, fields);
    for (const k of ["requestId", "kind", "mailboxId", "installId", "decidedAt", "encodedPayload"] as const) {
      expect(verifyRequestSignature(KEY, { ...fields, [k]: `${fields[k]}x` }, sig)).toBe(false);
    }
    expect(verifyRequestSignature(KEY, { ...fields, protocol: 2 }, sig)).toBe(false);
  });

  /** Never throws, whatever it is handed — a forgery must not become an exception a catch retries. */
  it("returns false rather than throwing for an empty key, empty sig, or garbage sig", () => {
    expect(verifyRequestSignature("", fields, "x")).toBe(false);
    expect(verifyRequestSignature(KEY, fields, "")).toBe(false);
    expect(verifyRequestSignature(KEY, fields, "!!!not-base64!!!")).toBe(false);
    expect(verifyRequestSignature(KEY, fields, "AAAA")).toBe(false);
  });

  /**
   * ── THE CANONICAL FORM IS INJECTIVE, AND A JOINED ONE WOULD NOT BE ────────────────────────
   *
   * The attack a delimiter-joined canonical form allows: move a character across a field boundary
   * so two DIFFERENT records produce the SAME bytes to sign, and one signature then verifies both.
   * It needs no key. Length prefixes make the mapping injective, so this is two different strings
   * and two different signatures.
   */
  it("cannot be confused by moving content across a field boundary", () => {
    const a = { ...fields, requestId: "ab", kind: "cd" };
    const b = { ...fields, requestId: "a", kind: "bcd" };
    expect(canonicalRequest(a)).not.toBe(canonicalRequest(b));
    expect(signRequest(KEY, a)).not.toBe(signRequest(KEY, b));
    expect(verifyRequestSignature(KEY, b, signRequest(KEY, a))).toBe(false);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  ACKS — what the organizer said, carried back
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
describe("formatAck / parseAck", () => {
  it("round-trips an applied ack", () => {
    const a = parseAck(formatAck({ requestId: "r1", mailboxId: MAILBOX, outcome: "applied", ackedAt: NOW, key: KEY }), KEY);
    expect(a).not.toBeNull();
    expect(a!.outcome).toBe("applied");
    expect(a!.reason).toBeNull();
    expect(a!.ackedAt.getTime()).toBe(NOW.getTime());
  });

  it("round-trips a refused ack with its reason", () => {
    const raw = formatAck({ requestId: "r1", mailboxId: MAILBOX, outcome: "refused", reason: "conflict", ackedAt: NOW, key: KEY });
    const a = parseAck(raw, KEY);
    expect(a!.outcome).toBe("refused");
    expect(a!.reason).toBe("conflict");
  });

  /**
   * A forged ack is not harmless: `applied` on a decision nobody applied tells somebody their rule
   * exists when it does not. So the return path is signed too, and an unverifiable ack reads as
   * SILENCE — `null` — rather than as an outcome.
   */
  it("refuses an ack signed under a different key", () => {
    const raw = formatAck({ requestId: "r1", mailboxId: MAILBOX, outcome: "applied", ackedAt: NOW, key: OTHER_KEY });
    expect(parseAck(raw, KEY)).toBeNull();
  });

  it("refuses an ack whose outcome or reason was edited after signing", () => {
    const raw = formatAck({ requestId: "r1", mailboxId: MAILBOX, outcome: "refused", reason: "stale", ackedAt: NOW, key: KEY });
    expect(parseAck(raw.replace("refused", "applied"), KEY)).toBeNull();
    expect(parseAck(raw.replace("stale", "conflict"), KEY)).toBeNull();
  });

  it("refuses to write an ack with no key", () => {
    expect(() => formatAck({ requestId: "r1", mailboxId: MAILBOX, outcome: "applied", ackedAt: NOW, key: "" })).toThrow(/request key/);
  });

  /** A reason vocabulary this build does not know becomes `null`, never a stranger's text on screen. */
  it("keeps an unrecognised reason out of the record", () => {
    const raw = formatAck({
      requestId: "r1", mailboxId: MAILBOX, outcome: "refused",
      reason: "made-up-reason" as (typeof REQUEST_REFUSAL_REASONS)[number],
      ackedAt: NOW, key: KEY,
    });
    const a = parseAck(raw, KEY);
    expect(a!.outcome).toBe("refused");
    expect(a!.reason).toBeNull();
  });

  /**
   * AN ACK IS AN ANSWER FOR ONE MAILBOX, and the mailbox is inside what it signs.
   *
   * Without that, an acknowledgement genuinely produced for mailbox A is portable into mailbox B's
   * folder: it verifies there (same account key), and arriving at a lower uid than B's own answer
   * it wins the reader's first-wins match. A person is shown a refusal for a decision that WAS
   * applied, presses again, and a second rule is written.
   */
  it("an ack for one mailbox does not verify as an ack for another", () => {
    const raw = formatAck({
      requestId: "r1", mailboxId: MAILBOX, outcome: "refused", reason: "wrong_mailbox",
      ackedAt: NOW, key: KEY,
    });
    const parsed = parseAck(raw, KEY);
    expect(parsed!.mailboxId).toBe(MAILBOX);
    // Editing the header after signing breaks it, which is the whole point of signing it.
    expect(parseAck(raw.replace(MAILBOX, "99999999-9999-4999-8999-999999999999"), KEY)).toBeNull();
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  THE PROTOCOL-1 ACK SHAPE, PINNED — a constraint on whoever raises the number
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * `parseAck` hard-requires `X-Ohmail-Request-Mailbox` and folds it into the canonical bytes
   * unconditionally, so the acknowledgement's signed shape is FIXED at this protocol number. That
   * is fine today and costs nothing — no released build writes an ack without the field, so there
   * is no older shape in the wild to be tolerant of — and it is a trap for the next protocol,
   * because an ack field added later is a BREAKING change rather than an additive one: fold a new
   * field into the canonical bytes and every acknowledgement written by an older build fails
   * verification outright, so both installs in a pair start telling each other that genuine
   * records are unauthenticated.
   *
   * This pins the shape rather than widening the parser. A build that raises the number owes a
   * canonicalization keyed on the ack's OWN declared protocol, and this case is what it has to keep
   * green while it does.
   */
  it("PINNED: a protocol-1 ack carries the mailbox inside its signed body, and needs it", () => {
    const raw = formatAck({
      requestId: "r1", mailboxId: MAILBOX, outcome: "applied", ackedAt: NOW, key: KEY,
    });
    expect(raw).toContain(`X-Ohmail-Protocol: ${REQUEST_PROTOCOL}`);
    expect(raw).toContain(`X-Ohmail-Request-Mailbox: ${MAILBOX}`);

    const parsed = parseAck(raw, KEY);
    expect(parsed).not.toBeNull();
    expect(parsed!.protocol).toBe(REQUEST_PROTOCOL);
    expect(parsed!.mailboxId).toBe(MAILBOX);

    // REQUIRED at this protocol, not merely present: strip the header and the record is not an
    // acknowledgement at all. This is the half a later, tolerant parser must not lose for
    // protocol 1 while it teaches itself a newer shape.
    const without = raw.replace(`X-Ohmail-Request-Mailbox: ${MAILBOX}\r\n`, "");
    expect(without).not.toContain("X-Ohmail-Request-Mailbox");
    expect(parseAck(without, KEY)).toBeNull();
  });

  /** A duplicated discriminator is refused rather than resolved last-wins. */
  it("refuses an ack that announces itself twice", () => {
    const raw = formatAck({
      requestId: "r1", mailboxId: MAILBOX, outcome: "applied", ackedAt: NOW, key: KEY,
    });
    expect(parseAck(raw.replace("X-Ohmail-Ack: 1", "X-Ohmail-Ack: 1\r\nX-Ohmail-Ack: 1"), KEY)).toBeNull();
  });

  it("an ack is not a request, and a request is not an ack", () => {
    const ack = formatAck({ requestId: "r1", mailboxId: MAILBOX, outcome: "applied", ackedAt: NOW, key: KEY });
    const req = formatRequest(input());
    expect(isAckRecord(ack)).toBe(true);
    expect(isRequestRecord(ack)).toBe(false);
    expect(isAckRecord(req)).toBe(false);
    expect(isRequestRecord(req)).toBe(true);
    expect(parseRequestEnvelope(ack)).toBeNull();
    expect(parseAck(req, KEY)).toBeNull();
  });
});

// ── the IO pair, against an in-memory fake client ───────────────────────────────────────────

function fakeMetaClient(): LeaseImapClient & { store: Map<number, string> } {
  const store = new Map<number, string>();
  let nextUid = 1;
  const path = META_FOLDER;
  return {
    store,
    async list() {
      return [{ path, subscribed: false }];
    },
    async mailboxCreate() { return {}; },
    async mailboxUnsubscribe() { return true; },
    async getMailboxLock() { return { release() { /* no-op */ } }; },
    get mailbox() { return { exists: store.size }; },
    fetch(
      range: string,
      _query?: unknown,
      options?: { uid?: boolean },
    ): AsyncIterableIterator<{ uid: number; headers?: Buffer }> {
      /* ── THE MESSAGESET IS HONOURED, AND THIS CLAIMED IT WHILE NOT DOING IT ────────────────
       *
       * The comment here already said the messageset was honoured; the code matched only `n:m`
       * and fell through to THE WHOLE FOLDER for anything else. A comma-separated uid list — the
       * form every custody read-back and every search result is fetched by — therefore returned
       * every message in the store, so a read asking "is uid 3 still there?" was answered "yes"
       * by uid 4. That is the second double in this package with this exact defect, and it is the
       * one that turns a correct custody proof into a false failure rather than a false pass.
       *
       * Explicit sets are matched by UID when `{ uid: true }` is passed and by sequence number
       * otherwise, and a set this cannot parse REFUSES rather than becoming the widest possible
       * answer. */
      const all = [...store.entries()];
      const trimmed = range.trim();
      const entries = ((): Array<[number, string]> => {
        if (/^\d+(,\d+)*$/.test(trimmed)) {
          const wanted = new Set(trimmed.split(",").map(Number));
          return options?.uid === true
            ? all.filter(([uid]) => wanted.has(uid))
            : all.filter((_e, i) => wanted.has(i + 1));
        }
        const m = /^(\d+):(\*|\d+)$/.exec(trimmed);
        if (m === null) throw new Error(`the fake cannot parse the messageset ${JSON.stringify(range)}`);
        return all.slice(Math.max(0, Number(m[1]) - 1), m[2] === "*" ? all.length : Number(m[2]));
      })();
      return (async function* () {
        for (const [uid, raw] of entries) yield { uid, headers: Buffer.from(raw, "utf8") };
      })();
    },
    async append(_p, content) {
      const uid = nextUid++;
      store.set(uid, typeof content === "string" ? content : content.toString("utf8"));
      return { uid };
    },
    async messageDelete(range) {
      for (const uid of range) store.delete(uid);
      return true;
    },
  };
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE COMPACTOR, WHICH IS THE ONLY THING THAT EVER MAKES THIS FOLDER SMALLER
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `ohmail/_meta` fills with acknowledgements in ordinary use -- one per decision a reader makes --
 * and the bounded read refuses a folder past the ceiling. The sweep is what keeps that from being
 * a one-way door, so every way it can report work it did not do costs the folder its only exit.
 */
describe("the ack sweep reports only what it established", () => {
  const SWEEP_META = "INBOX.ohmail._meta";
  const sweepPath = (canonical: string): string => canonical.replace(/\//g, ".");
  const ACK_NOW = new Date("2026-09-05T13:00:00.000Z");

  function ackRaw(id: string): string {
    return formatAck({
      requestId: id, mailboxId: MAILBOX, outcome: "applied", ackedAt: ACK_NOW, key: KEY,
    });
  }

  /**
   * A CONNECTION THAT CANNOT READ THE FOLDER IS A REFUSAL, NOT AN EMPTY SWEEP. A caller told "0
   * stale" concludes there is nothing to compact, and the compactor is the only way out of a folder
   * the read refuses. The sweep asks by FETCH alone, so a connection without one refuses by name.
   * (Twin of "a refused search with no fallback", which went with the SEARCH form, FIX-026.)
   *
   * MUTATION WATCHED RED: return 0 when the connection has no FETCH and this resolves with a count.
   */
  it("a connection with no FETCH is a refusal by name, not an empty sweep", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", SWEEP_META] });
    server.seed(SWEEP_META, ackRaw("a-1"), new Date(ACK_NOW.getTime() - 72 * 3_600_000));
    const { fetch: _noFetch, ...noReadBack } = server;
    const io = makeRequestOrganizerIo(noReadBack as unknown as LeaseImapClient, sweepPath, TEST_META_ID);

    await expect(io.sweepStaleAcks(new Date(ACK_NOW.getTime() - 24 * 3_600_000)),
      "a connection that cannot read the folder was reported as one with nothing to sweep")
      .rejects.toMatchObject({ name: "RequestUnavailableError", code: "sweep_no_reader" });
  });

  /**
   * ── THE SWEEP READS IN UID WINDOWS, AND NEVER ASKS SEARCH ─────────────────────────────────
   *
   * One unbounded question would put every stale acknowledgement in memory before any batching
   * ran; a header SEARCH a server answers with nothing would report none stale. So the sweep FETCHes
   * the headers of one `lo:hi` uid window at a time. (Twin of "searches … inside a uid window".)
   *
   * MUTATION WATCHED RED: fetch `1:*` instead of the window and the range arrives unbounded.
   */
  it("fetches stale acknowledgements inside a uid window, never bare, and asks no SEARCH", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", SWEEP_META] });
    const old = new Date(ACK_NOW.getTime() - 72 * 3_600_000);
    for (let i = 0; i < 20; i++) server.seed(SWEEP_META, ackRaw(`a-${i}`), old);

    const swept = await makeRequestOrganizerIo(server, sweepPath, TEST_META_ID)
      .sweepStaleAcks(new Date(ACK_NOW.getTime() - 24 * 3_600_000));

    expect(swept).toBe(20);
    const windows = server.log.filter((l) => l.startsWith(`fetch ${SWEEP_META} `) && !l.includes(","))
      .map((l) => l.slice(`fetch ${SWEEP_META} `.length))
      .filter((r) => r.includes(":"));
    expect(windows.length, "the sweep read no window at all").toBeGreaterThan(0);
    for (const r of windows) {
      expect(/^\d+:\d+$/.test(r), `the sweep asked the server an unbounded question: ${r}`).toBe(true);
    }
    expect(server.log.filter((l) => l.startsWith("search ")), "the sweep asked SEARCH").toEqual([]);
  });

  /**
   * ── AND ONE CYCLE IS A DAY'S WORK, NOT ALL OF IT ──────────────────────────────────────────
   *
   * The delete loop ran a batch for every uid the search returned, so a folder holding a huge
   * backlog was one cycle's work and the drain behind it waited for the whole thing.
   *
   * The sweep can be cut short in a way the election cannot, and this case is the reason it is
   * safe to: DELETION IS DURABLE PROGRESS. What one cycle removes stays removed, so a bounded
   * sweep is the same answer arriving over more cycles — which the second call here shows by
   * finishing the job.
   *
   * ── WHICH MUTATION REDDENS THIS, AND WHICH ONE LOOKED LIKE IT WOULD ──────────────────────
   *
   * The obvious one — let the delete loop run a batch for every uid it holds — leaves this GREEN,
   * and the reason is the failure mode this branch keeps meeting: A SECOND MECHANISM COVERS FOR
   * THE ONE UNDER TEST. The walk above stops as soon as it holds a cycle's worth, so the reply can
   * never exceed what the loop was clamped to, and the clamp measured nothing. It has been removed
   * rather than left looking like protection.
   *
   * MUTATIONS WATCHED RED, and there are two because there are two bounds:
   *   - drop `found.length >= wanted` from the walk's stop condition, and the search runs to the
   *     bottom of the folder, so one cycle holds every record;
   *   - drop the delete clamp, and the cycle deletes the whole overshooting reply.
   * The second is the one an aligned fixture could not see.
   */
  it("sweeps a bounded share per cycle, and the next cycle takes the rest", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", SWEEP_META] });
    const old = new Date(ACK_NOW.getTime() - 72 * 3_600_000);
    /* ── A HOLE, SO THE WINDOWS DO NOT SUM TO THE BUDGET ────────────────────────────────────
     *
     * The first version seeded a contiguous run, and the search windows happened to fall so that
     * two of them summed to exactly the per-cycle budget. That made the delete clamp look dead
     * under mutation and it was removed on the strength of it — the fixture's alignment read as a
     * property of the code. One skipped uid is enough to break the alignment: the top window then
     * comes back one short, the walk takes another full window, and the reply overshoots the
     * budget the way it can in a real folder.
     *
     * The seeded records are laid out to make that overshoot happen rather than to be tidy. */
    const SEEDED = 1_499;
    let skipped = false;
    for (let i = 0; i < SEEDED; i++) {
      if (!skipped && i === 1_000) { server.seed(SWEEP_META, "Subject: hole\r\n\r\nnot an ack", old); skipped = true; }
      server.seed(SWEEP_META, ackRaw(`a-${i}`), old);
    }
    const io = makeRequestOrganizerIo(server, sweepPath, TEST_META_ID);
    const cutoff = new Date(ACK_NOW.getTime() - 24 * 3_600_000);

    const first = await io.sweepStaleAcks(cutoff);

    expect(first, "one cycle swept the entire backlog, so the cycle is unbounded").toBeLessThan(SEEDED);
    expect(first, "the sweep removed nothing at all").toBeGreaterThan(0);

    /* DURABLE: the second cycle starts from a genuinely smaller folder and finishes. */
    const second = await io.sweepStaleAcks(cutoff);
    expect(first + second, "the two cycles together did not clear the backlog").toBe(SEEDED);
  });

  /**
   * ── THE GENERATION MUST BE THE META FOLDER'S, NOT WHATEVER IS SELECTED ────────────────────
   *
   * Positions in `ohmail/_meta` are checked against that folder's numbering. The io answered with
   * `client.mailbox` at the moment of asking, which is whatever folder the surrounding cycle last
   * had open — for the worker, the mailbox being synced. That is not a stale generation, it is a
   * DIFFERENT FOLDER'S, and it answers wrongly in both directions: it calls a good position stale
   * and a stale one good. Through the entry those positions share, it also took the claim and
   * settings anchors down with it.
   *
   * Here the two folders deliberately carry different numbering, and something else is selected
   * when the question is asked.
   *
   * MUTATION WATCHED RED: answer with `generationOf(client)` again and the io reports the INBOX's
   * generation for the meta folder.
   */
  it("reports the meta folder's generation, not that of whatever was selected", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", SWEEP_META] });
    /* Give the two folders different numbering, the way a recreated mailbox would. */
    server.renumber("INBOX");
    server.renumber("INBOX");
    const metaGeneration = 1_000;   // untouched; INBOX is now 1002

    const io = makeRequestOrganizerIo(server, sweepPath, TEST_META_ID);

    await io.listMetaRecords();
    /* ── AND SOMETHING ELSE IS OPEN BY THE TIME THE QUESTION IS ASKED ────────────────────────
     *
     * Ordering is the whole case, and the first version of it had the order wrong: it selected
     * the INBOX BEFORE the read, and the read then selected `_meta` and left it selected — so
     * both the right answer and the wrong one agreed, and the mutation passed. The drain asks for
     * the generation when it records a position, which is after its read and after the
     * surrounding cycle has moved on to the mailbox being synced. That is the moment to ask. */
    await server.getMailboxLock("INBOX");

    expect(io.uidValidity?.(),
      "the io answered with the selected folder's generation rather than the meta folder's")
      .toBe(metaGeneration);
  });

  /**
   * ── THE SWEEP CARRIES ON DOWNWARD; IT DOES NOT RE-WALK THE SAME STRETCH ───────────────────
   *
   * Bounding the search per pass is what makes it affordable, and on its own it made the sweep a
   * treadmill: every pass began at the top of the uid space and reached the same fixed depth, so
   * an acknowledgement lying below that depth was never once looked at. The folder cannot be
   * compacted below such a record, and this sweep is the only thing that ever makes it smaller —
   * so the folder stays over the read ceiling for good, which is the state the sweep exists to
   * prevent.
   *
   * A record far enough down to be past one pass's reach and inside a handful of
   * passes' reach, which is exactly the property under test.
   *
   * MUTATION WATCHED RED: start every pass at the ceiling — drop the resume — and no number of
   * cycles ever reaches it.
   */
  it("reaches an acknowledgement far below one pass's depth, over several passes", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", SWEEP_META] });
    const old = new Date(ACK_NOW.getTime() - 72 * 3_600_000);
    /* THE DEEP ONE, written first so it sits at the bottom of the uid space. */
    server.seed(SWEEP_META, ackRaw("the-deep-one"), old);
    /* A stretch of ordinary mail above it, deeper than a single pass looks. */
    for (let i = 0; i < 7_000; i++) {
      server.seed(SWEEP_META, `Subject: newsletter ${i}\r\n\r\nbody`, old);
    }
    const io = makeRequestOrganizerIo(server, sweepPath, TEST_META_ID);
    const cutoff = new Date(ACK_NOW.getTime() - 24 * 3_600_000);

    let swept = 0;
    for (let cycle = 0; cycle < 20 && swept === 0; cycle++) {
      swept = await io.sweepStaleAcks(cutoff);
    }

    expect(swept,
      "every pass looked at the same stretch, so the deep acknowledgement was never reached")
      .toBe(1);
  });

  /**
   * ── THE MARK MOVES OVER WHAT WAS REMOVED, NOT OVER WHAT WAS MERELY LOOKED AT ──────────────
   *
   * The walk can return more than one pass may delete: it tests its running total only after
   * taking a whole step, so it comes back with up to a step-size more than the budget. Moving the
   * resume mark during the walk claimed that whole stretch was dealt with, and the surplus was
   * still sitting in it — above a mark that says not to look there again. The same write also
   * happened before any expunge had been attempted at all, so a refused expunge left the mark
   * past records that had only been read.
   *
   * Here the two passes together must clear the backlog. They can only do that if the first pass
   * leaves its mark where the surplus is still reachable.
   *
   * MUTATION WATCHED RED: move the mark during the walk again — the second pass starts below the
   * the records the first one could not delete, and they are never swept.
   */
  it("leaves the surplus above its resume mark, so the next pass still finds it", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", SWEEP_META] });
    const old = new Date(ACK_NOW.getTime() - 72 * 3_600_000);
    /* ── DEEP ENOUGH THAT THE WALK OVERSHOOTS WITHOUT REACHING THE BOTTOM ──────────────────
     *
     * The first attempt at this fixture bottomed out instead, so the branch that moves the mark
     * mid-walk was never taken and the mutation below could not redden it — the case named a
     * mutation it did not exercise, which is the same false-comfort shape as a guard that cannot
     * fail. `SEEDED` records put the third step well clear of the bottom, and one non-ack
     * near the top misaligns the steps so the walk returns more than a pass may delete. */
    const SEEDED = 2_000;
    for (let i = 0; i < SEEDED; i++) {
      if (i === 1_749) server.seed(SWEEP_META, "Subject: hole\r\n\r\nnot an ack", old);
      server.seed(SWEEP_META, ackRaw(`a-${i}`), old);
    }
    const io = makeRequestOrganizerIo(server, sweepPath, TEST_META_ID);
    const cutoff = new Date(ACK_NOW.getTime() - 24 * 3_600_000);

    const first = await io.sweepStaleAcks(cutoff);
    const second = await io.sweepStaleAcks(cutoff);

    expect(first, "the first pass was not bounded").toBeLessThan(SEEDED);
    expect(first + second,
      "the surplus fell above the resume mark and the second pass looked straight past it")
      .toBe(SEEDED);
    /* Two passes and no more: a later pass would eventually wrap to the top and find the skipped
     * records anyway, which is exactly how this defect hides. */
  });

  /**
   * AND AN EXPUNGE THAT RESOLVED `true` IS NOT A REMOVAL. A refused STORE under an accepted
   * EXPUNGE resolves `true` and removes nothing, so the sweep would report a compaction while the
   * folder stayed exactly as full -- and the next read would refuse for the same reason, for ever.
   *
   * MUTATION WATCHED RED: drop the custody read and this resolves with a count.
   */
  it("an expunge that removed nothing is not a sweep", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", SWEEP_META] });
    server.seed(SWEEP_META, ackRaw("a-1"), new Date(ACK_NOW.getTime() - 72 * 3_600_000));
    server.startLyingAboutDeletes();
    const io = makeRequestOrganizerIo(server, sweepPath, TEST_META_ID);

    await expect(io.sweepStaleAcks(new Date(ACK_NOW.getTime() - 24 * 3_600_000)),
      "a sweep that removed nothing reported a compaction, so the folder never recovers")
      .rejects.toThrow(/survived the expunge|could not be verified/);
  });

  /**
   * ── THE CUTOFF IS A DATE, AND THE LIBRARY WIDENS IT ───────────────────────────────────────
   *
   * IMAP searches BEFORE by DATE. Where the server does not advertise `WITHIN`, the client turns a
   * cutoff carrying a time of day into a date-only term and ADVANCES it by a day, so that a reader
   * asking for "older than this instant" is never given less than it asked for. For something that
   * DELETES that direction is wrong: the widened term reaches records filed on the cutoff's own
   * day, and an acknowledgement a person is still waiting on is removed as though it were a day
   * past its life. Flooring the cutoff to midnight puts the error on the safe side.
   *
   * MUTATION WATCHED RED: pass the raw cutoff instead of the floored one and the 13-hour-old
   * acknowledgement is swept.
   */
  it("does not remove an acknowledgement younger than the life it is given", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", SWEEP_META] });
    /* SEVENTEEN hours old against a twenty-four hour life: not stale by any reading, and filed on
     * the cutoff's OWN DAY, which is the only place the widening can be seen. An acknowledgement
     * further back than that is outside the widened term as well and would pass either way -- the
     * first version of this case put it exactly on midnight and proved nothing. */
    const young = server.seed(
      SWEEP_META, ackRaw("young"), new Date(ACK_NOW.getTime() - 17 * 3_600_000),
    );
    const io = makeRequestOrganizerIo(server, sweepPath, TEST_META_ID);

    await io.sweepStaleAcks(new Date(ACK_NOW.getTime() - 24 * 3_600_000));

    expect(server.tree.get(SWEEP_META)!.messages.map((m) => m.uid),
      "an acknowledgement barely half a day old was swept as though it were stale")
      .toContain(young);
  });

  /**
   * AND SETTLING A REQUEST TAKES THE SAME PROOF. The drain counts a request applied or refused
   * from a clean return here; if the record is still in the folder the next cycle reads it again,
   * and the counters go on saying the drain is working.
   *
   * MUTATION WATCHED RED: drop the custody read from `remove` and this resolves.
   */
  it("a settled request that survived its own expunge is not removed", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", SWEEP_META] });
    const uid = server.seed(SWEEP_META, ackRaw("settled"));
    server.startLyingAboutDeletes();
    const io = makeRequestOrganizerIo(server, sweepPath, TEST_META_ID);

    await expect(io.remove([uid]),
      "a record that is still in the folder was reported as removed")
      .rejects.toThrow(RequestUnavailableError);
  });
});

describe("the reader / organizer IO pair", () => {
  it("a reader appends; an organizer lists, acks and removes", async () => {
    const client = fakeMetaClient();
    const reader = makeRequestReaderIo(client, (c) => c);
    const organizer = makeRequestOrganizerIo(client, (c) => c, TEST_META_ID);

    expect(await reader.listMetaRecords()).toEqual({ records: [], count: 0, bytes: 0 });

    await reader.append(formatRequest(input()));
    const { records } = await organizer.listMetaRecords();
    const envelopes = requestEnvelopesIn(records);
    expect(envelopes).toHaveLength(1);
    expect((envelopes[0] as RequestEnvelope).requestId).toBe("11111111-1111-4111-8111-111111111111");

    await organizer.ack(formatAck({ requestId: "11111111-1111-4111-8111-111111111111", mailboxId: MAILBOX, outcome: "applied", ackedAt: NOW, key: KEY }));
    await organizer.remove(envelopes.map((e) => (e as RequestEnvelope).ref));

    const { records: after } = await organizer.listMetaRecords();
    expect(requestEnvelopesIn(after)).toEqual([]);
    expect(acksIn(after, KEY)).toHaveLength(1);
  });

  /**
   * THE READER'S OBJECT HAS NO EXPUNGE, and this is a structural assertion rather than a
   * behavioural one: the verb is not on the object, so a reader cannot reach for it by mistake.
   */
  it("a reader's IO exposes no remove and no ack", () => {
    const reader = makeRequestReaderIo(fakeMetaClient(), (c) => c);
    expect((reader as Record<string, unknown>).remove).toBeUndefined();
    expect((reader as Record<string, unknown>).ack).toBeUndefined();
    expect(typeof reader.append).toBe("function");
    expect(typeof reader.listMetaRecords).toBe("function");
  });

  /**
   * ── AN ABSENT FOLDER RAISES, AND THAT IS A CORRECTNESS FIX ───────────────────────────────
   *
   * It used to answer `[]`. For the READER that meant "none of my records are in the folder",
   * which its state machine read as "the organizer took them all" — so a missing folder reported
   * every outstanding decision as applied, at the exact moment the evidence was that nobody was
   * organizing the mailbox at all.
   */
  it("raises rather than reporting an empty folder when the folder does not exist", async () => {
    const client = fakeMetaClient();
    let created = false;
    (client as { mailboxCreate: () => Promise<unknown> }).mailboxCreate = async () => {
      created = true;
      return {};
    };
    client.list = async () => [];
    const reader = makeRequestReaderIo(client, (c) => c);
    await expect(reader.listMetaRecords()).rejects.toThrow(/does not exist/);
    expect(created).toBe(false);
  });

  it("does not fetch when the mailbox is positively known to be empty", async () => {
    const client = fakeMetaClient();
    let fetched = 0;
    const baseFetch = client.fetch.bind(client);
    client.fetch = ((...args: Parameters<typeof baseFetch>) => {
      fetched += 1;
      return baseFetch(...args);
    }) as typeof client.fetch;
    const reader = makeRequestReaderIo(client, (c) => c);
    expect(await reader.listMetaRecords()).toEqual({ records: [], count: 0, bytes: 0 });
    expect(fetched).toBe(0);
  });

  /**
   * ONE ROUND TRIP: requests and acks come off a single FETCH and the parsers sort them out. A claim
   * is in the folder too and is counted, but the drains have no use for it, so it is not listed.
   */
  it("serves requests and acks from ONE fetch, and counts the claim beside them", async () => {
    const client = fakeMetaClient();
    let fetches = 0;
    const baseFetch = client.fetch.bind(client);
    const ranges: string[] = [];
    client.fetch = ((...args: Parameters<typeof baseFetch>) => {
      fetches += 1;
      ranges.push(args[0]);
      return baseFetch(...args);
    }) as typeof client.fetch;

    const organizer = makeRequestOrganizerIo(client, (c) => c, TEST_META_ID);
    client.store.set(1, formatClaim({
      installId: "cloud", kind: "cloud", displayName: "Cloud",
      heartbeat: NOW, claimedAt: NOW, nonce: "n", authorizedAt: null, capabilities: ["requests"],
    }));
    client.store.set(2, formatRequest(input({ requestId: "the-request" })));
    client.store.set(3, formatAck({ requestId: "other", mailboxId: MAILBOX, outcome: "refused", reason: "stale", ackedAt: NOW, key: KEY }));

    const { records, count } = await organizer.listMetaRecords();
    /* ── ONE RECORD READ, AND THE PROPERTY IS ABOUT KINDS RATHER THAN ROUND TRIPS ───────────
     *
     * The claim this case exists for is that the folder's three record KINDS come off ONE read
     * rather than one read each — which is what `1:*` below is, and what the count of RANGES pins.
     *
     * The count question is asked separately and is NOT a fetch: a bare `*` never reaches a server,
     * because ImapFlow rewrites it from its own cached count before issuing the command, so the
     * probe is a SEARCH. This fake offers neither `noop` nor `search`, so the count can never be
     * learned and the read falls back to `1:*` — which is the range asserted here. A real
     * connection answers its NOOP and asks nothing extra at all. */
    expect(ranges).toEqual(["1:*"]);
    expect(fetches).toBe(1);
    expect(count).toBe(3);
    expect(records).toHaveLength(2);
    expect(requestEnvelopesIn(records)).toHaveLength(1);
    expect(acksIn(records, KEY)).toHaveLength(1);
    expect(records.some((m: RawMetaMessage) => m.ref === 1), "a claim was listed as a request").toBe(false);
  });

  /**
   * PAST THE WINDOW THE READ IS COMPLETE OR IT REFUSES. A connection that cannot count the folder
   * cannot prove an enumeration complete, so a folder past 500 refuses by name (`no_count`) rather
   * than answering from part of it; the drains treat that as a look that failed. A partial view
   * would read "my record is not here" as "the organizer took it".
   */
  it("REFUSES a folder past the window it cannot count, rather than answering from part of it", async () => {
    const client = fakeMetaClient();
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH + 25; i++) {
      client.store.set(i + 1, `Subject: junk ${i}\r\n\r\nbody`);
    }
    const organizer = makeRequestOrganizerIo(client, (c) => c, TEST_META_ID);
    await expect(organizer.listMetaRecords()).rejects.toMatchObject({ name: "RequestUnavailableError", code: "no_count" });
  });

  /** The boundary itself is COMPLETE. A folder holding exactly the window is read by the window. */
  it("reads a folder holding exactly META_RECORDS_MAX_PER_FETCH records without refusing", async () => {
    const client = fakeMetaClient();
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH; i++) {
      client.store.set(i + 1, `Subject: junk ${i}\r\n\r\nbody`);
    }
    const organizer = makeRequestOrganizerIo(client, (c) => c, TEST_META_ID);
    expect((await organizer.listMetaRecords()).count).toBe(META_RECORDS_MAX_PER_FETCH);
  });

  /** A ref this cannot address is not a no-op to report as done — it throws instead. */
  it("refuses to report success for a ref it cannot address", async () => {
    const organizer = makeRequestOrganizerIo(fakeMetaClient(), (c) => c, TEST_META_ID);
    await expect(organizer.remove(["not-a-uid"])).rejects.toThrow(/addressable/);
  });
});

/**
 * `ohmail/_meta` IS SHARED — a claim, a profile record, a request and an ack all live in it, so a
 * caller that counts MESSAGES is not counting requests.
 */
describe("isRequestRecord — the cheap negative that keeps a shared folder's count honest", () => {
  it("is true for a record this module formats", () => {
    expect(isRequestRecord(formatRequest(input()))).toBe(true);
  });

  it("is FALSE for an organizer's claim — the message that is always in the folder", () => {
    const claim = formatClaim({
      installId: "i", kind: "cloud", displayName: "Cloud",
      heartbeat: new Date(), claimedAt: new Date(), nonce: "n", authorizedAt: null,
      capabilities: ["requests"],
    });
    // NOTE the capability header names `requests` — a substring match would call this a request.
    expect(claim).toMatch(/requests/);
    expect(isRequestRecord(claim)).toBe(false);
  });

  /**
   * IT MUST AGREE WITH THE PARSER ABOUT DUPLICATES, or a message becomes permanent residue.
   *
   * This returned on the FIRST occurrence while `parseRequestEnvelope` refuses duplicates. So a
   * message whose first `X-Ohmail-Request` is not `1` never reached the parser at all, the
   * `malformed` disposition was unreachable, and nothing could ever remove it — one APPEND buying
   * a message every drain and every lease read re-fetches for ever.
   *
   * MUTATION WATCHED RED: restore the early `return line.slice(at + 1).trim() === "1";` and this
   * case answers false while the parser calls it malformed.
   */
  it("hands a REPEATED discriminator to the parser, whatever the first value says", () => {
    const twice = "X-Ohmail-Request: 0\r\nX-Ohmail-Request: 1\r\n\r\nbody";
    expect(isRequestRecord(twice), "the parser never sees it, so it can never be removed").toBe(true);
    const parsed = parseRequestEnvelope(twice, 1);
    expect(isMalformedRequest(parsed!)).toBe(true);
  });

  it("is false for a stray message, and for a marker that is not exactly 1", () => {
    expect(isRequestRecord("Subject: hello\r\n\r\nbody")).toBe(false);
    expect(isRequestRecord("X-Ohmail-Request: 0\r\n\r\n")).toBe(false);
    expect(isRequestRecord("X-Ohmail-Request: yes\r\n\r\n")).toBe(false);
  });

  it("agrees with parseRequestEnvelope on what is NOT a request — one rule, two readers", () => {
    const claim = formatClaim({
      installId: "i", kind: "cloud", displayName: "Cloud",
      heartbeat: new Date(), claimedAt: new Date(), nonce: "n", authorizedAt: null,
      capabilities: [],
    });
    expect(isRequestRecord(claim)).toBe(false);
    expect(parseRequestEnvelope(claim, 1)).toBeNull();
  });

  /**
   * MUTATION WATCHED RED: drop the `if (!isRequestRecord(m.raw)) continue;` line in
   * `requestEnvelopesIn` and this returns the claim as well.
   */
  it("requestEnvelopesIn skips a claim sitting beside a request in the same folder", () => {
    const records: RawMetaMessage[] = [
      { ref: 1, raw: formatClaim({
        installId: "cloud", kind: "cloud", displayName: "Cloud",
        heartbeat: NOW, claimedAt: NOW, nonce: "n", authorizedAt: null, capabilities: ["requests"],
      }) },
      { ref: 2, raw: formatRequest(input({ requestId: "the-request" })) },
    ];
    const envelopes = requestEnvelopesIn(records);
    expect(envelopes).toHaveLength(1);
    expect((envelopes[0] as RequestEnvelope).requestId).toBe("the-request");
  });

  it("a folder holding ONLY claims yields no envelopes at all", () => {
    const records: RawMetaMessage[] = [{ ref: 1, raw: formatClaim({
      installId: "cloud", kind: "cloud", displayName: "Cloud",
      heartbeat: NOW, claimedAt: NOW, nonce: "n", authorizedAt: null, capabilities: [],
    }) }];
    expect(requestEnvelopesIn(records)).toEqual([]);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE PARSER REGISTRY — one discriminator per kind, and it is what the readers use
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `ohmail/_meta` is read and written by builds that update on completely different clocks. The
 * module header defines the wire format once; this is the half of it that is data rather than
 * prose, and these cases are what stop the two drifting.
 *
 * A registry nothing consults is decoration, so the last case here asserts that the folder's own
 * sorting helpers go through it.
 */
describe("the meta-folder record registry", () => {
  const KINDS = ["claim", "request", "ack", "profile"] as const;

  it("names every kind the folder holds, once, with its own discriminator", () => {
    expect(META_RECORD_KINDS.map((k) => k.kind)).toEqual([...KINDS]);
    const headers = META_RECORD_KINDS.map((k) => k.header.toLowerCase());
    expect(new Set(headers).size, "two kinds share a discriminator").toBe(headers.length);
  });

  it("classifies each of the three this module parses, and only that one", () => {
    const claim = formatClaim({
      installId: "us", kind: "cloud", displayName: "Cloud", claimedAt: NOW, heartbeat: NOW,
      nonce: "n", authorizedAt: null, capabilities: [], protocol: 1,
    });
    const request = formatRequest(input());
    const ack = formatAck({ requestId: "r1", mailboxId: MAILBOX, outcome: "applied", ackedAt: NOW, key: KEY });

    expect(classifyMetaRecord(claim)).toBe("claim");
    expect(classifyMetaRecord(request)).toBe("request");
    expect(classifyMetaRecord(ack)).toBe("ack");
  });

  /**
   * A RECORD THIS BUILD CANNOT NAME IS `null`, AND THAT IS A REAL ANSWER. Somebody else's mail
   * client may keep something in this folder; it is not ours to parse, count or destroy.
   */
  it("answers null for a record it does not recognise", () => {
    expect(classifyMetaRecord("Subject: somebody else's note\r\n\r\nbody")).toBeNull();
    expect(classifyMetaRecord("X-Ohmail-Something-Else: 1\r\n\r\nbody")).toBeNull();
  });

  /**
   * THE MATCHER AND THE PARSER MUST NOT DISAGREE, which is the defect this table exists to make
   * structural: a hand-written predicate answered on the FIRST occurrence of its header while its
   * parser refused duplicates outright, and the class of message in between was permanently
   * unremovable with nothing saying so.
   */
  it("agrees with each parser about a duplicated discriminator", () => {
    const claim = formatClaim({
      installId: "us", kind: "cloud", displayName: "Cloud", claimedAt: NOW, heartbeat: NOW,
      nonce: "n", authorizedAt: null, capabilities: [], protocol: 1,
    });
    const doubledClaim = claim.replace("X-Ohmail-Lease: 1", "X-Ohmail-Lease: 1\r\nX-Ohmail-Lease: 1");
    // A duplicated lease header parses as a MALFORMED claim — evidence somebody claimed — so the
    // classifier must call it a claim too, not a stray.
    expect(parseClaim(doubledClaim)).not.toBeNull();
    expect(classifyMetaRecord(doubledClaim)).toBe("claim");

    const request = formatRequest(input());
    const contradicting = request.replace("X-Ohmail-Request: 1", "X-Ohmail-Request: 0\r\nX-Ohmail-Request: 1");
    // The parser reports a record that contradicts itself as MALFORMED rather than as absent —
    // evidence, not silence — and the classifier calls it a request, which is what lets the
    // organizer REMOVE it instead of reading past it for ever.
    const parsed = parseRequestEnvelope(contradicting);
    expect(parsed).not.toBeNull();
    expect(isMalformedRequest(parsed!)).toBe(true);
    expect(classifyMetaRecord(contradicting)).toBe("request");
  });

  /** THE REGISTRY IS NOT DECORATION: the folder's own sorting helpers are its callers. */
  it("is what requestEnvelopesIn and acksIn sort by", () => {
    const records: RawMetaMessage[] = [
      { ref: 1, raw: formatClaim({
        installId: "us", kind: "cloud", displayName: "Cloud", claimedAt: NOW, heartbeat: NOW,
        nonce: "n", authorizedAt: null, capabilities: [], protocol: 1,
      }) },
      { ref: 2, raw: formatRequest(input()) },
      { ref: 3, raw: formatAck({ requestId: "r1", mailboxId: MAILBOX, outcome: "applied", ackedAt: NOW, key: KEY }) },
      { ref: 4, raw: "Subject: not ours\r\n\r\nbody" },
    ];
    expect(requestEnvelopesIn(records).map((e) => e.ref)).toEqual([2]);
    expect(acksIn(records, KEY).map((a) => a.ref)).toEqual([3]);
  });
});
