import { describe, expect, it } from "vitest";
import { MARK_SEEN_CHUNK, chunkMarkSeen, type EngineMutation } from "../src/index.js";

/**
 * A READ OVER A SET AND ITS UNDO SPLIT ALIKE at the route's 200-id cap (`PATCH /messages` answers
 * 413 above it). Mutation: return the list unsplit — the 201-id case reads one mutation and goes red.
 */
const ids = (n: number, p = "m") => Array.from({ length: n }, (_, i) => `${p}${i}`);

describe("chunkMarkSeen", () => {
  it("is the route's number", () => {
    expect(MARK_SEEN_CHUNK).toBe(200);
  });

  it("splits a 201-id mark_seen into 200 + 1, in order, keeping every field", () => {
    const out = chunkMarkSeen([{ kind: "mark_seen", messageIds: ids(201), unread: true }]);
    expect(out.map((m) => (m.kind === "mark_seen" ? m.messageIds.length : -1))).toEqual([200, 1]);
    expect(out.every((m) => m.kind === "mark_seen" && m.unread === true)).toBe(true);
    expect(out.flatMap((m) => (m.kind === "mark_seen" ? m.messageIds : []))).toEqual(ids(201));
  });

  it("keeps a glance label on every chunk", () => {
    const out = chunkMarkSeen([{ kind: "mark_seen", messageIds: ids(401), unread: false, via: "glance" }]);
    expect(out.length).toBe(3);
    expect(out.every((m) => m.kind === "mark_seen" && m.via === "glance")).toBe(true);
  });

  it("passes 200 ids and every other kind through unchanged, in order", () => {
    const tri: EngineMutation = { kind: "triage_set", messageId: "t1", state: "none" };
    const exact: EngineMutation = { kind: "mark_seen", messageIds: ids(200), unread: false };
    const out = chunkMarkSeen([tri, exact]);
    expect(out).toEqual([tri, exact]);
  });
});
