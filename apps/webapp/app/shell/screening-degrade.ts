import type { screeningDegrade } from "@ohmail/client-engine";

/** A mailbox screened by no stated window, and whose window is missing (`screeningDegrade`). */
export type ScreeningDegrade = NonNullable<ReturnType<typeof screeningDegrade>>;

/**
 * THE SENTENCE A READER SAYS BESIDE A FOLDER-WHOLE COUNT (RULING-026): never a windowed count
 * nobody chose, never a silent superset. `prefix` is the namespace a root translator needs.
 */
export function degradeSentence(
  t: (key: string, values?: Record<string, string>) => string,
  d: ScreeningDegrade | null | undefined,
  prefix = "",
): string | null {
  if (d == null) return null;
  const key = d.state === "unread" ? "degradeUnread" : "degradeUnstated";
  return d.holderName === null ? t(`${prefix}${key}NoName`) : t(`${prefix}${key}`, { holder: d.holderName });
}

/** The count, and the sentence beside it when there is one. */
export function withDegrade(count: string, sentence: string | null): string {
  return sentence === null ? count : `${count}. ${sentence}`;
}
