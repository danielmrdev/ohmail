/**
 * NOTHING ORGANIZES THESE MAILBOXES, on the phone's own wire shape and by the one derivation every surface maps from
 * (`organizerSituation`, through `@ohmail/client-engine`): never agreed, or nothing holds a consented one — a hand-back
 * included, which this wire carries no marker for. The phone reads an absent consent as `null`, so a server too old to
 * send the column reads as not organizing — the direction that never claims screening without consent.
 */
import { gateKept, nothingOrganizesWhy, type NothingOrganizesWhy } from "@ohmail/client-engine";
import type { PhoneMailbox } from "../net/mailboxes";

export type NotOrganizingFacts = Pick<
  PhoneMailbox, "status" | "organizerRole" | "organizeConsentedAt" | "organizedBy" | "organizerState"
>;

/** Never agreed and nothing holds it: the reading the decision to organize answers. */
export function notOrganizingYet(m: NotOrganizingFacts): boolean {
  return nothingOrganizesWhy(m) === "never_agreed";
}

/** Why nothing organizes ANY live mailbox, or `null` where one is organized or none was read. */
export function noneOrganizedWhy(rows: readonly NotOrganizingFacts[]): NothingOrganizesWhy | null {
  const live = rows.filter((m) => m.status !== "disabled");
  if (live.length === 0 || live.some((m) => gateKept(m))) return null;
  const whys = new Set(live.map((m) => nothingOrganizesWhy(m)));
  const only = whys.size === 1 ? [...whys][0] : "stopped";
  return only ?? null;
}

/** Every live mailbox is one nothing organizes — the only case the Screener's hint gives way. */
export function noneOrganized(rows: readonly NotOrganizingFacts[]): boolean {
  return noneOrganizedWhy(rows) !== null;
}
