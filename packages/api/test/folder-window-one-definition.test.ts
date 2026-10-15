import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";

/**
 * ═══ THE TWO PROVIDER WINDOWS SHARE ONE PAGINATION MECHANISM ═══════════════════════════════
 *
 * Junk and Trash are the same read: every connected mailbox's folder page, merged newest-first
 * into one account-level page, with a per-mailbox `(uidValidity, seq)` watermark minted into an
 * opaque cursor. Both files carried their own copy of all three parts, byte-identical but for a
 * refusal noun. A copy that drifts is not a style defect: the epoch validator is what keeps a
 * caller-chosen `uidValidity` from switching off the adapter's epoch guard, and the merge's
 * cursor bookkeeping is what keeps a recreated folder from appending fresh mail under stale rows
 * — so a fix applied to one window and not the other is a live window with the old bug in it.
 *
 * The census refuses a SECOND declaration of any of the four, wherever it appears under
 * `packages/api/src`, and names the files. Declarations only, read from source with comments and
 * string literals stripped — a name in a comment is not a definition, and a call site is not one
 * either.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "../src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * Each mechanism by the shape that DECLARES it. `lowestTakenSeq` is the merge's own lane field:
 * it is written where the merge is implemented and nowhere else, so its declaration is the
 * merge's declaration.
 */
const MECHANISMS: ReadonlyArray<{ key: string; what: string; decl: RegExp }> = [
  {
    key: "epoch-validator",
    what: "the wire UIDVALIDITY validator (RFC 3501 §2.3.1.1 range, no `1e9`/` 7 `/`0x7`)",
    decl: /\bfunction\s+requireRealEpoch\s*\(/g,
  },
  {
    key: "cursor-decoder",
    what: "the window cursor decoder (length ceiling, uuid keys, uint32 epochs)",
    decl: /\bfunction\s+parse[A-Za-z0-9_]*Cursor\s*\(/g,
  },
  {
    key: "cursor-minter",
    what: "the window cursor minter",
    decl: /\bfunction\s+mint[A-Za-z0-9_]*Cursor\s*\(/g,
  },
  {
    key: "lane-merge",
    what: "the k-way merge and its per-mailbox watermark bookkeeping",
    decl: /\blowestTakenSeq\s*:\s*0\b/g,
  },
];

const FILES = walk(SRC).map((p) => ({ path: p, src: withoutCommentsAndLiterals(readFileSync(p, "utf8")) }));

describe("the Junk and Trash windows declare one pagination mechanism, not two", () => {
  for (const m of MECHANISMS) {
    it(`${m.key} — ${m.what} — is declared exactly once`, () => {
      const holders = FILES
        .filter((f) => (f.src.match(m.decl) ?? []).length > 0)
        .map((f) => f.path.slice(SRC.length + 1));
      expect(holders, `${m.key} declared in: ${holders.join(", ") || "(nowhere)"}`).toHaveLength(1);
    });
  }

  /**
   * THE POSITIVE CONTROL for the refusal: the census must be able to SEE a second declaration.
   * Without it a regex that matched nothing at all would pass every arm above for the wrong
   * reason — "declared nowhere" is refused by the length check, but "declared once by accident"
   * is not, so the arm that proves the reading is this one.
   */
  it("refuses a planted second declaration of each mechanism", () => {
    for (const m of MECHANISMS) {
      const one = FILES.filter((f) => (f.src.match(m.decl) ?? []).length > 0);
      expect(one, `${m.key} is declared nowhere — the census reads nothing`).toHaveLength(1);
      const planted = [...FILES, { path: "synthetic-second-copy.ts", src: one[0]!.src }];
      const holders = planted.filter((f) => (f.src.match(m.decl) ?? []).length > 0);
      expect(holders.length, `${m.key}: a planted copy was not seen`).toBe(2);
    }
  });
});
