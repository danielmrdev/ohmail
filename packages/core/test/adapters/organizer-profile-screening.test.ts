import { describe, expect, it } from "vitest";
import {
  formatProfileMessage,
  isMalformedProfile,
  makeProfileDoc,
  parseProfileMessage,
  profileFingerprint,
  readProfileScreening,
  type OrganizerProfilePayload,
  type ParsedProfileMessage,
  type ProfileScreening,
} from "../../src/adapters/organizer-profile.js";

/**
 * THE ORGANIZER'S WINDOW TRAVELS IN THE ENVELOPE (RULING-026): one optional `screening` key beside
 * `producer`, never in the payload, so it moves no fingerprint and no import question. The parser
 * reads it well-formed only; a present-but-unreadable key is named and dropped.
 */

const PAYLOAD: OrganizerProfilePayload = {
  screener: [{ address: "anna@example.org", name: "Anna" }],
  rules: [{ kind: "sender", match: "news@example.org", destination: "ohmail/News", priority: 0, enabled: true, provenance: "manual" }],
  notifyRules: [],
  awayResponder: null,
  tagNames: ["kiln"],
  signature: null,
};
const WINDOW: ProfileScreening = { baselineAt: "2026-07-01T00:00:00.000Z", dormancyDays: 30, scope: "window" };
const META = { updatedAt: new Date("2026-10-12T08:00:00Z"), producer: { kind: "local", version: "test" } };

function parsed(raw: string): ParsedProfileMessage {
  const r = parseProfileMessage(raw);
  if (r === null || isMalformedProfile(r)) throw new Error("expected a readable document");
  return r;
}

/** A written document with its `screening` key replaced by `value` (or removed for `undefined`). */
function withScreening(value: unknown, v = 2): string {
  const doc = makeProfileDoc(PAYLOAD, { ...META, screening: WINDOW }, v) as unknown as Record<string, unknown>;
  if (value === undefined) delete doc.screening; else doc.screening = value;
  return formatProfileMessage(doc as never, { installId: "inst-1" });
}

describe("the screening window in the profile envelope", () => {
  it("round-trips a well-formed window, and the copy reads as written", () => {
    const r = parsed(formatProfileMessage(makeProfileDoc(PAYLOAD, { ...META, screening: WINDOW }), { installId: "inst-1" }));
    expect(r.doc!.screening).toEqual(WINDOW);
    expect(r.screeningRefused).toBeUndefined();
    expect(r.encoded).toBe(true);
  });

  it("a sliding window (baseline null) and all_time are real answers", () => {
    const sliding = { baselineAt: null, dormancyDays: 60, scope: "all_time" };
    expect(parsed(withScreening(sliding)).doc!.screening).toEqual(sliding);
  });

  it("absent is UNSTATED: no key on the document and nothing refused", () => {
    const r = parsed(withScreening(undefined));
    expect("screening" in r.doc!).toBe(false);
    expect(r.screeningRefused).toBeUndefined();
  });

  it.each([
    ["not an object", "30"],
    ["a scope outside the two", { baselineAt: null, dormancyDays: 30, scope: "forever" }],
    ["a non-integer window", { baselineAt: null, dormancyDays: 30.5, scope: "window" }],
    ["a window over the bound", { baselineAt: null, dormancyDays: 366, scope: "window" }],
    ["a null window (the reader must not default it)", { baselineAt: null, dormancyDays: null, scope: "window" }],
    ["a baseline not in the written form", { baselineAt: "2026-07-01", dormancyDays: 30, scope: "window" }],
  ])("malformed (%s): the document stands, the window is dropped and named", (_label, value) => {
    const r = parsed(withScreening(value));
    expect("screening" in r.doc!).toBe(false);
    expect(typeof r.screeningRefused).toBe("string");
    // The rest of the document is untouched by the refusal.
    expect(profileFingerprint(r.doc!)).toBe(profileFingerprint({ ...PAYLOAD, v: 2 }));
  });

  it("a v1 document carrying the key is read the same way", () => {
    const r = parsed(withScreening(WINDOW, 1));
    expect(r.v).toBe(1);
    expect(r.doc!.screening).toEqual(WINDOW);
  });

  it("the window is outside the fingerprint, at v1 and v2", () => {
    for (const v of [1, 2]) {
      const bare = makeProfileDoc(PAYLOAD, META, v);
      const carrying = makeProfileDoc(PAYLOAD, { ...META, screening: WINDOW }, v);
      expect(profileFingerprint(carrying)).toBe(profileFingerprint(bare));
      expect(profileFingerprint(parsed(formatProfileMessage(carrying, { installId: "i" })).doc!))
        .toBe(profileFingerprint(bare));
    }
  });

  it("the payload of an unchanged configuration keeps the bytes it had before the key existed", () => {
    const bare = makeProfileDoc(PAYLOAD, META);
    const carrying = makeProfileDoc(PAYLOAD, { ...META, screening: WINDOW });
    const { screening: _s, ...rest } = carrying;
    expect(rest).toEqual(bare);
  });

  it("writes the window's instant and scope plain, the days as a number", () => {
    const raw = formatProfileMessage(makeProfileDoc(PAYLOAD, { ...META, screening: WINDOW }), { installId: "i" });
    expect(raw).toContain('"baselineAt": "2026-07-01T00:00:00.000Z"');
    expect(raw).toContain('"dormancyDays": 30');
    expect(raw).toContain('"scope": "window"');
  });

  it("readProfileScreening answers undefined, a window, or a refusal", () => {
    expect(readProfileScreening(undefined)).toBeUndefined();
    expect(readProfileScreening(WINDOW)).toEqual(WINDOW);
    expect(readProfileScreening(null)).toHaveProperty("refused");
  });
});
