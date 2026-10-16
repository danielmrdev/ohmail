import { describe, it, expect } from "vitest";
import { planChange } from "../src/pipeline.js";
import { FakeRepo } from "./fakes.js";
import { resolveScreeningCutoff, DEFAULT_DORMANCY_DAYS, type Rule } from "../src/rules.js";
import type { Change } from "../src/ports.js";

/**
 * THE GATE DOES NOT REACH BACK PAST THE SCREENING BASELINE (mail 0056).
 *
 * `evaluateRules` answers `ohmail/Screener` for any sender with no rule, and `planChange` applies
 * it — so a backfill pass that reaches further into somebody's mailbox physically MOVES years-old
 * mail to the gate and queues it for a decision nobody is going to make. On a mailbox with years of
 * history that is the normal case rather than a corner: the backfill walks newest-first, so after
 * the first pass essentially everything it delivers predates the window.
 *
 * The cutoff subordinates the gate's own verdict — and nothing else. The three "must not"s each
 * have a test below, because each of them is a way of turning a backlog rule into a consent
 * bypass:
 *
 *   · a `rule` verdict is the user's decision and outranks a date, in BOTH directions;
 *   · an auth-FAIL demotion produces the same `screener` verdict for a different reason, and an
 *     old date must not excuse a message whose own authentication failed;
 *   · absent cutoff ⇒ nothing changes at all.
 */

const OLD = new Date("2024-01-05T09:00:00.000Z");
const NEW = new Date("2026-08-10T09:00:00.000Z");
const BASELINE = new Date("2026-08-01T00:00:00.000Z");
/** `BASELINE - 60d` ⇒ 2026-06-02. `OLD` is well before it; `NEW` is well after. */
const CUTOFF = resolveScreeningCutoff(BASELINE, null)!;

function eml(opts: { from?: string; date?: Date; headers?: string[] } = {}): Buffer {
  const { from = "stranger@nowhere.example", date = NEW, headers = [] } = opts;
  return Buffer.from([
    `Message-ID: <${from}-${date.getTime()}@nowhere.example>`,
    `From: ${from}`,
    "To: mila@lichtgrat.example",
    `Date: ${date.toUTCString()}`,
    "Subject: Hello",
    ...headers,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Just saying hi.",
  ].join("\r\n"));
}

function create(raw: Buffer, extra: Partial<Change> = {}): Change {
  return { type: "create", locator: { folder: "INBOX", ref: "1:10" }, raw, ...extra };
}

async function desiredFor(change: Change, opts: {
  screeningCutoff?: Date; rules?: Rule[]; trustedAuthservIds?: ReadonlySet<string>;
} = {}): Promise<string | undefined> {
  const repo = new FakeRepo();
  if (opts.rules) repo.rules = opts.rules;
  const plan = await planChange(change, {
    repo, accountId: "acct-1", mailboxId: "mb-1",
    ...(opts.screeningCutoff ? { screeningCutoff: opts.screeningCutoff } : {}),
    ...(opts.trustedAuthservIds ? { trustedAuthservIds: opts.trustedAuthservIds } : {}),
  });
  return plan.new?.desired;
}

describe("the screening cutoff", () => {
  it("CUTOFF ABSENT: an old stranger is still held at the gate — nothing changes", async () => {
    // The dangerous-default rule. Every existing caller and test is this branch.
    expect(await desiredFor(create(eml({ date: OLD })))).toBe("ohmail/Screener");
  });

  it("A PRE-CUTOFF STRANGER'S MESSAGE IS NOT FILED INTO THE SCREENER", async () => {
    // The guard. It keeps the folder the mail server already had it in — not the Ohbox, not a
    // heuristic destination: the claim is "leave the backlog alone", and choosing a folder for it
    // would be a placement nobody asked for. `internalDate` because the SERVER's clock is the
    // only one that can say "backlog" — see the header-date tests below.
    expect(await desiredFor(create(eml({ date: OLD }), { internalDate: OLD }), { screeningCutoff: CUTOFF }))
      .toBe("INBOX");
  });

  it("…and a POST-cutoff stranger is still held, which is the whole gate", async () => {
    expect(await desiredFor(create(eml({ date: NEW }), { internalDate: NEW }), { screeningCutoff: CUTOFF }))
      .toBe("ohmail/Screener");
  });

  it("INTERNALDATE DECIDES ALONE — a back-dated `Date:` cannot buy a way past the gate", async () => {
    // The header is written by the SENDER. Without INTERNALDATE outranking it, `Date: 2024` on a
    // fresh delivery is a one-message, unauthenticated bypass of the consent gate: the message
    // would keep its arrival folder, which for a stranger's delivery is the INBOX.
    const forged = create(eml({ date: OLD }), { internalDate: NEW });
    expect(await desiredFor(forged, { screeningCutoff: CUTOFF })).toBe("ohmail/Screener");

    // …and the honest direction: genuinely old mail whose sender stamped a future date is still
    // backlog, because INTERNALDATE says when the server received it.
    const backfilled = create(eml({ date: NEW }), { internalDate: OLD });
    expect(await desiredFor(backfilled, { screeningCutoff: CUTOFF })).toBe("INBOX");
  });

  it("THE HEADER `Date:` IS NEVER THE BACKLOG CLOCK — backdated mail with no INTERNALDATE stays at the gate", async () => {
    // The SEC2 BASELINE-DATE finding. This used to read `change.internalDate ?? normalized.date`,
    // and on a server that omits or mangles INTERNALDATE the sender-controlled header became the
    // gate's clock: a stranger's freshly-delivered mail with `Date:` in the past kept its arrival
    // folder — the INBOX — with no rule, no contact and no user action. The header may order and
    // display; only the server clock may say "backlog". No INTERNALDATE ⇒ age unknown ⇒ the gate,
    // exactly like the undated message below.
    expect(await desiredFor(create(eml({ date: OLD })), { screeningCutoff: CUTOFF }))
      .toBe("ohmail/Screener");
  });

  it("NO DATE AT ALL IS NOT OLD — an undated message stays at the gate", async () => {
    // Unknown, not ancient, and the safe answer for an unknown is the gate.
    const undated = Buffer.from([
      "Message-ID: <undated@nowhere.example>",
      "From: stranger@nowhere.example",
      "To: mila@lichtgrat.example",
      "Subject: Hello",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Just saying hi.",
    ].join("\r\n"));
    expect(await desiredFor(create(undated), { screeningCutoff: CUTOFF })).toBe("ohmail/Screener");
  });

  it("A RULE IS NEVER SUBORDINATED — a screened-out sender's old mail still goes to Screened", async () => {
    // `source === "rule"`, both directions. This is the user's own decision and a date must not
    // reopen it: the deny side would be a sender the user removed reappearing in the INBOX.
    const deny: Rule = {
      id: "r-deny", kind: "sender", match: "spammer@nowhere.example",
      destination: "ohmail/Screened", effect: "deny", priority: 10,
      provenance: "manual", enabled: true,
    };
    expect(await desiredFor(
      create(eml({ from: "spammer@nowhere.example", date: OLD })),
      { screeningCutoff: CUTOFF, rules: [deny] },
    )).toBe("ohmail/Screened");

    // …and the allow side: an old message from an admitted sender still lands where the rule says,
    // rather than being left in its arrival folder.
    const allow: Rule = {
      id: "r-allow", kind: "sender", match: "known@nowhere.example",
      destination: "ohmail/News", effect: "allow", priority: 10,
      provenance: "manual", enabled: true,
    };
    expect(await desiredFor(
      create(eml({ from: "known@nowhere.example", date: OLD })),
      { screeningCutoff: CUTOFF, rules: [allow] },
    )).toBe("ohmail/News");
  });

  it("AN AUTH-FAIL DEMOTION IS NEVER SUBORDINATED, THOUGH IT IS ALSO `source: screener`", async () => {
    // The subtle one. `evaluateRules` returns the SAME verdict object for "nobody has ruled on
    // this sender" and for "this message's Authentication-Results said fail", so the source alone
    // cannot tell them apart. Only the first is a backlog question. Without the `authVerdict`
    // term, an old `Date:` plus a failed DKIM would reach the INBOX.
    const trusted = new Set(["mx.test"]);
    const failing = create(eml({
      from: "known@nowhere.example",
      date: OLD,
      // DMARC, because it is aligned by definition and is the one verdict `authVerdictFromHeaders`
      // reads without a second alignment judgement — see its docblock. The authserv-id has to be
      // one this deployment trusts, or the header is worth exactly as much as none.
      headers: ["Authentication-Results: mx.test; dmarc=fail header.from=nowhere.example"],
    }));
    const allow: Rule = {
      id: "r-allow", kind: "sender", match: "known@nowhere.example",
      destination: "INBOX", effect: "allow", priority: 10,
      provenance: "manual", enabled: true,
    };
    expect(await desiredFor(failing, {
      screeningCutoff: CUTOFF, rules: [allow], trustedAuthservIds: trusted,
    })).toBe("ohmail/Screener");
  });
});

describe("resolveScreeningCutoff", () => {
  it("NULL baseline ⇒ undefined ⇒ no cutoff, which is the pre-0056 router", () => {
    expect(resolveScreeningCutoff(null, 60)).toBeUndefined();
    expect(resolveScreeningCutoff(undefined, 60)).toBeUndefined();
  });

  it("an UNPARSEABLE baseline is `undefined` and not an Invalid Date", () => {
    // An Invalid Date would make every comparison against it false — the same routing as no
    // cutoff, reached silently. Answering `undefined` makes the two the same thing on purpose.
    expect(resolveScreeningCutoff(new Date("nonsense"), 60)).toBeUndefined();
  });

  it("subtracts the account's window, and falls back to the product default", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(resolveScreeningCutoff(BASELINE, 5)!.getTime()).toBe(BASELINE.getTime() - 5 * day);
    expect(resolveScreeningCutoff(BASELINE, null)!.getTime())
      .toBe(BASELINE.getTime() - DEFAULT_DORMANCY_DAYS * day);
    // A stored zero or a negative is not a window; the default stands rather than a cutoff at or
    // after the baseline, which would hold nothing back.
    expect(resolveScreeningCutoff(BASELINE, 0)!.getTime())
      .toBe(BASELINE.getTime() - DEFAULT_DORMANCY_DAYS * day);
  });
});
