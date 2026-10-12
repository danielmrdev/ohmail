/**
 * WHAT A SCREEN-OUT PRESS SAYS ABOUT THE ONE-CLICK UNSUBSCRIBE, BEFORE THE PRESS — one decider for
 * every surface (web card, row, bulk and sheet; the desktop; the phone's sheet and toasts).
 *
 * The server asks for the SENDER, not for the letters on screen: the press's own moves, the past-mail
 * pass and the hourly drain all send for any of their mail that offers one-click. So an armed press
 * always says the sender-level condition (`may_send`), and a held letter seen offering one-click only
 * strengthens it (`sends`). `none` is the caller's alone: the account's switch off, a door that sends
 * nothing, or a press that does not reach the decide route.
 */
import type { EntityReader } from "./store.js";
import type { MessageBodyRecord, UnsubscribeHeaderState } from "./types.js";

export type UnsubscribeClaim = "sends" | "may_send" | "none";

export function unsubscribeClaim(o: {
  armed: boolean;
  /** The held letters the client can read: each one's posture, or `null` while its body is unread. */
  postures: readonly (UnsubscribeHeaderState | null)[];
}): UnsubscribeClaim {
  if (!o.armed) return "none";
  return o.postures.some((p) => p === "one_click") ? "sends" : "may_send";
}

/**
 * One letter's posture as the server stated it, or `null` when no answer carrying it is held: a body
 * not yet read, still loading, failed, or written by a build that predates the field. `bodyOf`'s
 * `"no_header"` default is right for an action and wrong here, where it would silence a claim.
 */
export function unsubscribePostureOf(reader: EntityReader, messageId: string): UnsubscribeHeaderState | null {
  const rec = reader.get<MessageBodyRecord>("message_body", messageId);
  if (!rec || rec.state !== "ready" || typeof rec.unsubscribe !== "string") return null;
  return rec.unsubscribe;
}
