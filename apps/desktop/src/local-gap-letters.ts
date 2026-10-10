/**
 * ANSWERING THE GAP OFFER FROM THIS WINDOW (mail 0151) — the desktop half of one shared line, on
 * the organizer notice's argument: the published bundle aliases the Cloud client to a refusing
 * stub, so the wire is injected here. `POST /mailboxes/:id/gap-letters` is served out of this
 * machine's store on the standalone door and forwarded to the account on the hosted one.
 */
import { bridgeFetch } from "./bridge-fetch.js";
import type { GapLettersTransport } from "../../webapp/app/shell/GapLettersNotice";

/** MUST REJECT on failure, with the status and code: a 409 is a count that moved since it was shown. */
export const gapLettersOverBridge: GapLettersTransport = async (mailboxId, answer) => {
  const res = await bridgeFetch(`/mailboxes/${encodeURIComponent(mailboxId)}/gap-letters`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(answer),
  });
  if (!res.ok) {
    const code = await res.json().then((b: { error?: { code?: unknown } }) => b?.error?.code, () => undefined);
    throw Object.assign(new Error(`${res.status}`), { status: res.status, code });
  }
  return undefined;
};
