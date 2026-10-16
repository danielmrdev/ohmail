import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// Private census helper — comments are blanked so a historical mention in a docblock is not a
// finding, while the string literal every door must not carry stays visible (its header says why).
import { withoutComments } from "../scripts/lib/source-scan.mjs";

/**
 * THE NEWS FOLDER LITERAL CENSUS (0.22, `ohmail/Reads` → `ohmail/News`). The legacy spelling
 * survives in exactly two code homes and one migration's text: the resolver (`packages/core/src/types.ts`, where
 * `LEGACY_NEWS_FOLDER` and `pileFolder` live) and `packages/db/src/screener-apply.ts`, the
 * duplicated constant a package that must not depend on core reads (its docblock says why; the
 * pin below holds the pair equal). A third home is migration TEXT, not a reader: the inlined device
 * journal (`packages/db-mail/src/sqlite-journal.ts`, generated from `drizzle-sqlite/`) carries mail
 * 0144's backfill, which names the pre-0.22 spelling to match rules written before the rename.
 * Everywhere else a consumer reaches the pile through the
 * resolver, so a fresh literal is a reader the rename silently breaks. Ratcheted BOTH ways: a
 * stray occurrence refuses with its file named, and an allow-listed file that no longer carries
 * the literal refuses too, so the list cannot go stale.
 */
const ALLOWED = [
  "packages/core/src/types.ts",
  "packages/db/src/screener-apply.ts",
  "packages/db-mail/src/sqlite-journal.ts",
];

const LEGACY = "ohmail/Reads";

function sourceFiles(): string[] {
  const all = execSync("git ls-files", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: `${import.meta.dirname}/..` })
    .split("\n");
  return all.filter((f) => /^(packages|apps)\/[^/]+\/(src|app)\//.test(f) && /\.(ts|tsx|mts|mjs|js)$/.test(f));
}

describe("news-folder literal census", () => {
  const files = sourceFiles();

  it("scans a real corpus (positive control: the resolver home is in the set and carries the literal)", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain(ALLOWED[0]);
    const resolver = readFileSync(`${import.meta.dirname}/../${ALLOWED[0]}`, "utf8");
    expect(withoutComments(resolver).includes(LEGACY)).toBe(true);
  });

  it("the legacy spelling appears in code in exactly the allow-listed homes", () => {
    const hits: string[] = [];
    for (const f of files) {
      const src = readFileSync(`${import.meta.dirname}/../${f}`, "utf8");
      if (withoutComments(src).includes(LEGACY)) hits.push(f);
    }
    const strays = hits.filter((f) => !ALLOWED.includes(f));
    expect(strays, `code outside the resolver carries '${LEGACY}' — read it through pileFolder/canonicalDestination instead: ${strays.join(", ")}`).toEqual([]);
    // The other way: an allow-listed home that lost the literal is a stale list entry.
    for (const a of ALLOWED) {
      expect(hits, `${a} no longer carries the literal — shrink the allow list`).toContain(a);
    }
  });
});
