import { describe, expect, it } from "vitest";
import { canonical, placeholderDate, substitute, substitutionsFor, type Json, type WireKeys } from "./_wire-substitutions.js";

/**
 * THE RECORDED FAILING PAIR, REPLAYED. At the 0.20.0 freeze the wire corpus failed 1 run in 6:
 * date slots were assigned over the ONE sorted distinct set of every stamp in the corpus, so
 * `sortAt`'s instant COINCIDING with a neighbour on some runs and not on others changed the
 * distinct count and shifted every later slot — the failing run read `createdAt` at 00:04 where
 * the corpus said 00:05 and `organizeConsentedAt` at 00:05 where it said 00:06 (FREEZE-020,
 * 2026-09-18 22:05Z). The remedy is the per-field grid: a stamp under one key cannot move another
 * key's slots. This file replays that pair as two recordings of ONE journey — the substituted
 * corpus must be byte-equal whether or not the coincidence happened.
 */
const KEYS: WireKeys = {
  idKeys: new Set(["id"]),
  dateKeys: new Set(["createdAt", "organizeConsentedAt", "sortAt", "updatedAt"]),
  idArrayKeys: new Set<string>(),
  seqKeys: new Set<string>(),
  cursorKeys: new Set<string>(),
  opaqueKeys: new Set<string>(),
};

/** One journey's response, as a run records it: every stamp minted by that run's wall clock. */
function journey(stamps: { created: string; consented: string; sortAt: string; updated: string }): Json {
  return {
    items: [{
      createdAt: stamps.created,
      organizeConsentedAt: stamps.consented,
      sortAt: stamps.sortAt,
      updatedAt: stamps.updated,
    }],
  };
}

const normalized = (doc: Json): string => canonical(substitute(doc, substitutionsFor([doc], "o@x.test", KEYS), KEYS));

describe("the wire corpus's date slots", () => {
  it("replays the recorded pair: a stamp coinciding with another field's stamp moves nothing", () => {
    /* Run A — the corpus's recording: sortAt distinct from every neighbour. */
    const runA = journey({
      created: "2026-09-18T21:13:45.201Z",
      consented: "2026-09-18T21:13:45.309Z",
      sortAt: "2026-09-18T21:13:45.500Z",
      updated: "2026-09-18T21:13:46.001Z",
    });
    /* Run B — the failing run's shape: the SAME journey, sortAt coinciding with createdAt. */
    const runB = journey({
      created: "2026-09-18T22:01:02.700Z",
      consented: "2026-09-18T22:01:02.850Z",
      sortAt: "2026-09-18T22:01:02.700Z",
      updated: "2026-09-18T22:01:03.400Z",
    });
    expect(normalized(runB), "the coincidence moved a slot — the 0.20.0 freeze's 1-in-6 flake")
      .toBe(normalized(runA));
  });

  it("substitutes every stamp onto the grid — a raw wall clock in the output is a miss, not a slot", () => {
    const out = normalized(journey({
      created: "2026-09-18T21:13:45.201Z",
      consented: "2026-09-18T21:13:45.309Z",
      sortAt: "2026-09-18T21:13:45.201Z",
      updated: "2026-09-18T21:13:46.001Z",
    }));
    expect(out).not.toContain("2026-09-18");
    expect(out).toContain("2026-01-01");
  });

  it("keeps chronology within a field: ranks follow sorted order, in the field's own band", () => {
    const doc: Json = { items: [
      { createdAt: "2026-09-18T10:00:02.000Z" },
      { createdAt: "2026-09-18T10:00:01.000Z" },
    ] };
    const s = substitutionsFor([doc], "o@x.test", KEYS);
    expect(s.dates.get(JSON.stringify(["createdAt", "2026-09-18T10:00:01.000Z"]))).toBe(placeholderDate(0, 0));
    expect(s.dates.get(JSON.stringify(["createdAt", "2026-09-18T10:00:02.000Z"]))).toBe(placeholderDate(0, 1));
  });
});
