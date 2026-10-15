import { describe, it, expect } from "vitest";
import {
  baseSubject, claimsContinuation, conversationJoinVerdict,
  CONVERSATION_JOIN_WINDOW_MS, type ConversationJoinFacts,
} from "../src/threading.js";
import type { CounterpartyEvidence } from "../src/sender-headers.js";

/**
 * THE CONVERSATION-JOIN RULE — the merge-time evidence predicate.
 *
 * This is NOT the ingest rule, and the "no subject fallback" guard in `threading.test.ts` is
 * untouched by everything here: `resolveThread` still threads by the header chain alone. This
 * predicate decides the worker's deferred MERGE of two already-threaded conversations, and
 * these tests pin each guard against the false-merge machine the module header describes.
 *
 * The fixture reproduces the shape observed in production on 2026-08-26 (addresses
 * anonymized): the user's outbound message sits alone because the correspondent's reply
 * landed at the user's OLD provider and re-entered as a forward — a fresh header chain, no
 * References — onto which the rest of the conversation then correctly chained.
 */

const SELF = new Set(["owner@own.example"]);
const day = 24 * 60 * 60 * 1000;
const t0 = Date.UTC(2026, 7, 24, 14, 42, 49);

/**
 * The facts carry WHO put each address on the thread, so every fixture here states it — the
 * production classes, not a convenience: `we_wrote` comes from our own sent mail's `To`/`Cc`,
 * `they_wrote` from the author of mail delivered to us, and `sender_named` from a `To`/`Cc`
 * somebody else wrote.
 */
const said = (
  ...pairs: Array<[string, CounterpartyEvidence]>
): ReadonlyMap<string, CounterpartyEvidence> => new Map(pairs);

/**
 * Thread A — the outbound original, alone: "Web Banner" sent to the correspondent, `Cc` to a
 * colleague, with the sender copying themselves (the habit that keeps the account's own address
 * on the thread, which is what makes the self-subtraction guard below live).
 */
function original(over: Partial<ConversationJoinFacts> = {}): ConversationJoinFacts {
  return {
    firstMessageAt: new Date(t0),
    lastMessageAt: new Date(t0),
    firstMessageSubject: "Web Banner - vendor - Partner",
    correspondents: said(
      ["owner@own.example", "we_wrote"],
      ["counterpart@partner.example", "we_wrote"],
      ["colleague@own.example", "we_wrote"],
    ),
    ...over,
  };
}

/** Thread B — the forward chain: self-forward, own reply, correspondent's "AW:" reply. */
function forwardChain(over: Partial<ConversationJoinFacts> = {}): ConversationJoinFacts {
  return {
    firstMessageAt: new Date(t0 + 1.76 * day),   // the forward, ~42h later
    lastMessageAt: new Date(t0 + 1.93 * day),    // the correspondent's AW: reply
    firstMessageSubject: "Fwd: AW: Web Banner - vendor - Partner",
    // The self-forward addressed us; our own reply addressed the correspondent.
    correspondents: said(
      ["owner@own.example", "we_wrote"],
      ["counterpart@partner.example", "we_wrote"],
    ),
    ...over,
  };
}

describe("the production shape joins", () => {
  it("the forward-severed conversation is one conversation", () => {
    const v = conversationJoinVerdict(original(), forwardChain(), SELF);
    expect(v).toEqual({ join: true, overlap: ["counterpart@partner.example"] });
  });

  it("…and the overlap names the counterparty, never the account's own address", () => {
    const v = conversationJoinVerdict(original(), forwardChain(), SELF);
    expect(v.join && v.overlap).not.toContain("owner@own.example");
  });

  it("interleaved threads (the earlier still active past the later one's start) join: gap is zero", () => {
    const v = conversationJoinVerdict(
      original({ lastMessageAt: new Date(t0 + 30 * day) }),
      forwardChain(),
      SELF,
    );
    expect(v.join).toBe(true);
  });
});

describe("each guard refuses on its own", () => {
  it("'Re: invoice' from two unrelated senders never merges — no non-self overlap", () => {
    const a = original({
      firstMessageSubject: "Re: Invoice",
      correspondents: said(["owner@own.example", "we_wrote"], ["billing@acme.example", "they_wrote"]),
    });
    const b = forwardChain({
      firstMessageSubject: "Re: Invoice",
      correspondents: said(["owner@own.example", "we_wrote"], ["accounts@other.example", "they_wrote"]),
    });
    expect(conversationJoinVerdict(a, b, SELF)).toEqual({ join: false, reason: "no-counterparty-overlap" });
  });

  it("two conversation-starters sharing a subject stay apart — the later one claims nothing", () => {
    const b = forwardChain({ firstMessageSubject: "Web Banner - vendor - Partner" });
    expect(conversationJoinVerdict(original(), b, SELF)).toEqual({ join: false, reason: "later-not-a-continuation" });
  });

  it("a subject line reused a season later stays apart — outside the window", () => {
    const b = forwardChain({
      firstMessageAt: new Date(t0 + CONVERSATION_JOIN_WINDOW_MS + day),
      lastMessageAt: new Date(t0 + CONVERSATION_JOIN_WINDOW_MS + 2 * day),
    });
    expect(conversationJoinVerdict(original(), b, SELF)).toEqual({ join: false, reason: "outside-window" });
  });

  it("…and exactly AT the window still joins — the bound is inclusive", () => {
    const b = forwardChain({
      firstMessageAt: new Date(t0 + CONVERSATION_JOIN_WINDOW_MS),
      lastMessageAt: new Date(t0 + CONVERSATION_JOIN_WINDOW_MS),
    });
    expect(conversationJoinVerdict(original(), b, SELF).join).toBe(true);
  });

  it("different base subjects stay apart", () => {
    const b = forwardChain({ firstMessageSubject: "Fwd: AW: Web Banner - vendor - OTHER" });
    expect(conversationJoinVerdict(original(), b, SELF)).toEqual({ join: false, reason: "subject-differs" });
  });

  it("a bare 'Re:' anchors nothing — empty base subject", () => {
    const a = original({ firstMessageSubject: "Re:" });
    const b = forwardChain({ firstMessageSubject: "Re:" });
    expect(conversationJoinVerdict(a, b, SELF)).toEqual({ join: false, reason: "no-base-subject" });
  });

  it("an undated thread is ineligible — the window is load-bearing", () => {
    expect(conversationJoinVerdict(original({ firstMessageAt: null }), forwardChain(), SELF))
      .toEqual({ join: false, reason: "undated" });
    expect(conversationJoinVerdict(original(), forwardChain({ firstMessageAt: null }), SELF))
      .toEqual({ join: false, reason: "undated" });
  });

  it("reversed arguments are refused, not silently inverted", () => {
    expect(conversationJoinVerdict(forwardChain(), original(), SELF))
      .toEqual({ join: false, reason: "order" });
  });
});

/**
 * ═══ THE GRAFT — a `To`/`Cc` the SENDER wrote is not counterparty evidence ══════════════════
 *
 * Every other guard passes here: same base subject, the later chain claims continuation, inside
 * the window, and the two threads DO share an address. The share is the whole attack — a stranger
 * naming a trusted colleague in `Cc` — so the verdict turns on who put that address there.
 */
describe("a sender-written recipient list cannot join two conversations", () => {
  /** The stranger's own thread: they wrote to us and named the colleague in `Cc`. */
  const grafted = (): ConversationJoinFacts => forwardChain({
    correspondents: said(
      ["stranger@elsewhere.example", "they_wrote"],
      ["colleague@own.example", "sender_named"],
    ),
  });

  it("refuses under its own reason, so the pass can count the attempts", () => {
    expect(conversationJoinVerdict(original(), grafted(), SELF))
      .toEqual({ join: false, reason: "uncorroborated-overlap" });
  });

  it("and 'no overlap at all' stays a DIFFERENT answer — the two are not one bucket", () => {
    const unrelated = forwardChain({
      correspondents: said(["stranger@elsewhere.example", "they_wrote"]),
    });
    expect(conversationJoinVerdict(original(), unrelated, SELF))
      .toEqual({ join: false, reason: "no-counterparty-overlap" });
  });

  it("POSITIVE CONTROL: the same address, corroborated on both sides, still joins", () => {
    const honest = forwardChain({
      correspondents: said(
        ["stranger@elsewhere.example", "they_wrote"],
        // The colleague has written to us on this thread — their own delivered mail, not a
        // third party's claim about them.
        ["colleague@own.example", "they_wrote"],
      ),
    });
    expect(conversationJoinVerdict(original(), honest, SELF))
      .toEqual({ join: true, overlap: ["colleague@own.example"] });
  });
});

describe("the German prefix stack, as production carried it", () => {
  it("normalizes 'AW: Fwd: AW:' the exact stacking the split conversation wore", () => {
    expect(baseSubject("AW: Fwd: AW: Web Banner - vendor - Partner")).toBe("Web Banner - vendor - Partner");
    expect(baseSubject("Fwd: AW: Web Banner - vendor - Partner")).toBe("Web Banner - vendor - Partner");
    expect(baseSubject("Re: Fwd: AW: Web Banner - vendor - Partner")).toBe("Web Banner - vendor - Partner");
  });

  it("claimsContinuation sees the claim, and does not see an innocent subject", () => {
    expect(claimsContinuation("Fwd: AW: Web Banner")).toBe(true);
    expect(claimsContinuation("AW: Fwd: AW: Web Banner")).toBe(true);
    expect(claimsContinuation("  Re: indented")).toBe(true);
    expect(claimsContinuation("Web Banner - vendor - Partner")).toBe(false);
    expect(claimsContinuation("Reserve: two seats")).toBe(false);
    expect(claimsContinuation("")).toBe(false);
  });

  it("NAMING-ONLY prefixes are not merge evidence — 'WG:' is a German flat-share, not a claim", () => {
    // The naming table strips these for a thread's NAME, where a false positive costs two
    // letters. As merge evidence a false positive is irreversible, so they are excluded here.
    expect(claimsContinuation("WG: Zimmer")).toBe(false);
    expect(claimsContinuation("VS: proposal")).toBe(false);
    expect(claimsContinuation("RES: table for two")).toBe(false);
    expect(claimsContinuation("R: appunti")).toBe(false);
    // …while baseSubject still strips them for naming, unchanged.
    expect(baseSubject("WG: Zimmer")).toBe("Zimmer");
  });

  it("an ambiguous prefix cannot merge: 'Zimmer' + 'WG: Zimmer' from one correspondent stay apart", () => {
    const a = original({ firstMessageSubject: "Zimmer" });
    const b = forwardChain({ firstMessageSubject: "WG: Zimmer" });
    expect(conversationJoinVerdict(a, b, SELF)).toEqual({ join: false, reason: "later-not-a-continuation" });
  });
});
