"use client";

/**
 * Letters that arrived while no device was organizing a mailbox this install now organizes,
 * counted by the person's own rules, and nothing moves until they answer (mail 0151). "File"
 * files exactly the counted set; "Leave" closes the offer. Beside the organizer notice, in its two
 * places (`variant`). A count that moved before the press is refused by the server and re-shown.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";

import type { GapOffer } from "./mail-state";
import { refusalOf } from "./OrganizerNotice";

/** How an answer reaches the row. MUST REJECT on failure, the organizer notice's rule. */
export type GapLettersTransport = (mailboxId: string, answer: { file: boolean; count: number }) => Promise<unknown>;

type Said = "gapChanged" | "gapOffline" | "gapFailed";

export function GapLettersNotice({
  offers,
  onAnswer,
  variant = "rail",
}: {
  offers: readonly GapOffer[];
  onAnswer: GapLettersTransport;
  variant?: "rail" | "shell";
}) {
  const t = useTranslations("mailboxes");
  /* Offers answered in this session, keyed by mailbox AND count: a new count is a new offer. */
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const [said, setSaid] = useState<Said | null>(null);
  const key = (o: GapOffer): string => `${o.id}@${o.count}`;
  const live = offers.filter((o) => !answered.has(key(o)));
  if (live.length === 0) return null;
  const answer = (o: GapOffer, file: boolean): void => {
    void onAnswer(o.id, { file, count: o.count }).then(
      () => { setSaid(null); setAnswered((s) => new Set([...s, key(o)])); },
      (err: unknown) => setSaid((err as { status?: unknown } | null)?.status === 409 ? "gapChanged"
        : refusalOf(err) === "noticeDismissOffline" ? "gapOffline" : "gapFailed"),
    );
  };
  return (
    <>
      {live.map((o) => (
        <div className={variant === "rail" ? "rail-notice" : "notice-shell"} role="status" data-state="gap" key={o.id}>
          <div className="rn-line">
            <span className="rn-mark" aria-hidden="true" />
            <span className="rn-text">{t("gapLetters", { count: o.count, address: o.address })}</span>
          </div>
          <div className="rn-verbs">
            <button type="button" onClick={() => answer(o, true)}>{t("gapFile", { count: o.count })}</button>
            <button type="button" onClick={() => answer(o, false)}>{t("gapLeave", { count: o.count })}</button>
          </div>
          {said ? <p className="rn-refused">{t(said)}</p> : null}
        </div>
      ))}
    </>
  );
}
