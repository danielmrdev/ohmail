/**
 * WHY A READER'S PRESS HAS NOWHERE TO GO — one decider, asked by the server's refusal and by the
 * client's pane, so the two cannot name one state differently. A holder is LIVE while it is named
 * and its lease has not lapsed: `stopped` is the lease's own verdict (nothing renewed within the
 * claim's window), persisted as `organizer_state`; `null` is "not looked yet" and reads live, as
 * every banner does. Only a live holder is `organizer_outdated` — its build cannot take this from
 * a reader. None named, or one that stopped, is `no_organizer`: telling a person to update ohmail
 * on a machine that stopped organizing sends them to the wrong machine. Import-free on purpose.
 */
export type RequestRefusalReason = "organizer_outdated" | "no_organizer";

/** The two lease facts a mailbox row carries about its holder, in either tier's spelling. */
export interface HolderLeaseFacts {
  by?: { kind?: string | null; name?: string | null } | null;
  state?: string | null;
}

/** Is a holder recorded at all: a kind, or a name that is not blank. */
function holderNamed(f: HolderLeaseFacts | null | undefined): boolean {
  const by = f?.by;
  return Boolean(by && (by.kind || (by.name && by.name.trim() !== "")));
}

/** Is somebody still organizing the mailbox: a named holder whose lease has not lapsed. */
export function holderIsLive(f: HolderLeaseFacts | null | undefined): boolean {
  return holderNamed(f) && f?.state !== "stopped";
}

/**
 * Did a named holder stop: recorded, and not live. Nobody named is "nobody", never a stop — the
 * sentence for a stop names the machine that stopped, and there is none to name.
 */
export function holderStopped(f: HolderLeaseFacts | null | undefined): boolean {
  return holderNamed(f) && !holderIsLive(f);
}

/**
 * Has the door read the lease for this row. `false` only on a reader row the door says it has not
 * looked at, where a NULL state is "not looked", not "nobody"; absent is a door that cannot say.
 */
export function holderAnswered(
  m: { organizerRole?: "organizer" | "reader" | null; organizerChecked?: boolean } | null | undefined,
): boolean {
  return m?.organizerRole !== "reader" || m.organizerChecked !== false;
}

/** One mailbox that refused: the reason its refusal carries. */
export function requestRefusalReason(f: HolderLeaseFacts | null | undefined): RequestRefusalReason {
  return holderIsLive(f) ? "organizer_outdated" : "no_organizer";
}

/** Several that refused, as one account-wide answer: outdated if any holder is live. */
export function rosterRefusalReason(rows: readonly (HolderLeaseFacts | null | undefined)[]): RequestRefusalReason {
  return rows.some(holderIsLive) ? "organizer_outdated" : "no_organizer";
}

/** The row facts the organizing situation is read from, in the DTO's own names; absent is "this build cannot tell". */
export interface OrganizerSituationFacts {
  status?: string | null;
  organizerRole?: "organizer" | "reader" | null;
  organizerChecked?: boolean;
  organizeConsentedAt?: string | null;
  organizedBy?: { kind?: string | null; name?: string | null; since?: string | null } | null;
  organizerState?: string | null;
  organizerReleasedAt?: string | null;
  organizerParkedAt?: string | null;
  releaseRequestedAt?: string | null;
  takeoverAuthorizedAt?: string | null;
}

/** A recorded holder, as a sentence names it. */
export interface SituationHolder {
  kind: string | null;
  name: string | null;
  since: string | null;
}

/** Why nothing organizes a mailbox: three states that want three sentences and three different presses. */
export type NothingOrganizesWhy = "never_agreed" | "handed_back" | "stopped";

/** What a reader row is with no press of this install's standing on it. `lapsed` names a holder that stopped. */
export type StandingSituation =
  | { kind: "organized_elsewhere"; by: SituationHolder }
  | { kind: "nothing_organizes"; why: NothingOrganizesWhy; lapsed: SituationHolder | null }
  | { kind: "parked" }
  | { kind: "unknown" };

/**
 * WHO ORGANIZES THIS MAILBOX, ONE ANSWER FOR EVERY SURFACE. Closed: a surface maps each member to its
 * sentence and none re-derives one. A pending "Organize here" carries the standing state it waits on,
 * so a press never reads as organizing before the gate promotes. No clock: the lease's own `stopped`
 * verdict, persisted one reader cycle behind, is the only staleness bound.
 */
export type OrganizerSituation =
  | { kind: "organizing_here" }
  | { kind: "stopping_here" }
  | { kind: "starting_here"; standing: StandingSituation }
  | StandingSituation;

const stated = (v: string | null | undefined): boolean => v !== null && v !== undefined;

export function organizerSituation(m: OrganizerSituationFacts): OrganizerSituation {
  if (m.status === "disabled") return { kind: "unknown" };
  if (m.organizerRole !== "reader") {
    return stated(m.releaseRequestedAt) ? { kind: "stopping_here" } : { kind: "organizing_here" };
  }
  const standing = standingSituation(m);
  return stated(m.takeoverAuthorizedAt) ? { kind: "starting_here", standing } : standing;
}

/**
 * A reader's standing state. The release marker is the person's own act, so a handed-back mailbox
 * is told apart from one whose holder stopped — but a holder recorded after the release (the release
 * clears the columns) is the newer fact. An absent consent with nobody recorded says nothing.
 */
function standingSituation(m: OrganizerSituationFacts): StandingSituation {
  if (stated(m.organizerParkedAt)) return { kind: "parked" };
  const lease = { by: m.organizedBy, state: m.organizerState };
  const by = m.organizedBy;
  const holder = holderNamed(lease)
    ? { kind: by?.kind ?? null, name: by?.name ?? null, since: by?.since ?? null } : null;
  if (holder !== null && holderIsLive(lease)) return { kind: "organized_elsewhere", by: holder };
  if (!holderAnswered(m)) return { kind: "unknown" };
  if (m.organizeConsentedAt === null) return { kind: "nothing_organizes", why: "never_agreed", lapsed: holder };
  if (m.organizeConsentedAt === undefined && holder === null) return { kind: "unknown" };
  if (holder === null && stated(m.organizerReleasedAt)) return { kind: "nothing_organizes", why: "handed_back", lapsed: null };
  return { kind: "nothing_organizes", why: "stopped", lapsed: holder };
}

/** The standing state under a pending press, or the situation itself. */
export function standingOf(s: OrganizerSituation): Exclude<OrganizerSituation, { kind: "starting_here" }> {
  return s.kind === "starting_here" ? s.standing : s;
}

/**
 * IS SOMEBODY KEEPING THE GATE — false only where nothing organizes the mailbox, for any of the three
 * reasons, so no surface says "all clear" over first-time senders that go straight to the Ohbox.
 * `unknown` and `parked` claim nothing here: one is unread, the other has its own account line.
 */
export function gateKept(m: OrganizerSituationFacts): boolean {
  return standingOf(organizerSituation(m)).kind !== "nothing_organizes";
}

/** Why nothing organizes this mailbox, or `null` while something does or nothing can be said. */
export function nothingOrganizesWhy(m: OrganizerSituationFacts): NothingOrganizesWhy | null {
  const s = standingOf(organizerSituation(m));
  return s.kind === "nothing_organizes" ? s.why : null;
}

/**
 * NOBODY HAS AGREED, AND NOTHING ELSE ORGANIZES IT — the first run was left before "Agree and start
 * organizing". The `never_agreed` member of {@link organizerSituation}: consent `=== null` only, and
 * only once the lease has been READ with no live holder.
 */
export function notOrganizingYet(m: OrganizerSituationFacts): boolean {
  return nothingOrganizesWhy(m) === "never_agreed";
}
