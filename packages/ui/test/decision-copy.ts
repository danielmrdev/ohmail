/**
 * The decision bar's English words, as a TEST FIXTURE.
 *
 * `DecisionBar` carries no copy of its own — the host reads `messages/*.json` and hands the words
 * down (`apps/webapp/app/shell/decision-copy.ts`). A test has no catalogue and no provider, so it
 * brings its own pack, built the same way the real one is: the place name for titles, the verb for
 * the capsule, and a ✓ half for exactly the destinations `DECISION_QUIET` does not name.
 *
 * The strings are the English the catalogue serves. They are here so the assertions can name a
 * word; they are not a default, and nothing outside `test/` may import them.
 */
import {
  DECISION_KEY,
  DECISION_QUIET,
  type DecisionBarCopy,
  type DecisionDestination,
} from "@ohmail/ui";

const PLACE: Record<DecisionDestination, string> = {
  ohbox: "Ohbox",
  reads: "Reads",
  receipts: "Receipts",
  screened: "Screened out",
  spam: "Spam",
};
const VERB: Record<DecisionDestination, string> = { ...PLACE, screened: "Screen out" };

export function enDecisionCopy(ruleTarget: string): DecisionBarCopy {
  const dest = {} as DecisionBarCopy["dest"];
  for (const d of Object.keys(PLACE) as DecisionDestination[]) {
    const k = DECISION_KEY[d];
    dest[d] = {
      label: VERB[d],
      title: `${PLACE[d]} (${k})`,
      ...(DECISION_QUIET.has(d)
        ? {}
        : {
            check: {
              label: `${PLACE[d]}, mark read`,
              title: `${PLACE[d]}, mark read (${k.toUpperCase()})`,
            },
          }),
    };
  }
  return {
    dest,
    scopeAria: "Decision scope",
    scopeSender: "this sender",
    scopeDomain: "whole domain",
    rule: `Becomes a rule — future mail from ${ruleTarget} files automatically.`,
    halvesLabel: "What each half of the button does",
    halves: "The name files the mail waiting here; the ✓ files it and marks it read.",
    back: "Screener",
  };
}
