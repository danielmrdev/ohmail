/**
 * NOTHING ORGANIZES THESE MAILBOXES, on the phone's own wire shape and by the one derivation every surface maps from
 * (`organizerSituation`, through `@ohmail/client-engine`): never agreed, or nothing holds a consented one — a hand-back
 * included, which this wire carries no marker for. The phone reads an absent consent as `null`, so a server too old to
 * send the column reads as not organizing — the direction that never claims screening without consent.
 */
import { gateKept, nothingOrganizesWhy, type NothingOrganizesWhy } from "@ohmail/client-engine";
import { Copy } from "../copy";
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

/** The state's sentence and its press: the waiting shelf's own, so both surfaces say one thing. */
export function notOrganizingSay(why: NothingOrganizesWhy): { title: string; hint: string; press: string } {
  return {
    title: why === "never_agreed" ? Copy.waitingNotYetTitle : Copy.waitingNotOrganizedTitle,
    hint: Copy.waitingNotYetHint,
    press: Copy.waitingNotYetPress,
  };
}

/** What the Ohbox's knock slot draws: the knock, the state in its place, or nothing. */
export type KnockSlot = { k: "knock" } | { k: "state"; why: NothingOrganizesWhy } | { k: "none" };

/**
 * WHERE NOTHING ORGANIZES ANY LIVE MAILBOX the knock may not read "N waiting · Screener": that
 * Screener's decisions nothing carries out, and strangers go straight to the Ohbox. The state
 * stands in its place whatever the count, unless the strip above already says it.
 */
export function knockSlotOf(none: NothingOrganizesWhy | null, stripSaysIt: boolean): KnockSlot {
  if (none === null) return { k: "knock" };
  return stripSaysIt ? { k: "none" } : { k: "state", why: none };
}
