import { describe, expect, it } from "vitest";
import { ruleRowToDTO } from "../src/dto/materialize.js";

/**
 * A RULE CARRIES ITS PASS OVER PAST MAIL: when it was asked for and when it finished, `null` for
 * either not yet. The walk's cursor and its count stay off the wire — a count taken from the filed
 * folder is not what a person sees, and the cursor is the walk's own bookkeeping.
 */
const BASE = {
  id: "r-1", accountId: "acct", kind: "sender", match: "a@x.example", destination: "INBOX", priority: 0,
  provenance: "manual", enabled: true, subjectContains: null, bodyContains: null, hits: 0, lastHitAt: null,
  demotions: 0, createdAt: new Date("2026-09-25T10:00:00.000Z"), updatedAt: new Date("2026-09-25T10:00:00.000Z"),
  retroRequestedAt: null, retroDoneAt: null, retroCursor: null, retroMoved: 0,
} as unknown as Parameters<typeof ruleRowToDTO>[0];

describe("RuleDTO.retro", () => {
  it("asked and finished, as stored", () => {
    const dto = ruleRowToDTO({
      ...BASE, retroRequestedAt: new Date("2026-09-25T12:00:00.000Z"), retroDoneAt: new Date("2026-09-25T12:05:00.000Z"),
      retroCursor: "00000000-0000-4000-8000-000000000001", retroMoved: 41,
    });
    expect(dto.retro).toEqual({ requestedAt: "2026-09-25T12:00:00.000Z", doneAt: "2026-09-25T12:05:00.000Z" });
    expect(JSON.stringify(dto)).not.toMatch(/retroCursor|retroMoved|"41"/);
  });

  it("nobody asked is two nulls, never an absent field", () => {
    expect(ruleRowToDTO(BASE).retro).toEqual({ requestedAt: null, doneAt: null });
  });
});
