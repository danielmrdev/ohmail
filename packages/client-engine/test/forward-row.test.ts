import { describe, expect, it } from "vitest";
import { isForwardedByUs } from "../src/selectors.js";

/**
 * THE FORWARD ROW'S PREDICATE — an own-sent row whose subject opens with an unambiguous forward
 * prefix, in either of the two forms the mirror holds: the ingested Sent copy (its folder is the
 * Sent path) and the confirm-time overlay (`local: true`). Display only; both surfaces face such a
 * row "Forwarded to …" off this one answer. Mutation watched red: drop the `local === true` arm —
 * the overlay case fails; read `startsWith("Fwd")` instead of the table — the WG: case fails.
 */
describe("isForwardedByUs", () => {
  const own = (subject: string, extra: Record<string, unknown> = {}) =>
    ({ folder: "Sent", subject, ...extra }) as never;

  it("the account's own Sent copy of a forward, in English and in German", () => {
    expect(isForwardedByUs(own("Fwd: Angebot"))).toBe(true);
    expect(isForwardedByUs(own("FW: Angebot"))).toBe(true);
    expect(isForwardedByUs(own("WG: Angebot"))).toBe(true);
    expect(isForwardedByUs(own("Fwd: Re: Angebot"))).toBe(true);
  });

  it("the confirm-time overlay counts as own-sent by its `local` flag", () => {
    expect(isForwardedByUs({ folder: "INBOX", subject: "Fwd: Angebot", local: true } as never)).toBe(true);
  });

  it("the account's own REPLY keeps its sender face — a reply to a forward included", () => {
    expect(isForwardedByUs(own("Re: Angebot"))).toBe(false);
    expect(isForwardedByUs(own("AW: Angebot"))).toBe(false);
    expect(isForwardedByUs(own("Re: Fwd: Angebot"))).toBe(false);
    expect(isForwardedByUs(own("Angebot"))).toBe(false);
  });

  it("a RECEIVED forward is somebody else's — never faced as ours", () => {
    expect(isForwardedByUs({ folder: "INBOX", subject: "Fwd: Angebot" } as never)).toBe(false);
    expect(isForwardedByUs({ folder: "INBOX", subject: "WG: Angebot", local: false } as never)).toBe(false);
  });

  it("a token that is a reply in one language and a forward in another is not a forward face", () => {
    expect(isForwardedByUs(own("VS: Angebot"))).toBe(false);
  });
});
