/**
 * The diagnostic file counts the mirror's rows under a closed list of types, and that list is a
 * copy: core cannot import this package. A type the mirror learns without the list learning it
 * would be counted as `otherTypes` and the file would stop naming what grew.
 */
import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_ENTITY_TYPES } from "@trafficflow/core/diagnostics";
import { MIRROR_ENTITY_TYPES, buildDiagnosticBundle } from "../src/index.js";

describe("the diagnostic file's entity types are the mirror's", () => {
  it("member for member, in order", () => {
    expect([...DIAGNOSTIC_ENTITY_TYPES]).toEqual([...MIRROR_ENTITY_TYPES]);
  });

  it("the phone's re-export is the one builder, and it counts by those types", () => {
    const b = buildDiagnosticBundle({
      surface: "phone", now: new Date(0), build: {}, platform: {},
      install: { id: "0123456789abcdef0123456789abcdef", mintedAt: new Date(0).toISOString() },
      store: { counts: { message: 2, outbox_entry: 1, not_a_type: 5 }, window: { mode: "full" } },
    });
    const store = b.sections.find((s) => s.k === "store");
    expect(store?.k === "store" && [store.counts.message, store.counts.outbox_entry, store.otherTypes]).toEqual([2, 1, 5]);
  });
});
