import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* Derived from this file's own location, never named. An absolute path pins the generator to one
 * checkout: it runs, reports success, and rewrites a file in somebody else's tree — or, more
 * quietly, regenerates from a directory that is not the one being edited. */
const W = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(W, "packages/db-mail/drizzle-sqlite");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
/* The header the generated module carries, and it is the one ON DISK rather than a longer copy:
   this script rewrites the file, so a header here that disagrees with the committed one silently
   reverts every edit made to it — measured once, against the comment-length census. */
const HEADER = `/**
 * The sqlite journal, inlined: a device bundler resolves imports, not
 * directory listings, so a migrator reading \`.sql\` files off disk would pass
 * every test and find nothing on a phone. These are the same files as
 * \`drizzle-sqlite/\`, compiled into this module.
 *
 * Generated, never edited: \`sqlite-journal-inlined.test.ts\` compares this
 * module with the directory byte for byte, in order. Regenerate with
 * \`node scripts/gen-sqlite-journal.mjs\` after touching the directory.
 */

/** One journal entry: the file it came from and the statements it applies, in order. */
export interface SqliteJournalEntry {
  readonly name: string;
  readonly statements: readonly string[];
}

`;
const entries = files.map((f) => {
  const sql = readFileSync(join(dir, f), "utf8");
  const statements = sql.split("--> statement-breakpoint")
    .map((s) => s.replace(/^\s*--[^\n]*\n/gm, "").trim())
    .filter((s) => s.length > 0);
  return { name: f, statements };
});
const body = `export const SQLITE_JOURNAL: readonly SqliteJournalEntry[] = ${
  JSON.stringify(entries, null, 2)
} as const;\n`;
writeFileSync(join(W, "packages/db-mail/src/sqlite-journal.ts"), HEADER + body);
console.log("entries", entries.length, "statements", entries.reduce((n, e) => n + e.statements.length, 0));
