/**
 * The desktop's AI reply drafter, through its private engine pipe. Standalone mode drafts with
 * the configured BYO model; hosted mode forwards to the account's drafter. The browser's default
 * path remains the metered Cloud API.
 */

import type { DraftReplyTransport } from "../../webapp/app/shell/draft-reply.js";
import { bridgeFetch } from "./bridge-fetch.js";

interface WireError {
  error?: { code?: string; message?: string; details?: unknown };
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let wire: WireError = {};
    try {
      wire = (await res.json()) as WireError;
    } catch {
      /* Keep the status as the only available fact. */
    }
    const error = new Error(wire.error?.message ?? `the mail engine answered ${res.status}`) as Error & {
      status: number;
      code?: string;
      details?: unknown;
    };
    error.status = res.status;
    if (wire.error?.code) error.code = wire.error.code;
    if (wire.error?.details !== undefined) error.details = wire.error.details;
    throw error;
  }
  return (await res.json()) as T;
}

/** Create once by idempotency key, then read the stored draft without another model call. */
export const desktopDraftReplyTransport: DraftReplyTransport = {
  async create(messageId, idempotencyKey) {
    return readJson(await bridgeFetch(`/messages/${encodeURIComponent(messageId)}/draft`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
    }));
  },
  async read(draftId) {
    return readJson(await bridgeFetch(`/drafts/${encodeURIComponent(draftId)}`));
  },
};
