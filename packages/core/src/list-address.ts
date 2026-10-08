import { headerValues } from "./rules.js";

/** The address shape a Sent copy's recipients are taught under (`pipeline.ts#sentCopyRecipients`). */
export const ADDRESS_SHAPE = /^[^\s@<>,"]+@[^\s@<>,"]+$/;

/** One stored message names at most this many list addresses. */
export const LIST_POST_ADDRESSES_MAX = 5;

/**
 * THE ADDRESSES A MAILING LIST POSTS AS, from `List-Post` (RFC 2369 §3.4): each `mailto:` URL, its
 * query cut and its address percent-decoded, lower-cased, kept only when address-shaped. `NO`
 * (posting not allowed) is no URL and names nothing. Whitespace inside a URL is ignored, as the RFC
 * says, so a folded line reads whole; outside angle brackets a comment is dropped. The one parser:
 * every reader of a list address calls it, and none respells it.
 */
export function listPostAddresses(headers: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const value of headerValues(headers, "list-post") ?? []) {
    const urls = value.includes("<")
      ? [...value.matchAll(/<([^<>]*)>/g)].map((m) => m[1]!)
      : value.replace(/\([^()]*\)/g, " ").split(",");
    for (const url of urls) {
      const target = /^mailto:([^?]*)/i.exec(url.replace(/\s+/g, ""))?.[1];
      for (const part of target?.split(",") ?? []) {
        const address = percentDecoded(part)?.trim().toLowerCase();
        if (address === undefined || !ADDRESS_SHAPE.test(address) || out.includes(address)) continue;
        out.push(address);
        if (out.length === LIST_POST_ADDRESSES_MAX) return out;
      }
    }
  }
  return out;
}

/** `undefined` for a malformed escape: no address is read out of bytes that do not decode. */
function percentDecoded(s: string): string | undefined {
  try { return decodeURIComponent(s); } catch { return undefined; }
}
