import { describe, it, expect } from "vitest";
import {
  confirmSeed, decodeEncodedWords, parseAddressList, repairLatin1Mojibake, SEED_MAX_ADDRESSES,
} from "../src/consent-seed.js";
import { ServiceError } from "../src/errors.js";

/**
 * DISPLAY NAMES IN THE SEED REVIEW — decoded, not dropped, and not mojibake.
 *
 * The seed review's one job is to help someone recognise who they wrote to, so the name on each
 * row has to be the person's name. Two corruptions were making it something else, both measured
 * against a live mailbox and the deployed test account:
 *
 *   1. An accented display name is transmitted as an RFC 2047 encoded-word — ASCII on the wire.
 *      The old code returned `null` for anything starting with `=?`, so dozens of a live mailbox's
 *      correspondents (every name with an accent) showed
 *      as bare addresses. This is the shippable half.
 *   2. Stale seed mail carried raw 8-bit UTF-8 in a header and was folded through Latin-1, so
 *      `ø` came to rest as `Ã¸`, so a name carrying an ø rendered as "SÃ¸rensen".
 *
 * The dangerous mistake in fixing #2 is corrupting names that were never broken, so the
 * round-trip guard has its own test below.
 */

const nameOf = (line: string): string | null => parseAddressList(line)[0]?.name ?? null;

describe("seed review display names", () => {
  it("decodes an RFC 2047 Q-word: underscores read as spaces, an escaped ö kept", () => {
    // Exactly as stored on a live account's own-authored mail. `_` is a space, and the two escaped bytes spell ö.
    expect(nameOf("=?utf-8?Q?lena_m\x3dC3\x3dB6ller?= <lena-moeller@example.com>")).toBe("lena möller");
  });

  it("decodes an RFC 2047 B-word carrying a letter outside ASCII", () => {
    expect(nameOf("=?UTF-8?B?UGV0cmEgU8O4cmVuc2Vu?= <petra@example.invalid>"))
      .toBe("Petra Sørensen");
  });

  it("repairs a name stored as Latin-1-folded UTF-8 — the live mojibake", () => {
    // The exact bytes the live seed review rendered: `SÃ¸` is `ø` mis-decoded as Latin-1.
    expect(nameOf("Petra SÃ¸rensen <petra@example.invalid>")).toBe("Petra Sørensen");
  });

  it("strips the quotes an encoded-word can carry inside itself (=22)", () => {
    // `=22` is a double-quote; the phrase decodes to `"Giulia Ferrà"`, then the quotes come off.
    expect(nameOf("=?utf-8?Q?=22Giulia_Ferr\x3dC3\x3dA0=22?= <e@example.invalid>"))
      .toBe("Giulia Ferrà");
  });

  it("folds two adjacent encoded-words without inserting the whitespace between them (§6.2)", () => {
    // `Sø` split across two B-words: the space between is a fold, not part of the name.
    const a = Buffer.from("Petra ", "utf8").toString("base64");
    const b = Buffer.from("Sørensen", "utf8").toString("base64");
    expect(decodeEncodedWords(`=?utf-8?B?${a}?= =?utf-8?B?${b}?=`)).toBe("Petra Sørensen");
  });

  it("leaves a plain ASCII name exactly as it is", () => {
    expect(nameOf("Mila Brandt <mila@northwind-studio.invalid>")).toBe("Mila Brandt");
  });

  it("leaves a `=?` that is not a well-formed encoded-word untouched", () => {
    // The predecessor gave up on the prefix alone; a real name can start with it.
    expect(decodeEncodedWords("=? not an encoded word")).toBe("=? not an encoded word");
  });

  describe("the mojibake repair touches ONLY genuine mojibake", () => {
    it("does not corrupt a correctly-decoded Latin-1-range name", () => {
      // `é` (U+00E9) read as a Latin-1 byte is `0xE9`, not a legal UTF-8 lead on its own — so
      // the re-decode would manufacture a replacement char and the round-trip guard rejects it.
      // Without that guard this returns garbage; with it, the name survives.
      expect(repairLatin1Mojibake("Rémy")).toBe("Rémy");
      // The full decoded name, end to end, must survive its own repair pass.
      expect(nameOf("=?utf-8?Q?R\x3dC3\x3dA9my_Odermatt?= <remy@example.com>"))
        .toBe("Rémy Odermatt");
    });

    it("leaves an already-correct ø/ö/ü name alone", () => {
      expect(repairLatin1Mojibake("Sørensen")).toBe("Sørensen");
      expect(repairLatin1Mojibake("möller")).toBe("möller");
      expect(repairLatin1Mojibake("Zürcher")).toBe("Zürcher");
    });

    it("leaves pure ASCII alone", () => {
      expect(repairLatin1Mojibake("Mila Brandt")).toBe("Mila Brandt");
    });
  });
});

/**
 * the seed confirmation's list, bounded IN THE SERVICE.
 *
 * `routes/consent.ts` also refuses an over-long list, one statement earlier and for a cheaper
 * reason (before its own per-entry validation loop). This case exists because that route copy is
 * not the guarantee: `SearchService`'s date guard states the rule this follows — *"the route is
 * not the only door… a check living in the route would guard the hosted door and not the desktop
 * one"* — and a bound whose only enforcement is a route is one refactor away from being absent.
 *
 * Watched fail and restored: delete the `addresses.length > SEED_MAX_ADDRESSES` block in
 * `confirmSeed` and this goes green-on-the-wrong-thing — the call proceeds to `buildSeedReview`
 * and the oversized list is folded, lowercased and de-duplicated before anything bounds it.
 */
describe("confirmSeed refuses an unbounded address list before it folds it", () => {
  it("throws a 413 naming the limit, before it touches the database", async () => {
    // `db` is deliberately a handle that would THROW if it were used: the refusal must happen
    // before `buildSeedReview` runs, so nothing about this call needs a database at all.
    const exploded: string[] = [];
    const ctx = {
      db: new Proxy({}, { get: (_t, k) => { exploded.push(String(k)); throw new Error("db touched"); } }),
      accountId: "acc", userId: null, now: () => new Date(), requestId: "r",
    } as unknown as Parameters<typeof confirmSeed>[0];

    const list = Array.from({ length: SEED_MAX_ADDRESSES + 1 }, (_, i) => `p${i}@example.com`);
    const err = await confirmSeed(ctx, list).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).httpStatus).toBe(413);
    expect((err as ServiceError).code).toBe("payload_too_large");
    expect((err as ServiceError).message).toContain(String(SEED_MAX_ADDRESSES));
    expect(exploded, "the refusal must cost no query at all").toEqual([]);
  });
});
