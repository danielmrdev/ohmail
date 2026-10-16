import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as scan from "../scripts/lib/source-scan.mjs";

/**
 * ═══ EVERY RULE STATES WHETHER ITS BACKLOG WAS ASKED FOR ══════════════════════════════════
 *
 * `rules.retro_requested_at` NULL means "nobody asked" and every reader honours it: the worker's
 * owed set is `retro_requested_at IS NOT NULL AND retro_done_at IS NULL`, and the held-release
 * screen counts what such a rule claims as still stuck. An insert that leaves the column out is
 * not a slower walk — it is no walk, silently, for ever. Measured 2026-09-16: three of the nine
 * insert sites never wrote it.
 */

/**
 * THE RULE THIS PINS: an insert into `rules` NAMES `retroRequestedAt`, whatever the answer — a
 * decision asks (`now`), an import declines (`null`), and both are statements. Only the omission
 * is refused, because it reads as a decline nobody decided.
 *
 * SCANNED ROOTS, not touched packages: this reads `packages/&ast;/src` and `apps/&ast;/src`, so
 * selection by changed package never reaches it — run it by name.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The one exception, with its reason: the sidecar's mirror COPIES a rule row the server already
 * decided, spreading the body it was handed. It originates no decision, so it has no answer of its
 * own to state — and inventing one here would overwrite the server's.
 */
const COPIES_A_SERVER_ROW: ReadonlyArray<string> = ["apps/sidecar/src/cloud-mirror.ts"];

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== "node_modules" && name !== "dist" && name !== "build") walk(full);
      } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
    }
  };
  for (const root of ["packages", "apps"]) {
    for (const pkg of readdirSync(path.join(REPO, root))) {
      const src = path.join(REPO, root, pkg, "src");
      try { if (statSync(src).isDirectory()) walk(src); } catch { /* no src here */ }
    }
  }
  return out;
}

/**
 * Every `insert(<rules table>).values(…)` in a file, as the text of its `values` argument.
 *
 * Parsed left to right with the comments and string bodies blanked first ({@link scan}), because
 * this repo's comments quote the code they are about — a docblock naming `retroRequestedAt` beside
 * an insert that does not write it is exactly the shape a grep would pass.
 */
function ruleInserts(src: string): string[] {
  const blanked = scan.withoutComments(src);
  const out: string[] = [];
  const call = /\.insert\(\s*(?:rulesTbl|rules|rulesTable)\s*\)\s*\.values\(/g;
  for (let m = call.exec(blanked); m !== null; m = call.exec(blanked)) {
    const open = m.index + m[0].length - 1;
    const { start, end, closed } = scan.bracketSpan(blanked, open, "(", ")");
    expect(closed, `an unterminated .values( — the parse cannot be trusted`).toBe(true);
    out.push(blanked.slice(start, end));
  }
  return out;
}

describe("a rule's retro answer is stated at every insert", () => {
  it("finds the insert sites at all — the premise", () => {
    const found = sources().filter((f) => ruleInserts(readFileSync(f, "utf8")).length > 0);
    // Nine sites were measured on 2026-09-16; on 2026-10-04 the Screener decision, "Not junk, always
    // allow", the HEY import and then the learning promotion moved onto `writeRuleUnderKey`'s one
    // insert, leaving five files. A parse that found two would make the census below vacuous, so the
    // floor is asserted.
    expect(found.length, "the parse found almost no rule inserts — check it before believing it")
      .toBeGreaterThanOrEqual(5);
  });

  it("every insert names `retroRequestedAt`, or is the sidecar's copy of a server row", () => {
    const silent: string[] = [];
    for (const file of sources()) {
      const rel = path.relative(REPO, file);
      if (COPIES_A_SERVER_ROW.includes(rel)) continue;
      for (const values of ruleInserts(readFileSync(file, "utf8"))) {
        if (!values.includes("retroRequestedAt")) silent.push(rel);
      }
    }
    expect(silent, "a rule is created without saying whether its backlog was asked for")
      .toEqual([]);
  });
});
