import type { Deck } from "../copy";
import type { WorldEarlier } from "../state/live";

/**
 * THE HEADING OVER THE CONVERSATION'S OTHER MEMBERS, which the phone's reader lists below the opened
 * message. It names them for where they stand against it: all older is "Earlier", all newer is
 * "Later", both is "the rest" — never "Earlier" over a letter written after the one above it (the
 * opened message need not be the newest). The count is the whole conversation, the opened one too.
 */
export function threadHeading(
  copy: Pick<Deck, "earlierInThread" | "laterInThread" | "restOfThread">,
  members: readonly Pick<WorldEarlier, "later">[],
): string {
  const n = members.length + 1;
  const later = members.filter((h) => h.later === true).length;
  if (later === 0) return copy.earlierInThread(n);
  return later === members.length ? copy.laterInThread(n) : copy.restOfThread(n);
}
