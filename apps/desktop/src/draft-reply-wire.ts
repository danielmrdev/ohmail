import { bridgeAvailable, bridgeFetch } from "./bridge-fetch.js";
import type { DraftReplyRequestOptions, DraftReplyWire } from "../../webapp/app/shell/draft-reply.js";

class DraftReplyRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DraftReplyRefused";
  }
}

async function refusalOf(response: Response): Promise<DraftReplyRefused> {
  let code = "";
  let message = `the mail engine answered ${response.status}`;
  let details: unknown;
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; message?: unknown; details?: unknown };
    };
    if (typeof body.error?.code === "string") code = body.error.code;
    if (typeof body.error?.message === "string") message = body.error.message;
    details = body.error?.details;
  } catch {
    // A non-JSON refusal has no sentence beyond its status.
  }
  return new DraftReplyRefused(response.status, code, message, details);
}

async function request<T>(path: string, options?: DraftReplyRequestOptions): Promise<T> {
  const response = await bridgeFetch(path, options);
  if (!response.ok) throw await refusalOf(response);
  return await response.json() as T;
}

/** The shared draft flow over Desktop's private engine channel, on every engine-backed door. */
export const draftReplyOverBridge: DraftReplyWire = {
  configured: bridgeAvailable,
  request,
};
