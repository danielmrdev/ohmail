/**
 * THE FIRST-CONTACT TIME A WAITING SENDER'S CAPTION NAMES, or `undefined` for none: the oldest held
 * letter's, only while more than one letter waits and nothing of the sender's is past the gate
 * (`reached`). One held letter has no first contact apart from its own time, and a sender with mail
 * in the lists has none at all. Every surface's held caption asks this one rule.
 */
export function firstContactTime(row: { held: ReadonlyArray<{ time: string }>; reached?: number }): string | undefined {
  if (row.held.length < 2 || (row.reached ?? 0) > 0) return undefined;
  return row.held[0]?.time;
}
