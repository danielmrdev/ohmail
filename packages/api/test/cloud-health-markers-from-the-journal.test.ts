import { describe, it, expect } from "vitest";
import {
  CLOUD_SCHEMA_MARKERS,
  CLOUD_INDEX_MARKERS,
  CLOUD_CHECK_DEFINITION_MARKERS,
} from "../src/routes/health-cloud.js";
import {
  parseCloudJournalObjects,
  CLOUD_COLUMN_FACET_ALLOWLIST,
  CLOUD_DELIBERATE_DOUBLE_PROBES,
  deriveCloudColumnMarkerCount,
} from "./cloud-marker-derivation.js";

/**
 * THE CLOUD MARKERS ARE DERIVED FROM THE CLOUD JOURNAL, NOT FROM THE LIST UNDER TEST.
 *
 * The sibling of `health-markers-from-the-journal.test.ts` for the hosted half. `/health` and the
 * admin overview computed the marker total from the LISTS, so deleting an OLDER cloud column marker
 * lowered the real `found` and the expected total in step and both endpoints kept answering
 * healthy — a database with a silently missing column, the inverted `schema_incomplete` incident,
 * for the tier that also carries `staff_users.password_hash` and the alert pager's tables. These
 * cases read the cloud migrations instead: every column facet a migration creates must be probed
 * (a), no marker may name a phantom object (b), the allow-list stays honest, and the count the
 * probe anchor pins to is journal-derived (`deriveCloudColumnMarkerCount`), so a dropped marker
 * turns it red.
 */
describe("cloud /health markers, derived from the cloud journal", () => {
  const objects = parseCloudJournalObjects();

  /** `CLOUD_SCHEMA_MARKERS` grouped into the `(creating-migration, table)` facets they probe. */
  const markedFacets = new Set<string>();
  for (const [table, column] of CLOUD_SCHEMA_MARKERS) {
    const tag = objects.colToTag.get(`${table}.${column}`);
    if (tag) markedFacets.add(`${tag}|${table}`);
  }

  it("(a) every column-facet a cloud migration creates is probed, or grandfathered with a reason", () => {
    // A facet = one migration's columns on one table. Every unprobed facet today is baseline-era
    // (certified by adoption); a NEW cloud migration that adds columns and no marker lands here,
    // naming the table and the columns.
    const uncovered: string[] = [];
    for (const [key, facet] of objects.colFacets) {
      if (markedFacets.has(key)) continue;
      if (Object.prototype.hasOwnProperty.call(CLOUD_COLUMN_FACET_ALLOWLIST, key)) continue;
      uncovered.push(`${facet.tag} adds ${facet.table}.{${facet.cols.join(",")}} — no CLOUD_SCHEMA_MARKERS entry probes it`);
    }
    expect(
      uncovered,
      "a cloud migration adds columns that no marker certifies and that the grandfather list does " +
        "not excuse — add a CLOUD_SCHEMA_MARKERS entry on the column a request path reads, or list " +
        "the facet in CLOUD_COLUMN_FACET_ALLOWLIST with the reason it is deliberately unprobed",
    ).toEqual([]);
  });

  it("(b) no phantom markers — every cloud marker names an object some cloud migration creates", () => {
    // The reverse direction, across the three classes a cloud host adds: column, index and CHECK
    // definition. Column markers are checked as the exact `table.column`, so a marker on a real
    // table's non-existent column is caught. CLOUD_CHECK_DEFINITION_MARKERS is empty today; the arm
    // is here for the next replaced constraint (a name-only probe cannot see a redefinition).
    const phantoms: string[] = [];
    for (const [table, column] of CLOUD_SCHEMA_MARKERS)
      if (!objects.columns.has(`${table}.${column}`))
        phantoms.push(`CLOUD_SCHEMA_MARKERS ${table}.${column} — no cloud migration creates this column`);
    for (const [name] of CLOUD_INDEX_MARKERS)
      if (!objects.indexes.has(name))
        phantoms.push(`CLOUD_INDEX_MARKERS ${name} — no cloud migration creates this index`);
    for (const [name] of CLOUD_CHECK_DEFINITION_MARKERS)
      if (!objects.checks.has(name))
        phantoms.push(`CLOUD_CHECK_DEFINITION_MARKERS ${name} — no cloud migration creates this constraint`);
    expect(phantoms, "a cloud marker names an object no migration creates — it probes nothing").toEqual([]);
  });

  it("the cloud grandfather list stays honest — real, currently-uncovered facets only", () => {
    // A covered facet parked in the allow-list would silence a future drop of its marker; a key the
    // journal no longer creates is dead weight. Both are refused so the list cannot rot into cover.
    for (const key of Object.keys(CLOUD_COLUMN_FACET_ALLOWLIST)) {
      expect(objects.colFacets.has(key), `CLOUD_COLUMN_FACET_ALLOWLIST names ${key}, which no migration creates`).toBe(true);
      expect(
        markedFacets.has(key),
        `CLOUD_COLUMN_FACET_ALLOWLIST parks ${key}, which IS probed — a covered facet in the allow-list hides a future drop`,
      ).toBe(false);
    }
    // The double-probe list names real facets carrying exactly two markers.
    for (const key of Object.keys(CLOUD_DELIBERATE_DOUBLE_PROBES)) {
      const count = CLOUD_SCHEMA_MARKERS.filter(
        ([table, column]) => `${objects.colToTag.get(`${table}.${column}`)}|${table}` === key,
      ).length;
      expect(count, `CLOUD_DELIBERATE_DOUBLE_PROBES names ${key}, which carries ${count} marker(s), not 2`).toBe(2);
    }
  });

  it("the journal-derived cloud count equals the list today — the anchor the probe assertion uses", () => {
    // `deriveCloudColumnMarkerCount()` reads only the journal and the two allow-lists, so it does
    // not move when a marker is deleted. On a pristine tree it must equal the list; the probe
    // assertion in `admin-routes.test.ts` drives the same number against a real database. Delete an
    // older marker and this equality — and that assertion — go red while the old length-based one
    // would not have.
    expect(deriveCloudColumnMarkerCount(objects)).toBe(CLOUD_SCHEMA_MARKERS.length);
  });
});
