import { describe, it, expect } from "vitest";
import {
  MAX_UNSUBSCRIBE_URI_CHARS, oneClickUnsubscribeUri, unsubscribeHeaderState,
} from "../src/rules.js";

/**
 * THE HEADER HALF OF ONE-CLICK UNSUBSCRIBE.
 *
 * Two of these are hard rules of the product and they are the two that were mutation-watched:
 *
 *  · GUARD 1 — a `mailto:`-only `List-Unsubscribe` yields NOTHING. Acting on one means sending
 *    mail on the user's behalf to a third party, which this product does not do.
 *    MUTATION: make `isOneClickUri` accept `u.protocol === "mailto:"` as well as `https:`.
 *  · GUARD 2 — an `https:` URI with no `List-Unsubscribe-Post` is not one-click, so it is not
 *    auto-actioned. MUTATION: drop the `post === null` refusal in `oneClickUnsubscribeUri`.
 *
 * Nothing in this file passes a message BODY, because there is no parameter for one: the parser
 * takes a header map. That is the structural form of "never fetch a URL from the body".
 */

/** A header map with the prototype `mime.ts` builds — see `headerValues` for why it matters. */
function headers(entries: Record<string, string[]>): Record<string, string[]> {
  const h: Record<string, string[]> = Object.create(null);
  for (const [k, v] of Object.entries(entries)) h[k] = v;
  return h;
}

const ONE_CLICK = { "list-unsubscribe-post": ["List-Unsubscribe=One-Click"] };

describe("oneClickUnsubscribeUri — GUARD 1: a mailto: unsubscribe is never used", () => {
  it("offers nothing for a mailto:-only List-Unsubscribe, even WITH the one-click header", () => {
    const h = headers({
      "list-unsubscribe": ["<mailto:unsubscribe@sender.example?subject=unsub>"],
      ...ONE_CLICK,
    });
    expect(oneClickUnsubscribeUri(h)).toBeNull();
    expect(unsubscribeHeaderState(h)).toBe("mailto_only");
  });

  it("skips the mailto: and takes the https: when a sender publishes both", () => {
    const h = headers({
      "list-unsubscribe": ["<mailto:u@sender.example>, <https://sender.example/u?t=abc>"],
      ...ONE_CLICK,
    });
    expect(oneClickUnsubscribeUri(h)).toBe("https://sender.example/u?t=abc");
    expect(unsubscribeHeaderState(h)).toBe("one_click");
  });

  it("refuses http: as firmly as mailto: — a one-click token must not travel in clear", () => {
    const h = headers({ "list-unsubscribe": ["<http://sender.example/u?t=abc>"], ...ONE_CLICK });
    expect(oneClickUnsubscribeUri(h)).toBeNull();
    expect(unsubscribeHeaderState(h)).toBe("mailto_only");
  });
});

describe("oneClickUnsubscribeUri — GUARD 2: https without List-Unsubscribe-Post is not one-click", () => {
  it("offers nothing when the one-click header is absent", () => {
    const h = headers({ "list-unsubscribe": ["<https://sender.example/u?t=abc>"] });
    expect(oneClickUnsubscribeUri(h)).toBeNull();
    // …and the state says WHY, so an interface can distinguish "no way out" from "not automatic".
    expect(unsubscribeHeaderState(h)).toBe("not_one_click");
  });

  it("offers nothing when the one-click header says something else", () => {
    const h = headers({
      "list-unsubscribe": ["<https://sender.example/u?t=abc>"],
      "list-unsubscribe-post": ["List-Unsubscribe=Confirm"],
    });
    expect(oneClickUnsubscribeUri(h)).toBeNull();
    expect(unsubscribeHeaderState(h)).toBe("not_one_click");
  });

  it("accepts the RFC 8058 value across a header FOLD, which arrives as embedded whitespace", () => {
    const h = headers({
      "list-unsubscribe": ["<https://sender.example/u?t=abc>"],
      "list-unsubscribe-post": ["List-Unsubscribe=One- Click"],
    });
    expect(oneClickUnsubscribeUri(h)).toBe("https://sender.example/u?t=abc");
  });

  it("is case-insensitive on the token, as a header value is", () => {
    const h = headers({
      "list-unsubscribe": ["<https://sender.example/u?t=abc>"],
      "list-unsubscribe-post": ["list-unsubscribe=one-click"],
    });
    expect(oneClickUnsubscribeUri(h)).toBe("https://sender.example/u?t=abc");
  });
});

describe("oneClickUnsubscribeUri — ambiguity and hostile shapes are refused, not resolved", () => {
  it("refuses TWO List-Unsubscribe lines: two hops disagree about where this list lives", () => {
    const h = headers({
      "list-unsubscribe": ["<https://real.example/u?t=1>", "<https://attacker.example/u?t=2>"],
      ...ONE_CLICK,
    });
    expect(oneClickUnsubscribeUri(h)).toBeNull();
  });

  it("refuses two List-Unsubscribe-Post lines", () => {
    const h = headers({
      "list-unsubscribe": ["<https://sender.example/u>"],
      "list-unsubscribe-post": ["List-Unsubscribe=One-Click", "List-Unsubscribe=One-Click"],
    });
    expect(oneClickUnsubscribeUri(h)).toBeNull();
  });

  it("refuses userinfo — the trick that makes a URL read as one host and connect to another", () => {
    const h = headers({
      "list-unsubscribe": ["<https://real.example@attacker.example/u>"],
      ...ONE_CLICK,
    });
    expect(oneClickUnsubscribeUri(h)).toBeNull();
  });

  it("refuses a URI over the character ceiling", () => {
    const long = `https://sender.example/u?t=${"a".repeat(MAX_UNSUBSCRIBE_URI_CHARS)}`;
    const h = headers({ "list-unsubscribe": [`<${long}>`], ...ONE_CLICK });
    expect(oneClickUnsubscribeUri(h)).toBeNull();
  });

  it("refuses a BARE url — RFC 2369 brackets it, and bare text is how a body-ish string sneaks in", () => {
    const h = headers({ "list-unsubscribe": ["https://sender.example/u?t=abc"], ...ONE_CLICK });
    expect(oneClickUnsubscribeUri(h)).toBeNull();
  });

  it("refuses an unterminated angle bracket rather than guessing where the URI ends", () => {
    const h = headers({ "list-unsubscribe": ["<https://sender.example/u?t=abc"], ...ONE_CLICK });
    expect(oneClickUnsubscribeUri(h)).toBeNull();
  });
});

describe("oneClickUnsubscribeUri — a round-tripped header map does not become a universal yes", () => {
  /**
   * `message_bodies.headers` comes back through `JSON.parse`, which inherits from
   * `Object.prototype` (residue) — and the unsubscribe service reads exactly that map. A
   * bare `headers["list-unsubscribe-post"]` is fine, but `headers["constructor"]` is a FUNCTION,
   * so a parser that indexed without `hasOwnProperty` would answer for header names it was never
   * given. These pin the accessor rather than the prototype.
   */
  it("a PLAIN object (the JSON.parse shape) with no unsubscribe headers offers nothing", () => {
    const roundTripped = JSON.parse(JSON.stringify({ subject: ["hi"] })) as Record<string, unknown>;
    expect(Object.getPrototypeOf(roundTripped)).toBe(Object.prototype);
    expect(oneClickUnsubscribeUri(roundTripped)).toBeNull();
    expect(unsubscribeHeaderState(roundTripped)).toBe("no_header");
  });

  it("an inherited property is not a header", () => {
    const h = Object.create({
      "list-unsubscribe": ["<https://attacker.example/u>"],
      "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
    }) as Record<string, unknown>;
    expect(oneClickUnsubscribeUri(h)).toBeNull();
    expect(unsubscribeHeaderState(h)).toBe("no_header");
  });

  it("a non-array header value is not a header", () => {
    const h = { "list-unsubscribe": "<https://sender.example/u>", ...ONE_CLICK } as unknown as Record<string, unknown>;
    expect(oneClickUnsubscribeUri(h)).toBeNull();
  });
});
