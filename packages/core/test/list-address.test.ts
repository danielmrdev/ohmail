import { describe, expect, it } from "vitest";
import { ADDRESS_SHAPE, LIST_POST_ADDRESSES_MAX, listPostAddresses } from "../src/list-address.js";

/** The stored shape: lower-cased header names, raw values (`mime.ts`). */
const post = (...values: string[]) => ({ "list-post": values });

describe("listPostAddresses — the address a list posts as (RFC 2369 List-Post)", () => {
  it("reads the mailto URL, whatever the scheme's case, lower-cased", () => {
    expect(listPostAddresses(post("<mailto:Team@Lists.Example.org>"))).toEqual(["team@lists.example.org"]);
    expect(listPostAddresses(post("<MAILTO:team@lists.example.org>"))).toEqual(["team@lists.example.org"]);
    expect(listPostAddresses(post("<Mailto:team@lists.example.org>"))).toEqual(["team@lists.example.org"]);
  });

  it("cuts the query: a list that pre-fills a subject still names its address", () => {
    expect(listPostAddresses(post("<mailto:team@lists.example.org?subject=list%20posting>")))
      .toEqual(["team@lists.example.org"]);
    expect(listPostAddresses(post("<mailto:team@lists.example.org?>"))).toEqual(["team@lists.example.org"]);
    // No address before the query: the `?to=` form names nobody here.
    expect(listPostAddresses(post("<mailto:?to=team@lists.example.org>"))).toEqual([]);
  });

  it("percent-decodes the address and drops an escape that does not decode", () => {
    expect(listPostAddresses(post("<mailto:team%2Ddev@lists.example.org>"))).toEqual(["team-dev@lists.example.org"]);
    expect(listPostAddresses(post("<mailto:team%40lists.example.org>"))).toEqual(["team@lists.example.org"]);
    expect(listPostAddresses(post("<mailto:team%E0%A4%A@lists.example.org>"))).toEqual([]);
    // A decoded comma is no separator: the result is not address-shaped and is dropped.
    expect(listPostAddresses(post("<mailto:a%2Cb@lists.example.org>"))).toEqual([]);
  });

  it("reads NO as no posting address, and nothing else as NO", () => {
    expect(listPostAddresses(post("NO (posting not allowed on this list)"))).toEqual([]);
    expect(listPostAddresses(post("NO"))).toEqual([]);
    expect(listPostAddresses(post("no"))).toEqual([]);
    expect(listPostAddresses(post("<mailto:nobody@lists.example.org>"))).toEqual(["nobody@lists.example.org"]);
    expect(listPostAddresses(post("NO", "<mailto:team@lists.example.org>"))).toEqual(["team@lists.example.org"]);
  });

  it("keeps only address-shaped results, in the shape the Sent-copy teach admits", () => {
    expect(listPostAddresses(post("<mailto:not-an-address>"))).toEqual([]);
    expect(listPostAddresses(post("<mailto:\"quoted\"@lists.example.org>"))).toEqual([]);
    expect(listPostAddresses(post("<mailto:a@b@lists.example.org>"))).toEqual([]);
    expect(listPostAddresses(post("<https://groups.example.com/g/team/post>, <mailto:team@groups.example.com>")))
      .toEqual(["team@groups.example.com"]);
    expect(listPostAddresses(post("<https://groups.example.com/g/team/post>"))).toEqual([]);
    // Only a mailto URL names an address, even where another scheme carries an @.
    expect(listPostAddresses(post("<https://team@groups.example.com/post>"))).toEqual([]);
    for (const a of listPostAddresses(post("<mailto:x@y.example>, <mailto:Z@W.example>"))) {
      expect(ADDRESS_SHAPE.test(a)).toBe(true);
    }
  });

  it("reads at most five addresses from one message, across every List-Post line", () => {
    const seven = Array.from({ length: 7 }, (_, i) => `<mailto:list${i}@lists.example.org>`);
    expect(LIST_POST_ADDRESSES_MAX).toBe(5);
    expect(listPostAddresses(post(seven.join(", ")))).toEqual(
      ["list0", "list1", "list2", "list3", "list4"].map((l) => `${l}@lists.example.org`));
    expect(listPostAddresses(post(seven.slice(0, 3).join(","), seven.slice(3).join(",")))).toHaveLength(5);
  });

  it("ignores whitespace inside a URL (a folded line) and a comment outside the brackets", () => {
    expect(listPostAddresses(post("<mailto:team@\r\n lists.example.org>"))).toEqual(["team@lists.example.org"]);
    expect(listPostAddresses(post("<mailto:moderator@lists.example.org> (Postings are Moderated)")))
      .toEqual(["moderator@lists.example.org"]);
    expect(listPostAddresses(post("mailto:team@lists.example.org (Postings are Moderated)")))
      .toEqual(["team@lists.example.org"]);
  });

  it("names each address once, keeping the header's order", () => {
    const header = "<mailto:a@lists.example.org,b@lists.example.org>, <mailto:A@lists.example.org>";
    expect(listPostAddresses(post(header))).toEqual(["a@lists.example.org", "b@lists.example.org"]);
  });

  it("reads only an own string array: absent, inherited and malformed headers name nothing", () => {
    expect(listPostAddresses({})).toEqual([]);
    expect(listPostAddresses(JSON.parse("{\"subject\":[\"x\"]}") as Record<string, unknown>)).toEqual([]);
    expect(listPostAddresses({ "list-post": "<mailto:team@lists.example.org>" })).toEqual([]);
    expect(listPostAddresses({ "list-post": [42, "<mailto:team@lists.example.org>"] }))
      .toEqual(["team@lists.example.org"]);
    expect(listPostAddresses(post(""))).toEqual([]);
  });
});
