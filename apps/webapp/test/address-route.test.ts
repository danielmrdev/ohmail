import { describe, expect, it } from "vitest";
import { addressHash, canonicalHash, normalizedHash, parseHash } from "../app/shell/routing";
import { addressHref } from "../app/shell/address-view";

/**
 * ═══ `#/address/<addr>` — THE ONE ROUTE WHOSE PARAMETER A STRANGER CHOSE ══════════════════
 *
 * A tag id and a folder id are opaque strings this product minted, so the router carries them
 * raw. An address is a string somebody else put in a `From:` header, and three characters in it
 * break a raw hash segment:
 *
 *   `/`  the router splits the path on it to find the `m/<id>` open-message tail, so a slash in
 *        a quoted local part becomes a path boundary and the view opens on half an address;
 *   `#`  the browser truncates the fragment there, so the address never reaches `parseHash`;
 *   `%`  a real `%` and an escape sequence are the same bytes, so encoding on one side only
 *        round-trips wrongly.
 *
 * The property that makes all three safe is the ROUND TRIP:
 * `canonicalHash(parseHash(h)) === h`. It is not a nicety — `normalizedHash` rewrites the
 * address bar whenever the canonical form differs from what is in it, and it does so on every
 * render. A route that fails to round-trip does not 404; it rewrites a correct URL, in place,
 * to a shorter one, and the shortening truncates the address it was correcting. That is why the
 * cases below are written as round trips rather than as "does it parse".
 */

/** `parseHash` after `canonicalHash` must be the identity on the address it started from. */
function roundTrip(address: string): string | null {
  const href = addressHref(address);
  const route = parseHash(href);
  // The bar must NOT be rewritten for a hash the product itself produced.
  expect(normalizedHash(href)).toBeNull();
  expect(route.view).toBe("address");
  expect(canonicalHash(route)).toBe(href);
  return route.address;
}

describe("#/address/<addr> — parse, canonicalize, round-trip", () => {
  it("parses an ordinary address and carries it decoded", () => {
    const route = parseHash("#/address/anna%40acme.test");
    expect(route.view).toBe("address");
    expect(route.address).toBe("anna@acme.test");
    // The parameterized siblings stay null — the fields are not shared.
    expect(route.tagId).toBeNull();
    expect(route.folderId).toBeNull();
    expect(route.messageId).toBeNull();
  });

  it("round-trips every address shape a header can legally carry", () => {
    for (const address of [
      "anna@acme.test",
      "Anna@ACME.test",                      // case is PRESERVED — matching folds it, the URL does not
      "anna+newsletter@acme.test",           // `+`, which `encodeURIComponent` leaves and a query parser would eat
      "anna.b.c@sub.domain.acme.test",
      'a/b@acme.test',                       // a slash — the tail-splitter's own delimiter
      'a#b@acme.test',                       // a hash — the fragment's own delimiter
      "a%b@acme.test",                       // a literal percent
      "a b@acme.test",                       // a space
      "a?b@acme.test",                       // a question mark: the first-run branch reads a query
      "a&b=c@acme.test",
      "üñí@äcme.test",                       // non-ASCII, which is why this is encodeURIComponent and not escape()
      "a'b@acme.test",
    ]) {
      expect(roundTrip(address)).toBe(address);
    }
  });

  it("`addressHref` and `goAddress`'s spelling and `canonicalHash` are ONE encoder", () => {
    // Three callers of `addressHash`. If any of them grew its own `encodeURIComponent` call, the
    // three would agree for plain addresses and diverge for exactly the ones above — and the
    // divergence shows up as the address bar being rewritten under a correct link, not as an
    // error. So the identity is asserted on the shapes most likely to expose it.
    for (const address of ["anna@acme.test", "a/b@acme.test", "a%b@acme.test", "a b@acme.test"]) {
      const hash = addressHash(address);
      expect(addressHref(address)).toBe(hash);
      expect(canonicalHash(parseHash(hash))).toBe(hash);
    }
  });

  it("carries an open message — `#/address/<addr>/m/<id>`", () => {
    // The address view is a MESSAGE VIEW: opening a row from it must survive a reload and a
    // copied link, exactly as opening one from a tag does. The tail is split BEFORE the address
    // branch is chosen, so this also proves the address is not swallowing the tail.
    const route = parseHash("#/address/anna%40acme.test/m/msg-1");
    expect(route.view).toBe("address");
    expect(route.address).toBe("anna@acme.test");
    expect(route.messageId).toBe("msg-1");
    expect(canonicalHash(route)).toBe("#/address/anna%40acme.test/m/msg-1");
    expect(normalizedHash("#/address/anna%40acme.test/m/msg-1")).toBeNull();
  });

  it("an address CONTAINING `/m/` keeps its tail-split honest", () => {
    // The tail is two segments at the END, always `m` then an id. An encoded address can never
    // produce them (its `/` is `%2F`), and this is the case that proves the encoding is what
    // stops it: the same address spelled RAW would be cut in half.
    const address = "a/m/b@acme.test";
    expect(roundTrip(address)).toBe(address);
    expect(parseHash(addressHref(address)).messageId).toBeNull();
    // Spelled raw, the router reads `m/b@acme.test` as the open-message tail and the address as
    // `a` — which is the defect the encoding exists to prevent, asserted so the encoding cannot
    // be quietly dropped as unnecessary.
    const raw = parseHash("#/address/a/m/b@acme.test");
    expect(raw.address).toBe("a");
    expect(raw.messageId).toBe("b@acme.test");
  });

  it("a MALFORMED escape opens the view instead of throwing", () => {
    // `decodeURIComponent` raises `URIError` on a lone `%`, and `parseHash` runs on every
    // render: a throw here would blank the whole shell for a hand-edited URL or a link a mail
    // client half-escaped. The raw segment is the address in that case — it matches no mail, so
    // the view's empty state names it, which is a legible answer to a broken link.
    for (const bad of ["#/address/%", "#/address/%zz", "#/address/a%2"]) {
      const route = parseHash(bad);
      expect(route.view).toBe("address");
      expect(typeof route.address).toBe("string");
      expect(route.address).not.toBe("");
    }
  });

  it("a bare `#/address` with no address falls back rather than opening an empty view", () => {
    // The tag and folder branches both require a non-empty segment, and this follows them: an
    // address view whose header names nobody is a screen with no subject. `normalizedHash` then
    // rewrites the bar to the fallback it actually rendered.
    for (const bare of ["#/address", "#/address/"]) {
      const route = parseHash(bare);
      expect(route.view).toBe("ohbox");
      expect(route.address).toBeNull();
      expect(normalizedHash(bare)).toBe("#/ohbox");
    }
  });

  it("does not disturb the sibling parameterized routes", () => {
    // `address` was added to `ViewId`, to `MESSAGE_VIEWS` and to every `Route` literal. A
    // regression in any of those shows up as one of these losing its own parameter.
    const tag = parseHash("#/tag/pottery/m/x");
    expect([tag.view, tag.tagId, tag.messageId, tag.address]).toEqual(["tag", "pottery", "x", null]);
    const folder = parseHash("#/folder/f-1/m/x");
    expect([folder.view, folder.folderId, folder.messageId, folder.address])
      .toEqual(["folder", "f-1", "x", null]);
    const settings = parseHash("#/settings/devices");
    expect([settings.view, settings.settingsPane, settings.address])
      .toEqual(["settings", "devices", null]);
    const ohbox = parseHash("#/ohbox");
    expect(ohbox.address).toBeNull();
  });
});
