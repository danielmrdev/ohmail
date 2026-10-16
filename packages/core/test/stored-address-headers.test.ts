import { describe, it, expect } from "vitest";
import { normalizeMime, parseStoredAddressHeaders, NUL_REPLACEMENT } from "../src/mime.js";

/**
 * ── THE ROUND TRIP A BACKFILL DEPENDS ON ───────────────────────────────────────────────────
 *
 * `messages.from_name`, `to_addresses` and `cc_addresses` were each added after the rows that
 * need them, and the only surviving source for a historical row is `message_bodies.headers` —
 * the raw header values `normalizeMime` stored on the way past. A backfill is therefore exactly
 * this composition:
 *
 *      normalizeMime(raw).headers   →   parseStoredAddressHeaders(…)   →   the columns
 *
 * and it is only correct if that second parse lands on the SAME addresses the first one did.
 * Every case below asserts that equality rather than asserting a hand-written expectation,
 * because the claim under test is agreement with ingest, not agreement with my reading of
 * RFC 5322. Where a case also pins a literal, it is to prove the round trip is not vacuously
 * equal by both sides being empty.
 *
 * The `from` shapes differ by one deliberate step: `normalizeMime` yields the sentinel
 * `{ name: null, address: "" }` when there is no From address, `parseStoredAddressHeaders`
 * yields `null`, so the comparison folds one into the other and the "no From at all" case
 * asserts the sentinel explicitly.
 */

/** What `normalizeMime` returns, in the shape `parseStoredAddressHeaders` answers. */
async function bothWays(raw: string) {
  const norm = await normalizeMime(raw);
  const stored = await parseStoredAddressHeaders({
    from: norm.headers.from,
    to: norm.headers.to,
    cc: norm.headers.cc,
  });
  return {
    ingest: { from: norm.from, to: norm.to, cc: norm.cc },
    reparsed: {
      from: stored.from ?? { name: null, address: "" },
      to: stored.to,
      cc: stored.cc,
    },
  };
}

function eml(headers: string[], body = "hello"): string {
  return [...headers, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
}

describe("re-parsing the stored address headers agrees with ingest", () => {
  it("a plain display-name pair", async () => {
    const r = await bothWays(eml([
      "From: Papierwerk Studio <hello@Papierwerk.example>",
      "To: mila@lichtgrat.example",
    ]));
    expect(r.reparsed).toEqual(r.ingest);
    // Not vacuous: the name is the value the whole backfill exists to recover, and the address
    // is lowercased by the shared `toAddr`.
    expect(r.reparsed.from).toEqual({ name: "Papierwerk Studio", address: "hello@papierwerk.example" });
  });

  it("an RFC 2047 encoded-word name — the case a string split cannot do", async () => {
    // Some of the pre-0057 production rows carry one of these.
    const r = await bothWays(eml([
      "From: =?UTF-8?Q?J\x3dC3\x3dBCrgen_M\x3dC3\x3dBCller?= <juergen@example.test>",
      "To: mila@lichtgrat.example",
    ]));
    expect(r.reparsed).toEqual(r.ingest);
    expect(r.reparsed.from!.name).toBe("Jürgen Müller");
  });

  it("a quoted name containing a comma and an at-sign", async () => {
    const r = await bothWays(eml([
      `From: "Example, Inc. (billing@old)" <billing@example.test>`,
      "To: mila@lichtgrat.example",
    ]));
    expect(r.reparsed).toEqual(r.ingest);
    expect(r.reparsed.from).toEqual({ name: "Example, Inc. (billing@old)", address: "billing@example.test" });
  });

  it("a FOLDED From line — the reason values are re-folded, not written back flat", async () => {
    const r = await bothWays(eml([
      "From: A Very Long Sender Name That Wrapped",
      "\t<wrapped@example.test>",
      "To: mila@lichtgrat.example",
    ]));
    expect(r.reparsed).toEqual(r.ingest);
    expect(r.reparsed.from!.address).toBe("wrapped@example.test");
  });

  it("several recipients across two To lines, and a Cc", async () => {
    const r = await bothWays(eml([
      "From: sender@example.test",
      "To: One <one@example.test>, two@example.test",
      "To: Three <three@example.test>",
      "Cc: Four <four@example.test>",
    ]));
    expect(r.reparsed).toEqual(r.ingest);
    expect(r.reparsed.to.map((a) => a.address)).toEqual([
      "one@example.test", "two@example.test", "three@example.test",
    ]);
    expect(r.reparsed.cc).toEqual([{ name: "Four", address: "four@example.test" }]);
  });

  it("a bare address with no display name stays nameless", async () => {
    const r = await bothWays(eml(["From: bare@example.test", "To: mila@lichtgrat.example"]));
    expect(r.reparsed).toEqual(r.ingest);
    // Many pre-0057 production rows look like this. They are not backfillable and must not be
    // made to look as though they were — an address is not a name.
    expect(r.reparsed.from).toEqual({ name: null, address: "bare@example.test" });
  });

  it("an RFC 5322 group recipient", async () => {
    const r = await bothWays(eml([
      "From: sender@example.test",
      "To: Team:one@example.test,two@example.test;",
    ]));
    expect(r.reparsed).toEqual(r.ingest);
  });

  it("no From header at all", async () => {
    const r = await bothWays(eml(["To: mila@lichtgrat.example"]));
    expect(r.reparsed).toEqual(r.ingest);
    expect(r.ingest.from).toEqual({ name: null, address: "" });
  });

  it("an empty From value", async () => {
    const r = await bothWays(eml(["From: ", "To: mila@lichtgrat.example"]));
    expect(r.reparsed).toEqual(r.ingest);
  });

  it("nothing at all — no address header in the bag", async () => {
    await expect(parseStoredAddressHeaders({})).resolves.toEqual({ from: null, to: [], cc: [] });
    await expect(parseStoredAddressHeaders({ from: null, to: undefined, cc: [] }))
      .resolves.toEqual({ from: null, to: [], cc: [] });
  });

  /**
   * Postgres refuses U+0000 in `text`, so a name carrying one would fail the UPDATE a backfill
   * exists to perform — for the whole page, not the row.
   *
   * The assertion is the PROPERTY (no NUL survives), not the mechanism, because the mechanism
   * turned out not to be the one this test was first written to claim: it asserted
   * `Ev<NUL_REPLACEMENT>il` and went red with `Evil`. mailparser strips the NUL out of the
   * display name before `toAddr` is ever called, so `scrubNul` — the layer `normalizeMime`
   * relies on — never fires here and `NUL_REPLACEMENT` never appears. Both layers are wanted
   * and neither is asserted to be the one that acted, because which of them does is
   * mailparser's business and could change under us; that a NUL cannot reach the column is ours.
   *
   * The NUL is BUILT, never a raw byte in this file: one raw NUL makes `file` call the whole
   * source binary, after which `grep` skips it silently and reports nothing found.
   */
  it("a name carrying a NUL cannot reach the column", async () => {
    const nul = String.fromCharCode(0);
    const r = await parseStoredAddressHeaders({ from: [`"Ev${nul}il" <nul@example.test>`] });
    expect(r.from!.name).not.toContain(nul);
    expect(r.from!.name).toMatch(/^Ev(.?)il$/);
    // Whichever layer acted, the result is still a name and not an empty string — a scrub that
    // ate the value would be a silent data loss the property above cannot see.
    expect([`Evil`, `Ev${NUL_REPLACEMENT}il`]).toContain(r.from!.name);
  });

  /**
   * A stored value carrying a BARE newline cannot open a second header in the block we build.
   * Written back verbatim this would inject `From: attacker@evil.test` into our own re-parse,
   * and the row would be backfilled with a name its sender never wrote. The re-fold turns the
   * injected line into a continuation, so the whole thing stays one From value — and mailparser
   * reads that mess as a single (unparseable-as-an-address) field rather than the attacker's.
   */
  it("a bare newline in a stored value cannot inject a second From header", async () => {
    const injected = await parseStoredAddressHeaders({
      from: ["Innocent <innocent@example.test>\nFrom: Attacker <attacker@evil.test>"],
    });
    expect(injected.from?.address).not.toBe("attacker@evil.test");
  });

  it("a non-string in the jsonb array is ignored rather than thrown on", async () => {
    // `message_bodies.headers` is jsonb through `JSON.parse`; nothing at the type level stops a
    // row holding `{"from": [123]}`, and a backfill must not die on one.
    const r = await parseStoredAddressHeaders({
      from: [42 as unknown as string, "Real <real@example.test>"],
    });
    expect(r.from).toEqual({ name: "Real", address: "real@example.test" });
  });
});
