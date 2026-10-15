import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DESTINATIONS } from "../src/types.js";
import {
  AWAY_ANSWERABLE_PILES, AWAY_NEVER_ANSWERED_FOLDERS, AWAY_PILES_DEFAULT, AWAY_SCREENER_FOLDER,
  awayEffectivePiles, awayEligibility, awayNormalizeAddress, awayTextHash, neverAutoReply,
  type AwayCandidate, type AwayPile, type AwaySuppression,
} from "../src/away-eligibility.js";

/**
 * THE AWAY RESPONDER'S SUPPRESSION SET — every member reachable, in a table.
 *
 * ── WHY A TABLE AND NOT A FIXTURE ────────────────────────────────────────────────────────────
 *
 * The responder is the one thing in this product that sends mail with nobody looking, and its
 * safety argument is a SET OF NAMED GUARDS each of which has been watched to fire. A guard nobody
 * has watched fail is not evidence — so each member below is reached by a hand-built row, and each
 * one's deletion from `awayEligibility` makes a specific case here go from its reason to `null`,
 * which is the assertion "this message would have been answered".
 *
 * That is only possible because eligibility is a PURE FUNCTION over one row. Buried in the pass's
 * loop, every one of these would need a database, an adapter and a clock to reach, and the cheap
 * ones to get wrong (the header verdicts, the screened-out folders) are exactly the ones nobody
 * would have covered.
 *
 * ── THE ORDER IS PART OF THE CONTRACT ────────────────────────────────────────────────────────
 *
 * A caller reports the FIRST reason that holds, so the order decides what an operator reads for a
 * row that trips several. It is asserted directly (`the order is cheapest-first`) rather than left
 * to emerge, because a reordering that put `not_screened_in` above `own_address` would report the
 * account's own Sent copy as "a stranger we did not admit" — true, useless, and misleading about
 * why the responder is quiet.
 */

/**
 * THE STORED HEADER SHAPE, and using it here is not a detail.
 *
 * `mime.ts` writes `headers[key.toLowerCase()] ??= []` and pushes each value, so a stored map has
 * LOWERCASE keys and ARRAY values — and `rules.ts`'s own `headerValues` requires exactly that (an
 * `Object.hasOwn` on the given name, and a non-array is read as absent). A fixture written as
 * `{ "List-Id": "<x>" }` therefore proves nothing about production: it is invisible to
 * `autoReplySuppression`, so the case passes for a message that would have been ANSWERED.
 *
 * This helper exists so no case in this file can make that mistake silently. The one place a
 * different shape is used on purpose is the case-blindness block below, which is about the
 * away-only accessor being defensive rather than about what ingest writes.
 */
const hdr = (map: Record<string, string | string[]>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) out[k.toLowerCase()] = Array.isArray(v) ? v : [v];
  return out;
};

/** A row that clears every guard. Each case below spoils exactly one thing about it. */
const OK: AwayCandidate = {
  fromAddress: "colleague@example.com",
  headers: {},
  /* INBOX, not "ohmail/Ohbox". The Ohbox pile's FOLDER is `INBOX` (`VIEW_OF_FOLDER` in
     client-engine, `DESTINATIONS` in `../src/types.js`) and "ohmail/Ohbox" is a string no
     product source writes — this fixture carried it for three cases, so every one of them
     measured a folder the router cannot produce. Corrected with the piles rule, which is the
     first guard that actually reads the value. */
  desiredFolder: "INBOX",
  sensitivityCategory: null,
  noForward: false,
  alreadyReplied: false,
  senderUndeliverable: false,
};

const OWN = new Set(["me@example.com", "old@example.com"]);

const check = (
  patch: Partial<AwayCandidate>,
  audience: "screened_in" | "everyone" = "screened_in",
  piles: readonly AwayPile[] = AWAY_PILES_DEFAULT,
) => awayEligibility({ ...OK, ...patch }, audience, OWN, piles);

describe("awayEligibility — the baseline", () => {
  it("answers a screened-in human with nothing against them", () => {
    expect(check({})).toBeNull();
  });
});

describe("awayEligibility — every member of the suppression set is reachable", () => {
  /**
   * The table. `patch` spoils ONE property of the clean row; `why` is the member that must hold.
   * A new member of `AwaySuppression` with no row here is caught by the exhaustiveness check at
   * the bottom of this file, which is what stops this table from silently covering five of six.
   */
  const cases: ReadonlyArray<{ name: string; patch: Partial<AwayCandidate>; why: AwaySuppression; audience?: "screened_in" | "everyone" }> = [
    {
      name: "an empty envelope author — a bounce carries one, and it is nobody to answer",
      patch: { fromAddress: "" }, why: "not_an_address",
    },
    {
      name: "a local part that is not there (`@host`) — `@` at position 0 is not an address",
      patch: { fromAddress: "@example.com" }, why: "not_an_address",
    },
    {
      name: "the account's OWN address — ingest sees the Sent copy of everything we send, so " +
        "without this the responder answers itself for ever",
      patch: { fromAddress: "me@example.com" }, why: "own_address",
    },
    {
      name: "a FORMER address of the account — an address that was ours is still ours",
      patch: { fromAddress: "old@example.com" }, why: "own_address",
    },
    {
      name: "a sensitivity-flagged message — a login code or a password reset, where the reply " +
        "confirms to whoever started that flow that the address is live and attended",
      patch: { sensitivityCategory: "security" }, why: "sensitive",
    },
    {
      name: "the account holder's own no-forward instruction on the message",
      patch: { noForward: true }, why: "sensitive",
    },
    {
      name: "mail held in Quarantine — never answered, WHATEVER the audience",
      patch: { desiredFolder: "ohmail/Quarantine" }, why: "screened_out",
    },
    {
      name: "a sender the account holder has REJECTED (`ohmail/Screened`) — the durable 'no', which is a " +
        "different folder from `ohmail/Screener` and a different decision",
      patch: { desiredFolder: "ohmail/Screened" }, why: "screened_out",
    },
    {
      name: "a stranger still held in the Screener, under the narrow audience",
      patch: { desiredFolder: AWAY_SCREENER_FOLDER }, why: "not_screened_in",
    },
    {
      name: "a row with NO placement yet — absent evidence may not select the branch that sends " +
        "mail to a stranger",
      patch: { desiredFolder: null }, why: "not_screened_in",
    },
    {
      name: "a mailing list (`List-Id`) — a reply is delivered to every subscriber, and public",
      patch: { headers: hdr({ "List-Id": "<dev.example.com>" }) }, why: "list_mail",
    },
    {
      name: "RFC 3834's own loop stop (`Auto-Submitted: auto-replied`) — two responders " +
        "answering each other is unbounded",
      patch: { headers: hdr({ "Auto-Submitted": "auto-replied" }) }, why: "auto_submitted",
    },
    {
      name: "a no-reply sender — the reply reaches nobody at best and bounces at worst",
      patch: { fromAddress: "no-reply@example.com" }, why: "service_sender",
    },
    {
      name: "Exchange's `X-Auto-Response-Suppress: OOF` — an explicit request not to auto-reply",
      patch: { headers: hdr({ "X-Auto-Response-Suppress": "OOF" }) }, why: "auto_reply_suppressed",
    },
    {
      name: "`Precedence: list`, the older list convention",
      patch: { headers: hdr({ Precedence: "list" }) }, why: "list_mail",
    },
    {
      name: "`Precedence: junk`",
      patch: { headers: hdr({ Precedence: "junk" }) }, why: "list_mail",
    },
    {
      name: "an EMPTY `Return-Path` (`<>`) — the null reverse path, a bounce or a notification " +
        "whose sender has declared it accepts no reply",
      patch: { headers: hdr({ "Return-Path": "<>" }) }, why: "null_return_path",
    },
    {
      name: "somebody already answered in this thread — a manual reply, or an earlier automatic " +
        "one from any install",
      patch: { alreadyReplied: true }, why: "already_replied",
    },
    /* ── THE FOUR MEMBERS THIS SLICE ADDS (0.16 owner feedback item 4) ────────────────────
     *
     * Each one is a message the responder ANSWERS on the base this lane started from, measured
     * against `packages/core/dist` before a line was changed. They are the report itself:
     * eight "Me → <service>" replies to senders let in once whose later mail files to Reads,
     * and a bounce of one of those replies sitting in the Ohbox. */
    {
      name: "a let-in sender whose message filed to READS — under the default piles the " +
        "responder answers the Ohbox and nothing else (RED on the base: answered)",
      patch: { desiredFolder: "ohmail/News" }, why: "wrong_pile",
    },
    {
      name: "the message is itself a DELIVERY REPORT (`multipart/report`) — answering a bounce " +
        "is a bounce loop (RED on the base: answered)",
      patch: {
        headers: hdr({ "Content-Type": "multipart/report; report-type=delivery-status" }),
      },
      why: "bounce_report",
    },
    {
      name: "a sender an earlier away reply BOUNCED for — their address does not accept mail, " +
        "so no further reply is ever sent (RED on the base: answered)",
      patch: { senderUndeliverable: true }, why: "undeliverable",
    },
    /* ── THE SITE/SYSTEM MAILBOX (0.16.2 owner report) ────────────────────────────────────
     *
     * A WordPress install's notification, measured on a real mailbox: a full set of headers, no
     * `Auto-Submitted`, no `Precedence`, no `List-*`, a present non-empty `Return-Path`. Every
     * other guard reads clean, `wordpress` is not a `SERVICE_LOCAL_PREFIXES` entry, and the
     * message was answered — the reply then bounced back into the Ohbox. RED on the base. */
    {
      name: "a WordPress install's notification mailbox — no header says it is automatic, so " +
        "the author is the only fact there is (RED on the base: answered)",
      patch: { fromAddress: "wordpress@example.com" }, why: "site_notification",
    },
    {
      name: "a server's own `root@` — cron and Plesk mail, which nobody reads a reply to",
      patch: { fromAddress: "root@example.com" }, why: "site_notification",
    },
    {
      name: "`www-data@`, punctuation-stripped to one entry",
      patch: { fromAddress: "www-data@example.com" }, why: "site_notification",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(check(c.patch, c.audience)).toBe(c.why);
    });
  }

  /**
   * EXHAUSTIVENESS. `AwaySuppression` is a closed union, and this asserts the table above reaches
   * EVERY member — so adding a guard without a case here is red, which is the discipline the
   * whole file exists for. Without it the table could silently cover five of six members and read
   * exactly as convincing.
   */
  it("the table reaches every member of AwaySuppression — no guard is unwatched", () => {
    const reached = new Set(cases.map((c) => c.why));
    const declared: readonly AwaySuppression[] = [
      "not_an_address", "own_address", "sensitive", "screened_out", "not_screened_in",
      "already_replied", "list_mail", "auto_submitted", "service_sender",
      "auto_reply_suppressed", "null_return_path",
      // The pile scope, the DSN shape, the dead address. `receipts_pile` was retired with mail
      // 0101: Receipts is an answerable pile now, so a receipt is refused as `wrong_pile` when the
      // box is unticked and by `neverAutoReply` per header when it is.
      "wrong_pile", "bounce_report", "undeliverable",
      // The site/system mailbox (0.16.2 owner report).
      "site_notification",
    ];
    expect([...reached].sort()).toEqual([...declared].sort());
  });
});

describe("awayEligibility — the audience widens ONE thing and not the other", () => {
  it("`everyone` answers a stranger held in the Screener when that pile is ticked", () => {
    /* BOTH halves, because the audience and the pile are two conditions since mail 0101 and a
       single-arm case would not say which one admitted the stranger. The audience is still the
       gate: `screened_in` refuses the same row with the same pile ticked, one describe down. */
    expect(check({ desiredFolder: AWAY_SCREENER_FOLDER }, "everyone",
      ["INBOX", AWAY_SCREENER_FOLDER])).toBeNull();
    expect(check({ desiredFolder: AWAY_SCREENER_FOLDER }, "everyone")).toBe("wrong_pile");
  });

  /**
   * THE ONE THAT WOULD BE EASY TO GET WRONG, and the reason `screened_out` is a separate member
   * checked BEFORE the audience. Both guards read the same column; only their order keeps them
   * independent. Folding them into one audience-sensitive test would make "answer everyone" also
   * mean "answer the phishing attempt we quarantined".
   */
  it("`everyone` does NOT reach Quarantine — widening the audience may not widen this", () => {
    expect(check({ desiredFolder: "ohmail/Quarantine" }, "everyone")).toBe("screened_out");
  });

  it("`everyone` still refuses lists, loops, service senders, our own addresses and sensitive mail", () => {
    expect(check({ headers: hdr({ "List-Id": "<x>" }) }, "everyone")).toBe("list_mail");
    expect(check({ fromAddress: "me@example.com" }, "everyone")).toBe("own_address");
    expect(check({ sensitivityCategory: "security" }, "everyone")).toBe("sensitive");
    expect(check({ alreadyReplied: true }, "everyone")).toBe("already_replied");
  });
});

describe("awayEligibility — the order is cheapest-first, and it is a contract", () => {
  it("our own address wins over every other reason it also trips", () => {
    const reason = check({
      fromAddress: "me@example.com",
      headers: hdr({ "List-Id": "<x>" }),
      desiredFolder: "ohmail/Quarantine",
      sensitivityCategory: "security",
      alreadyReplied: true,
    });
    // The fact about this row that would still be true if every other guard were removed.
    expect(reason).toBe("own_address");
  });

  it("`screened_out` outranks the header verdict — placement is decided before the headers are read", () => {
    expect(check({ desiredFolder: "ohmail/Quarantine", headers: hdr({ "List-Id": "<x>" }) }))
      .toBe("screened_out");
  });

  it("`already_replied` is LAST — every cheaper reason is preferred over the one that needed a query", () => {
    expect(check({ alreadyReplied: true, headers: hdr({ "List-Id": "<x>" }) })).toBe("list_mail");
  });
});

describe("awayEligibility — header reading is case-blind and own-keys-only", () => {
  /**
   * A stored header map is a `JSON.parse`d object, so a bare `h["list-id"]` both misses `List-Id`
   * and can return a truthy INHERITED value. `rules.ts` states the same trap for its own accessor;
   * these two cases are what make the away-only half hold the same line.
   */
  it("finds a header whatever case the sender's client wrote it in", () => {
    expect(check({ headers: { "x-auto-response-suppress": "All" } })).toBe("auto_reply_suppressed");
    expect(check({ headers: { "X-AUTO-RESPONSE-SUPPRESS": "AutoReply" } })).toBe("auto_reply_suppressed");
    expect(check({ headers: { PRECEDENCE: "LIST" } })).toBe("list_mail");
  });

  it("does not read an INHERITED property as a header", () => {
    // `constructor` is truthy on every object literal's prototype. A naive accessor reads it.
    expect(check({ headers: {} })).toBeNull();
    expect(check({ headers: Object.create({ Precedence: "list" }) as Record<string, unknown> }))
      .toBeNull();
  });

  it("an array-valued header (a folded or repeated one) is read across every value", () => {
    expect(check({ headers: hdr({ "X-Auto-Response-Suppress": ["DR", "OOF"] }) })).toBe("auto_reply_suppressed");
  });

  it("a PRESENT, non-empty Return-Path is ordinary mail and suppresses nothing", () => {
    expect(check({ headers: hdr({ "Return-Path": "<colleague@example.com>" }) })).toBeNull();
  });

  it("`Auto-Submitted: no` means a human wrote it, and does NOT suppress", () => {
    // Presence alone is the wrong test — RFC 3834 gives `no` this exact meaning.
    expect(check({ headers: hdr({ "Auto-Submitted": "no" }) })).toBeNull();
  });
});

describe("awayNormalizeAddress", () => {
  it("lowercases and trims, so two spellings of one correspondent are one person", () => {
    expect(awayNormalizeAddress("  Colleague@Example.COM ")).toBe("colleague@example.com");
    expect(awayNormalizeAddress(null)).toBe("");
    expect(awayNormalizeAddress(undefined)).toBe("");
  });

  it("is what makes the own-address guard case-insensitive", () => {
    expect(check({ fromAddress: "ME@Example.com" })).toBe("own_address");
  });
});

describe("awayTextHash — what `per_message` is keyed by", () => {
  /**
   * The whole point of hashing the TEXT rather than versioning the row: a save is not an edit.
   * Keyed by a version (or by the row's `updated_at`, which is the same thing with a clock on it),
   * switching the responder off on Friday and on again on Monday re-answers every correspondent —
   * which is the defect this replaces.
   */
  it("is stable across saves that changed nothing", () => {
    expect(awayTextHash("Back Monday.")).toBe(awayTextHash("Back Monday."));
  });

  it("changes when the words change — which is what re-arms a reply", () => {
    expect(awayTextHash("Back Monday.")).not.toBe(awayTextHash("Back Tuesday."));
  });

  it("ignores surrounding whitespace and Unicode composition — a paste through another editor " +
    "is the same text", () => {
    expect(awayTextHash("  Back Monday.  ")).toBe(awayTextHash("Back Monday."));
    // "é" composed vs decomposed — the same sentence, typed on two keyboards.
    expect(awayTextHash("Café fermé")).toBe(awayTextHash("Café fermé"));
  });

  it("keeps INTERNAL whitespace and case significant — those are the author's", () => {
    expect(awayTextHash("Back  Monday.")).not.toBe(awayTextHash("Back Monday."));
    expect(awayTextHash("BACK MONDAY.")).not.toBe(awayTextHash("Back Monday."));
  });

  it("answers for an absent body without throwing — the pass hashes before it knows the row is usable", () => {
    expect(awayTextHash(null)).toBe(awayTextHash(""));
    expect(awayTextHash(undefined)).toBe(awayTextHash(""));
  });

  it("is a sha256 hex digest, which the 0087 seed sentinel deliberately is not", () => {
    expect(awayTextHash("x")).toMatch(/^[0-9a-f]{64}$/);
    // The migration seeds `last_text_hash` with a non-hash so `per_message` reads every migrated
    // sender as "the text has changed" and answers them once more — the safe direction.
    expect("seeded-from-0051-no-recorded-text").not.toMatch(/^[0-9a-f]{64}$/);
  });
});

/**
 * THE ONE-LETTER DIFFERENCE, PINNED — and this block exists because the first version of this
 * file got it wrong in the dangerous direction.
 *
 * `AWAY_NEVER_ANSWERED_FOLDERS` was written holding `ohmail/Screener` (where a stranger WAITS)
 * instead of `ohmail/Screened` (where a REJECTED sender goes). The effect was not a missing
 * suppression — it was that `audience='everyone'` could never answer anybody held in the Screener,
 * which is the entire population that setting exists for. The feature would have shipped with its
 * wider audience silently doing nothing, and no test in the table above would have noticed, because
 * every one of them asserts that somebody is NOT answered.
 *
 * So the two names are asserted apart, by name, here.
 */
describe("the never-answered folder list — `Screened` is not `Screener`", () => {
  it("holds the two NEVER-ANSWERED placements and never the waiting one", () => {
    // A MAP (folder → the reason an operator reads) rather than a set, so a folder that is not
    // "the account turned this sender away" can carry a truthful reason of its own.
    expect(AWAY_NEVER_ANSWERED_FOLDERS["ohmail/Screened"]).toBe("screened_out");
    expect(AWAY_NEVER_ANSWERED_FOLDERS["ohmail/Quarantine"]).toBe("screened_out");
    // Receipts LEFT this map with mail 0101 — it is a pile somebody may tick.
    expect(AWAY_NEVER_ANSWERED_FOLDERS["ohmail/Receipts"]).toBeUndefined();
    // The waiting room is audience-sensitive and must NOT be in the audience-blind map.
    expect(AWAY_NEVER_ANSWERED_FOLDERS[AWAY_SCREENER_FOLDER]).toBeUndefined();
    expect(Object.keys(AWAY_NEVER_ANSWERED_FOLDERS).sort())
      .toEqual(["ohmail/Quarantine", "ohmail/Screened"]);
    expect(AWAY_SCREENER_FOLDER).toBe("ohmail/Screener");
  });

  it("so `everyone` reaches the waiting room and nothing else it should not", () => {
    const wide: readonly AwayPile[] = ["INBOX", AWAY_SCREENER_FOLDER];
    expect(check({ desiredFolder: AWAY_SCREENER_FOLDER }, "everyone", wide)).toBeNull();
    expect(check({ desiredFolder: "ohmail/Screened" }, "everyone", wide)).toBe("screened_out");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE PILE SCOPE (0.16 owner feedback item 4)
   ══════════════════════════════════════════════════════════════════════════════════════════

   ── WHAT THE OWNER SAW, AND WHY THE AUDIENCE COULD NOT PREVENT IT ────────────────────────

   Audience "People I've let in", throttle "at most once a day", and eight "Me → <service>"
   replies to notification/shop/developer senders. The audience is a fact about a SENDER — let
   in once, past the Screener for ever — and it is silent about WHERE that sender's later mail
   lands. A shop let in to receive an order confirmation is still "somebody I've let in" when
   its newsletter files to Reads six months later, so the responder answered it.

   None of the senders involved was a service local part: `hello@`, `team@`, `updates@`,
   `info@`, `news@`, `support@`, `store@` — measured against `isServiceSender`, which already
   refuses `no-reply@`, `mailer-daemon@`, `postmaster@` and `bounce@`. So a wider sender class
   is NOT the cure and was never the gap; the pile is.

   ── WHY IT IS A PREDICATE HERE AND NOT A `WHERE` CLAUSE ──────────────────────────────────

   The pass's own rule (`away-responder-pass.ts`, `readCandidates`): a guard in the WHERE clause
   cannot be watched to fail. A row this rule refuses must leave the candidate set with a LEDGER
   ROW carrying its reason, which is what makes the pass converge and what makes an operator able
   to read "we did not answer this, because it was in Reads". So the piles arrive here, beside the
   audience, and the refusal is a named member of the suppression set like every other one.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("the pile scope — WHERE a let-in sender's mail landed decides whether it is answered", () => {
  /**
   * THE POSITIVE CONTROL, and this file needs it more than most.
   *
   * Every other case in this block asserts that somebody is NOT answered. A rule whose every
   * test is a refusal has no evidence it admits the right person — delete the whole feature and
   * they all stay green while the product answers nobody, which is the failure the `/join`
   * registration capture shipped with. This is the case that says the responder still works.
   */
  it("POSITIVE CONTROL: a let-in sender writing to the Ohbox is answered under the defaults", () => {
    expect(check({ desiredFolder: "INBOX" })).toBeNull();
    expect(check({ desiredFolder: "INBOX" }, "everyone")).toBeNull();
  });

  it("Reads is refused under the defaults — the reported eight replies, by their own placement", () => {
    expect(check({ desiredFolder: "ohmail/News" })).toBe("wrong_pile");
  });

  it("…and ANSWERED once Reads is opted in, which is what the setting is for", () => {
    expect(check({ desiredFolder: "ohmail/News" }, "screened_in", ["INBOX", "ohmail/News"]))
      .toBeNull();
  });

  /**
   * THE PILE RULE DOES NOT WIDEN ANYTHING. Opting Reads in is a decision about a PILE; it is not
   * a decision about the Screener (that is the audience's), about a sender the account rejected,
   * about Quarantine, or about a receipt. Each of those keeps its own reason at its own rank.
   */
  it("opting Reads in reaches Reads and nothing else it should not", () => {
    const wide: readonly AwayPile[] = ["INBOX", "ohmail/News"];
    // Receipts and the Screener are OFFERED piles now, and each is refused here by the same rule
    // that refuses Reads under the defaults: the box is not ticked.
    expect(check({ desiredFolder: "ohmail/Receipts" }, "everyone", wide)).toBe("wrong_pile");
    expect(check({ desiredFolder: AWAY_SCREENER_FOLDER }, "everyone", wide)).toBe("wrong_pile");
    // These two are refused by the never-answered map, above the pile rule and above the audience.
    expect(check({ desiredFolder: "ohmail/Screened" }, "everyone", wide)).toBe("screened_out");
    expect(check({ desiredFolder: "ohmail/Quarantine" }, "everyone", wide)).toBe("screened_out");
    expect(check({ desiredFolder: AWAY_SCREENER_FOLDER }, "screened_in", wide))
      .toBe("not_screened_in");
  });

  /**
   * THE SCREENER TAKES BOTH CONDITIONS (mail 0101), and the ORDER is what keeps them independent.
   *
   * It used to be exempt from this rule entirely, because the audience owned that population and a
   * naive `placed ∉ piles` would have switched `everyone` off. It is a pile somebody may tick now,
   * so the audience is still asked FIRST — `screened_in` refuses a waiting stranger with the box
   * ticked, which is the case that would go quiet if the two were ever reordered — and only then is
   * the pile consulted. The write doors refuse the ticked-plus-`screened_in` pair, so that row is
   * a defence rather than a state the product produces.
   */
  it("the Screener needs the wider audience AND the ticked pile — each one alone refuses", () => {
    const withScreener: readonly AwayPile[] = ["INBOX", AWAY_SCREENER_FOLDER];
    expect(check({ desiredFolder: AWAY_SCREENER_FOLDER }, "everyone", withScreener)).toBeNull();
    // The audience alone: ticked, but the narrow audience still refuses — and by ITS name.
    expect(check({ desiredFolder: AWAY_SCREENER_FOLDER }, "screened_in", withScreener))
      .toBe("not_screened_in");
    // The pile alone: the wider audience, box unticked.
    expect(check({ desiredFolder: AWAY_SCREENER_FOLDER }, "everyone")).toBe("wrong_pile");
  });

  /**
   * A ROW WITH NO PLACEMENT YET is decided by the AUDIENCE, before the pile rule is reached —
   * `not_screened_in` under the narrow audience. Under `everyone` the audience admits it, and
   * then the pile rule has an absent folder in hand and must still fail toward silence: mail
   * whose pile nobody has decided is not mail known to be in an answered pile.
   */
  it("an undecided placement is never answered, under either audience", () => {
    expect(check({ desiredFolder: null })).toBe("not_screened_in");
    expect(check({ desiredFolder: null }, "everyone")).toBe("wrong_pile");
  });

  /**
   * A FOLDER OUTSIDE THE PRODUCT'S OWN SET — a customer's own folder, or a folder a newer server
   * files into that this build has never heard of (contract §8 forward-compatible parsing). It is
   * not an answered pile, so it is not answered. Absent evidence may not select the branch that
   * sends mail.
   */
  it("a folder this build does not know is not an answered pile", () => {
    expect(check({ desiredFolder: "Archive/2024" }, "everyone")).toBe("wrong_pile");
    expect(check({ desiredFolder: "ohmail/SomethingNewer" }, "everyone")).toBe("wrong_pile");
  });

  /** An EMPTY piles list answers nothing — the fail-closed reading, not "no filter". */
  it("empty piles answer NOBODY, and are not read as 'no filter'", () => {
    expect(check({ desiredFolder: "INBOX" }, "everyone", [])).toBe("wrong_pile");
  });

  it("the offered set is the ENGINE's constant — four piles, and the default is still one", () => {
    // The settings control imports this rather than listing piles of its own, so a control cannot
    // offer a pile the engine refuses.
    expect([...AWAY_ANSWERABLE_PILES])
      .toEqual(["INBOX", "ohmail/News", "ohmail/Receipts", "ohmail/Screener"]);
    // The default did NOT widen with the set: it is the one pile that reaches fewest people.
    expect([...AWAY_PILES_DEFAULT]).toEqual(["INBOX"]);
    // Every member is a real destination the router can actually file into.
    for (const p of AWAY_ANSWERABLE_PILES) expect(DESTINATIONS).toContain(p);
    // And the two that stay out are refused by the never-answered map, not by omission.
    expect([...AWAY_ANSWERABLE_PILES]).not.toContain("ohmail/Screened");
    expect([...AWAY_ANSWERABLE_PILES]).not.toContain("ohmail/Quarantine");
  });

  /**
   * RECEIPTS IS A PILE SOMEBODY MAY TICK (mail 0101), and what keeps the machines out is the
   * HEADER predicate rather than the pile.
   *
   * Most receipts are machine mail, and `neverAutoReply` refuses those for every pile whether or
   * not the box is ticked — so each header is asserted here WITH the pile ticked, which is the
   * only configuration in which the pile rule is not doing the refusing. What is left is a receipt
   * a person typed, and answering that is what the box is for.
   */
  const withReceipts: readonly AwayPile[] = ["INBOX", "ohmail/Receipts"];

  it("a receipt is refused as `wrong_pile` while the box is unticked — under either audience", () => {
    expect(check({ desiredFolder: "ohmail/Receipts" })).toBe("wrong_pile");
    expect(check({ desiredFolder: "ohmail/Receipts" }, "everyone")).toBe("wrong_pile");
  });

  it("a HUMAN receipt is answered once the box is ticked — the positive control", () => {
    expect(check({ desiredFolder: "ohmail/Receipts" }, "screened_in", withReceipts)).toBeNull();
  });

  /**
   * THE MACHINE-SENDER FLOOR, one case per header, all with the pile TICKED. Each of these is a
   * receipt-shaped message: a bulk marker, a list, an RFC 3834 loop stop, a no-reply local part, a
   * suppression request, or a null return path. The pile cannot save any of them.
   */
  const machineReceipts: ReadonlyArray<{ what: string; patch: Partial<AwayCandidate>; why: AwaySuppression }> = [
    { what: "Auto-Submitted: auto-generated", patch: { headers: hdr({ "Auto-Submitted": "auto-generated" }) }, why: "auto_submitted" },
    /* `bulk` reads as `list_mail`, not `auto_submitted`: the away-only precedence test matches
       `list|junk`, and `bulk` is caught one layer down by `isBulkSend` in `rules.ts`. Measured,
       because the two reasons look interchangeable and are not — an operator reading either one
       needs it to name the marker that actually fired. */
    { what: "Precedence: bulk", patch: { headers: hdr({ Precedence: "bulk" }) }, why: "list_mail" },
    { what: "Precedence: list", patch: { headers: hdr({ Precedence: "list" }) }, why: "list_mail" },
    { what: "List-Id", patch: { headers: hdr({ "List-Id": "<orders.shop.example>" }) }, why: "list_mail" },
    { what: "List-Unsubscribe", patch: { headers: hdr({ "List-Unsubscribe": "<https://shop.example/u>" }) }, why: "list_mail" },
    { what: "Feedback-ID", patch: { headers: hdr({ "Feedback-ID": "1:2:3:ses" }) }, why: "list_mail" },
    { what: "X-Auto-Response-Suppress", patch: { headers: hdr({ "X-Auto-Response-Suppress": "All" }) }, why: "auto_reply_suppressed" },
    { what: "an empty Return-Path", patch: { headers: hdr({ "Return-Path": "<>" }) }, why: "null_return_path" },
    { what: "a no-reply sender", patch: { fromAddress: "no-reply@shop.example" }, why: "service_sender" },
  ];

  for (const c of machineReceipts) {
    it(`a receipt with ${c.what} is NOT answered even with the pile ticked`, () => {
      expect(check({ desiredFolder: "ohmail/Receipts", ...c.patch }, "everyone", withReceipts))
        .toBe(c.why);
    });
  }

  /**
   * THE DISPLAY PROJECTION AND THE RULE AGREE, over every pair the doors can store.
   *
   * `awayEffectivePiles` is what the settings control and the banner sentence read, and its whole
   * claim is "these are the piles that get a reply". Asserted against the rule itself rather than
   * against a second reading of it: for each audience and each stored scope, a clean row in pile P
   * is answered exactly when P is in that list.
   */
  it("a pile is answered iff `awayEffectivePiles` lists it", () => {
    let answered = 0;
    for (const audience of ["screened_in", "everyone"] as const) {
      for (const scope of [
        [], ["INBOX"], ["INBOX", "ohmail/News"], ["ohmail/Receipts"],
        ["INBOX", AWAY_SCREENER_FOLDER], [...AWAY_ANSWERABLE_PILES],
      ] as ReadonlyArray<readonly AwayPile[]>) {
        const effective = awayEffectivePiles(scope, audience);
        for (const pile of AWAY_ANSWERABLE_PILES) {
          const listed = effective.includes(pile);
          if (listed) answered += 1;
          expect(check({ desiredFolder: pile }, audience, scope) === null, `${audience} ${pile} in ${JSON.stringify(scope)}`)
            .toBe(listed);
        }
      }
    }
    // ANTI-VACUITY: the loop above must have found real answers, not agreed on twelve refusals.
    expect(answered).toBeGreaterThan(8);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   `neverAutoReply` — ONE NAMED PREDICATE, COMPOSED, NEVER A SECOND COPY
   ══════════════════════════════════════════════════════════════════════════════════════════

   The brief this slice was written from recorded that no `no-reply@` / `mailer-daemon@` /
   `postmaster@` / empty-`Return-Path` exclusion existed. It does, and has since 0087:
   `SERVICE_LOCAL_PREFIXES` + `isServiceSender` in `rules.ts`, reached through
   `autoReplySuppression`, plus the away-only header tests in `away-eligibility.ts`. Writing the
   brief's local-part list out again here would have been a SECOND, drifting encoding of exactly
   the thing `rules.ts` says must have one ("a second, drifting encoding of 'this was generated,
   not typed' is precisely how one of those ships").

   So `neverAutoReply` is a COMPOSITION: it calls `autoReplySuppression`, keeps the away-only
   header tests, and adds the ONE member that was genuinely missing — a message that is itself a
   delivery report. The block below is what makes "composed, not copied" checkable: every local
   part the brief listed is asserted refused THROUGH this predicate, so if somebody ever inlines
   a list here the shared implementation stops being the thing under test and these cases still
   pass — which is why the last case asserts the composition itself.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("neverAutoReply — the composed never-reply predicate", () => {
  const never = (headers: Record<string, unknown>, sender = "colleague@example.com") =>
    neverAutoReply(headers, sender);

  it("refuses every service local part the report named — through the SHARED test", () => {
    for (const s of [
      "no-reply@x.example", "noreply@x.example", "no_reply@x.example", "do-not-reply@x.example",
      "donotreply@x.example", "MAILER-DAEMON@x.example", "mailer-daemon@x.example", "postmaster@x.example",
      "bounce@x.example", "bounces@x.example", "bounce-123-abc@x.example",
    ]) expect(never({}, s.toLowerCase()), s).toBe("service_sender");
  });

  it("refuses the five bulk/auto headers and the empty Return-Path", () => {
    expect(never(hdr({ "List-Id": "<a.b>" }))).toBe("list_mail");
    expect(never(hdr({ "Feedback-ID": "c:1" }))).toBe("list_mail");
    expect(never(hdr({ "List-Unsubscribe": "<mailto:x@y>" }))).toBe("list_mail");
    expect(never(hdr({ Precedence: "bulk" }))).toBe("list_mail");
    expect(never(hdr({ Precedence: "list" }))).toBe("list_mail");
    expect(never(hdr({ "Auto-Submitted": "auto-replied" }))).toBe("auto_submitted");
    expect(never(hdr({ "X-Auto-Response-Suppress": "All" }))).toBe("auto_reply_suppressed");
    expect(never(hdr({ "Return-Path": "<>" }))).toBe("null_return_path");
  });

  /**
   * THE ONE NEW MEMBER. A Delivery Status Notification is `multipart/report` with
   * `report-type=delivery-status` (RFC 6522 §3 / RFC 3464). Some MTAs send one from an address
   * with no service local part and with a present, non-empty `Return-Path`, and RFC 3834
   * compliance is not universal — so a DSN could reach the send path with every other guard
   * clear, which is how a bounce of an away reply earns a reply of its own.
   */
  it("refuses a delivery report, which is the shape a bounce actually arrives in", () => {
    expect(never(hdr({ "Content-Type": "multipart/report; report-type=delivery-status" })))
      .toBe("bounce_report");
    expect(never(hdr({ "Content-Type": 'multipart/report; report-type="delivery-status"' })))
      .toBe("bounce_report");
    // Case-blind and parameter-order-blind, because a header map is whatever the sender wrote.
    expect(never(hdr({ "CONTENT-TYPE": "MULTIPART/REPORT; REPORT-TYPE=DELIVERY-STATUS" })))
      .toBe("bounce_report");
    expect(never(hdr({ "Content-Type": "multipart/report;\r\n boundary=x; report-type=delivery-status" })))
      .toBe("bounce_report");
  });

  /**
   * AND IT DOES NOT FIRE ON ORDINARY MAIL, which is the half a refusal-only block cannot prove.
   * `multipart/mixed` and `multipart/report; report-type=disposition-notification` (a READ
   * RECEIPT — a person's client asking for one, not a bounce) are both ordinary.
   */
  it("POSITIVE CONTROL: ordinary mail, and a read receipt, are not delivery reports", () => {
    expect(never({})).toBeNull();
    expect(never(hdr({ "Content-Type": "multipart/mixed; boundary=x" }))).toBeNull();
    expect(never(hdr({ "Content-Type": "text/plain; charset=utf-8" }))).toBeNull();
    expect(never(hdr({ "Content-Type": "multipart/report; report-type=disposition-notification" })))
      .toBeNull();
    expect(never(hdr({ "Auto-Submitted": "no" }))).toBeNull();
    expect(never(hdr({ "Return-Path": "<colleague@example.com>" }))).toBeNull();
  });

  /**
   * THE SITE/SYSTEM MAILBOX (0.16.2 owner report) — RFC 3834 §2, and the arm that has to work
   * on the AUTHOR because the headers carry nothing. The measured message had 23 headers and
   * not one of the markers above it: an away reply went out and its bounce came back.
   */
  it("refuses a site or system mailbox, with no automatic marker in the headers at all", () => {
    for (const s of [
      "wordpress@example.com", "WordPress@example.com", "root@example.com",
      "www-data@example.com", "www_data@example.com", "daemon@example.com",
      "cron@example.com", "nobody@example.com",
    ]) expect(never({}, s.toLowerCase()), s).toBe("site_notification");
  });

  /**
   * POSITIVE CONTROL, and it is the reason the rule matches the WHOLE local part rather than a
   * prefix. Each address below was measured on a real mailbox as a sender a person answers:
   * `wpe@`/`wpeteam@` are a hosting company's people, `webmaster@` and `abuse@` are human roles
   * (each with mail of their own), and a local part may simply be a domain or a name that starts with one
   * of the members. `startsWith` would have silenced all six.
   */
  it("POSITIVE CONTROL: a prefix of a member is still a person, and is answered", () => {
    for (const s of [
      "wpe@example.com", "wpeteam@example.com", "webmaster@example.com", "abuse@example.com",
      "rootsmith@example.com", "www-insync-hq-com@example.com", "cronin@example.com",
    ]) expect(never({}, s), s).toBeNull();
  });

  /**
   * COMPOSED, NOT COPIED — asserted rather than reviewed. `neverAutoReply`'s source must CALL
   * `autoReplySuppression`; a version that inlined the local parts would pass every case above
   * and would be the second encoding this predicate exists to avoid. The source text is the only
   * place that distinction is visible.
   */
  it("calls the shared `autoReplySuppression` and holds no local-part list of its own", () => {
    const src = readFileSync(
      new URL("../src/away-eligibility.ts", import.meta.url), "utf8",
    );
    expect(src).toContain("autoReplySuppression(");
    // The prefixes live in `rules.ts` exactly once. Any of them appearing here as a string
    // literal is a copy — comments are stripped first, so the argument above may name them.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
    // `service_sender` may only ever be PRODUCED by the shared function — a literal here would
    // mean somebody re-derived the verdict rather than calling for it.
    expect(code).not.toContain('"service_sender"');
    expect(code).not.toContain("SERVICE_LOCAL_PREFIXES");
    /* The local parts themselves. `bounce` is deliberately NOT in this list: `"bounce_report"` is
       a REASON member of this module's own union and contains it, so asserting on `"bounce` failed
       against correct code — a checker that fires on innocent content, which costs as much as one
       that cannot fire. The five below cannot appear in this file for any other purpose. */
    for (const p of ["no-reply", "noreply", "donotreply", "postmaster", "mailer-daemon"]) {
      expect(code.toLowerCase(), `\`${p}\` is spelled out in away-eligibility.ts`)
        .not.toContain(`"${p}`);
    }
  });
});
