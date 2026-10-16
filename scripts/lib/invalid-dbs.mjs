/**
 * THE INVALID DATABASES ON A SERVER, by name — the pure half of `lane-db.sh --list-invalid`.
 * `datconnlimit = -2` marks a DROP that was cut short; every later connection to that name fails.
 * The anchor is `postgres` in the SAME rows: without it the read measured nothing, so a zero is
 * UNREADABLE (rc 2) rather than "none". `doorOf` names which door makes a name; nothing is dropped.
 */
export function invalidDbReading({ rows, doorOf }) {
  if (!rows.some((r) => r.datname === "postgres")) {
    return { rc: 2, invalid: [], lines: [`UNREADABLE: ${rows.length} database row(s) and no \`postgres\` among them — the read measured nothing`] };
  }
  const invalid = rows.filter((r) => Number(r.datconnlimit) === -2).map((r) => r.datname).sort();
  const by = new Map();
  for (const n of invalid) by.set(doorOf(n), (by.get(doorOf(n)) ?? 0) + 1);
  const split = [...by].sort((a, b) => a[0].localeCompare(b[0])).map(([d, n]) => `${d} ${n}`).join(" · ");
  return {
    rc: 0,
    invalid,
    lines: [...invalid.map((n) => `INVALID ${n} (${doorOf(n)})`),
      `LIST_INVALID ${invalid.length} of ${rows.length} database(s)${split ? ` · ${split}` : ""} · anchor postgres present · nothing dropped`],
  };
}
