import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * WHAT A PER-FILE DATABASE IS CALLED — the pure half of `_isolateddb.ts`, so it can be tested.
 *
 * Its own module because `_isolateddb.ts` reaches the database through `_workerenv.js`, which
 * makes every importer a box-touching file that takes the shared Postgres lock. Naming is
 * arithmetic over two strings; a test of it should not queue behind a box it never opens.
 */

/** The database name in a URL — what a diagnostic may print, where the URL itself may not. */
export function databaseOf(url: string): string {
  try { return new URL(url).pathname.replace(/^\//, ""); } catch { return "?"; }
}

/** The checkout a fixture is running in: the directory holding `pnpm-workspace.yaml`, or, in the
 *  published tree (npm workspaces), the `package.json` that declares `workspaces` — the rule
 *  `packages/db/src/testing.ts` walks by. */
export function checkoutRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (let up = 0; up < 6; up++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) || declaresWorkspaces(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return from;
}

function declaresWorkspaces(manifest: string): boolean {
  try { return Array.isArray((JSON.parse(readFileSync(manifest, "utf8")) as { workspaces?: unknown }).workspaces); } catch { return false; }
}

/**
 * ONE CHECKOUT'S KEY — 12 hex, so two checkouts never name the same per-file database.
 *
 * Without it every checkout used the bare `trafficflow_worker_<file>`, and two trees declaring
 * different journals dropped each other's database MID-RUN: the recreate policy in
 * `_isolateddb.ts` is right about a database of its own and destructive about a shared one. A lane
 * database's own key is preferred when there is one, so these sit in the namespace
 * `scripts/lane-db.sh` created and one derivation governs both; otherwise it is the checkout path,
 * which is what tells two clones of one branch apart.
 */
export function checkoutKeyOf(database: string, root: string): string {
  const lane = /^trafficflow_l_([0-9a-f]{12})$/.exec(database);
  if (lane) return lane[1]!;
  return createHash("sha256").update(root).digest("hex").slice(0, 12);
}

/**
 * The physical name for a logical per-file one, inside Postgres's 63-byte identifier limit.
 *
 * A name the server silently truncates would put two files back on one database, which is the
 * defect the key exists to remove — so a logical name with no room for the key keeps a hash of
 * itself rather than a prefix of itself.
 */
export function isolatedDbName(logical: string, key: string): string {
  const room = 63 - key.length - 1;
  const head = logical.length <= room
    ? logical
    : `${logical.slice(0, room - 13)}_${createHash("sha256").update(logical).digest("hex").slice(0, 12)}`;
  return `${head}_${key}`;
}
