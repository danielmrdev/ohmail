import { describe, it, expect } from "vitest";
import {
  MAIL_SCHEMA_MARKERS,
  SCHEMA_INDEX_MARKERS,
  SCHEMA_CHECK_MARKERS,
  MAIL_CHECK_DEFINITION_MARKERS,
  MAIL_COLUMN_TYPE_MARKERS,
} from "../src/routes/health-markers.js";
import {
  parseMailJournalObjects,
  COLUMN_FACET_ALLOWLIST,
  DELIBERATE_DOUBLE_PROBES,
  deriveMailColumnMarkerCount,
} from "./mail-marker-derivation.js";

/**
 * THE MARKERS ARE DERIVED FROM THE JOURNAL, NOT FROM THE LIST UNDER TEST.
 *
 * `health.test.ts` proved every marker RESOLVES against a fully-migrated PGlite database and that
 * the newest one is the tag's own. What it could not prove is that no OLDER marker went missing:
 * its `expected` was `MAIL_SCHEMA_MARKERS.length + …`, so deleting a marker lowered `expected` and
 * `markersFound` in step and the assertion stayed green (measured: dropping the 0108 marker with
 * the tag at 0108 passed). A silently missing column then reads healthy — the inverted
 * `schema_incomplete` incident. These cases read the mail migrations instead: every facet a
 * migration creates must be probed (a), no marker may name a phantom (b), and the count the probe
 * pins to is journal-derived (deriveMailColumnMarkerCount), so a dropped marker turns it red.
 */
describe("mail /health markers, derived from the mail journal", () => {
  const objects = parseMailJournalObjects();

  /** `MAIL_SCHEMA_MARKERS` grouped into the `(creating-migration, table)` facets they probe. */
  const markedFacets = new Set<string>();
  for (const [table, column] of MAIL_SCHEMA_MARKERS) {
    const tag = objects.colToTag.get(`${table}.${column}`);
    if (tag) markedFacets.add(`${tag}|${table}`);
  }

  it("(a) every column-facet a migration creates is probed, or grandfathered with a reason", () => {
    // A facet = one migration's columns on one table. The design probes ONE per migration table
    // facet, so the check is per facet and the pre-existing gaps are the grandfather list. A NEW
    // migration that adds columns and no marker lands here, naming the table and the columns.
    const uncovered: string[] = [];
    for (const [key, facet] of objects.colFacets) {
      if (markedFacets.has(key)) continue;
      if (Object.prototype.hasOwnProperty.call(COLUMN_FACET_ALLOWLIST, key)) continue;
      uncovered.push(`${facet.tag} adds ${facet.table}.{${facet.cols.join(",")}} — no MAIL_SCHEMA_MARKERS entry probes it`);
    }
    expect(
      uncovered,
      "a migration adds columns that no marker certifies and that the grandfather list does not " +
        "excuse — add a MAIL_SCHEMA_MARKERS entry on the column a request path reads, or list the " +
        "facet in COLUMN_FACET_ALLOWLIST with the reason it is deliberately unprobed",
    ).toEqual([]);
  });

  it("(b) no phantom markers — every marker names an object some mail migration creates", () => {
    // The reverse direction, and the one that catches a marker whose object never existed or was
    // dropped by a later migration. Column markers are checked as the exact `table.column`, never
    // "does the table exist", so a marker on a real table's non-existent column is caught.
    const phantoms: string[] = [];
    for (const [table, column] of MAIL_SCHEMA_MARKERS)
      if (!objects.columns.has(`${table}.${column}`))
        phantoms.push(`MAIL_SCHEMA_MARKERS ${table}.${column} — no mail migration creates this column`);
    for (const [name] of SCHEMA_INDEX_MARKERS)
      if (!objects.indexes.has(name))
        phantoms.push(`SCHEMA_INDEX_MARKERS ${name} — no mail migration creates this index`);
    for (const name of SCHEMA_CHECK_MARKERS)
      if (!objects.checks.has(name))
        phantoms.push(`SCHEMA_CHECK_MARKERS ${name} — no mail migration creates this constraint`);
    for (const [name] of MAIL_CHECK_DEFINITION_MARKERS)
      if (!objects.checks.has(name))
        phantoms.push(`MAIL_CHECK_DEFINITION_MARKERS ${name} — no mail migration creates this constraint`);
    for (const [table, column] of MAIL_COLUMN_TYPE_MARKERS)
      if (!objects.columns.has(`${table}.${column}`))
        phantoms.push(`MAIL_COLUMN_TYPE_MARKERS ${table}.${column} — no mail migration creates this column`);
    expect(phantoms, "a marker names an object no migration creates — it probes nothing").toEqual([]);
  });

  it("the grandfather list stays honest — real, currently-uncovered facets only", () => {
    // A covered facet parked in the allow-list would silence a future drop of its marker; a key
    // the journal no longer creates is dead weight. Both are refused so the list cannot rot into
    // cover.
    for (const key of Object.keys(COLUMN_FACET_ALLOWLIST)) {
      expect(objects.colFacets.has(key), `COLUMN_FACET_ALLOWLIST names ${key}, which no migration creates`).toBe(true);
      expect(
        markedFacets.has(key),
        `COLUMN_FACET_ALLOWLIST parks ${key}, which IS probed — a covered facet in the allow-list hides a future drop`,
      ).toBe(false);
    }
    // The double-probe list names real facets carrying exactly two markers.
    for (const key of Object.keys(DELIBERATE_DOUBLE_PROBES)) {
      const count = MAIL_SCHEMA_MARKERS.filter(
        ([table, column]) => `${objects.colToTag.get(`${table}.${column}`)}|${table}` === key,
      ).length;
      expect(count, `DELIBERATE_DOUBLE_PROBES names ${key}, which carries ${count} marker(s), not 2`).toBe(2);
    }
  });

  it("the journal-derived count equals the list today — the anchor the probe assertion uses", () => {
    // `deriveMailColumnMarkerCount()` reads only the journal and the two allow-lists, so it does
    // not move when a marker is deleted. On a pristine tree it must equal the list; the probe
    // assertion in `health.test.ts` drives the same number against a real database. Delete an
    // older marker and this equality — and that assertion — go red while the old length-based one
    // would not have.
    expect(deriveMailColumnMarkerCount(objects)).toBe(MAIL_SCHEMA_MARKERS.length);
  });
});
