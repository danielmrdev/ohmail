import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * EVERY SITE THAT CAN SEND AN AWAY REPLY CONSULTS THE ONE DECISION — a census over the pass's own
 * source, and it is a census rather than a survey on purpose.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────
 *
 * The away responder is the one thing in this product that sends mail with nobody looking, and its
 * safety argument is "everything it sends went past `awayEligibility` first". Every behavioural
 * test in this suite proves that for the paths it happens to drive. None of them can prove there is
 * no SECOND path — a retry arm, a "just this once" flush, a second call site added beside the
 * first — and a second path is exactly the shape that would ship: it would look correct, pass every
 * existing case, and answer people no rule had been asked about.
 *
 * A test that drives the pass cannot see that. Only a census over the source can, so this reads the
 * file.
 *
 * ── WHAT IT ASSERTS, AND WHY EACH ONE ───────────────────────────────────────────────────────
 *
 * The properties are chosen so that each fails on a DIFFERENT mistake, and each is watched by a
 * mutation recorded in this lane's commit body:
 *
 *  1. exactly ONE `.send(` in the file — a second delivery site is refused by counting, before
 *     anybody has to reason about whether it is guarded;
 *  2. exactly ONE `awayEligibility(` call — the "one decision site" claim, which is what makes
 *     reasoning about a single call sufficient;
 *  3. the decision comes BEFORE the delivery in the source, and inside the same function;
 *  4. the decision is handed the stored PILES and the bounce fact — a call that omits either
 *     compiles, decides on a narrower question than the operator configured, and every
 *     behavioural test that does not happen to use that dimension stays green;
 *  5. the pile rule is NOT in the candidate SQL, because a `WHERE` clause cannot be watched to
 *     fail and leaves no ledger row to read.
 *
 * ── AND WHY IT IS NOT A REGEX OVER "guarded" ────────────────────────────────────────────────
 *
 * It deliberately does not try to decide whether an arbitrary send is guarded — that is a question
 * a regex cannot answer, and a checker that pretends to is worse than none. It requires the file to
 * stay in the shape where the question does not arise: one send, one decision, in that order.
 * Adding a second send site is meant to fail here and be argued about, not to be pattern-matched.
 */

const SRC = new URL("../src/away-responder-pass.ts", import.meta.url);
const src = readFileSync(SRC, "utf8");

/** Comments stripped, so prose naming a call is never counted as one. */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/[^\n]*$/gm, "");

/** Occurrences of a literal in the code, with their offsets. */
const at = (needle: string): number[] => {
  const out: number[] = [];
  for (let i = code.indexOf(needle); i >= 0; i = code.indexOf(needle, i + 1)) out.push(i);
  return out;
};

describe("the away pass has ONE delivery site and ONE decision site", () => {
  /**
   * ANTI-VACUITY FIRST. Every assertion below is over `code`, so a read that returned an empty
   * string — a moved file, a rename, a stripper that ate the whole body — would satisfy the
   * "exactly one" counts by finding zero of everything. This is the case that makes the rest mean
   * something.
   */
  it("is reading the real pass, with its real body", () => {
    expect(code.length).toBeGreaterThan(5000);
    expect(code).toContain("export async function runAwayResponderPass");
    expect(code).toContain("async function answerOne");
    expect(code).toContain("async function readCandidates");
  });

  it("sends in exactly ONE place", () => {
    const sends = at("adapter.send(");
    expect(sends, `expected one delivery site, found ${sends.length}`).toHaveLength(1);
    /* …and `adapter.send(` is the ONLY spelling of a send in the file, so the count above is a
       count of every delivery and not of one naming convention. Every `.send(` must be that one. */
    const anySend = code.match(/[\w.]*\.send\(/g) ?? [];
    expect(anySend, `unexpected send spellings: ${anySend.join(", ")}`).toEqual(["adapter.send("]);
  });

  it("consults `awayEligibility` in exactly ONE place", () => {
    expect(at("awayEligibility(")).toHaveLength(1);
  });

  it("decides BEFORE it delivers, in the same function", () => {
    const decision = at("awayEligibility(")[0]!;
    const delivery = at("adapter.send(")[0]!;
    expect(decision).toBeLessThan(delivery);
    // Same function: no `async function` declaration between them, or the decision belongs to
    // some earlier function and the send is unguarded in its own.
    const between = code.slice(decision, delivery);
    expect(between, "the decision and the send are in different functions")
      .not.toMatch(/\basync function\b/);
  });

  /**
   * THE DECISION IS HANDED EVERY DIMENSION IT DECIDES ON. This is the assertion that would have
   * caught the shape where `piles` is read from the column, carried on the responder, and then
   * simply not passed — the rule would fall back to whatever its signature defaulted to and the
   * pile setting would appear to save and change nothing.
   */
  it("hands the decision the stored piles and the bounce fact", () => {
    const decision = at("awayEligibility(")[0]!;
    // The call's own argument list, to its closing `);`.
    const call = code.slice(decision, code.indexOf(");", decision) + 2);
    expect(call, "the stored piles do not reach the rule").toContain("responder.piles");
    expect(call, "the audience does not reach the rule").toContain("responder.audience");
    expect(call, "the bounce fact does not reach the rule").toContain("senderUndeliverable");
    expect(call, "the placement does not reach the rule").toContain("desiredFolder");
  });

  /**
   * THE PILE RULE IS NOT IN THE SQL. `readCandidates`'s own header states the law: a guard in the
   * WHERE clause cannot be watched to fail, and a row it refuses writes no ledger row — so nobody
   * can read why a message was not answered, and the message stays in the window for the length of
   * the away period. The pile question is a DECISION about a row in hand and belongs with the rest.
   */
  it("does not filter candidates by pile in SQL", () => {
    const from = code.indexOf("async function readCandidates");
    const to = code.indexOf("async function", from + 10);
    const query = code.slice(from, to > from ? to : undefined);
    expect(query.length).toBeGreaterThan(500);
    for (const leak of ["piles", "ohmail/News", "AWAY_ANSWERABLE_PILES"]) {
      expect(query, `\`${leak}\` appears in the candidate query — the pile rule belongs in the ` +
        "decision, where a test can watch it fail and where a refusal leaves a ledger row")
        .not.toContain(leak);
    }
  });

  /**
   * AND THE BOUNCE SWEEP ASKS THE SHARED QUESTION. "Is this message a delivery report" is asked
   * in two places — the reply rule and this sweep — and they must be one implementation: asked
   * twice they would disagree the first time a sender folded the `Content-Type` header, and the
   * direction of that disagreement is that a HUMAN reply to an away reply is read as a bounce and
   * a live correspondent's address is marked dead.
   */
  it("asks the shared delivery-report question rather than re-deriving it in SQL", () => {
    expect(code).toContain("isDeliveryReport(");
    const from = code.indexOf("async function markUndeliverableFromBounces");
    expect(from).toBeGreaterThan(0);
    const sweep = code.slice(from, code.indexOf("async function", from + 10));
    expect(sweep, "the sweep does not consult the shared report test").toContain("isDeliveryReport(");
    // No second encoding of the content type as a SQL string.
    expect(sweep, "the report shape is re-derived in SQL beside the shared test")
      .not.toContain("multipart/report");
  });
});
