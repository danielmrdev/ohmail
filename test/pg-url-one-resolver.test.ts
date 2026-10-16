import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs helper, no declarations by design.
import { code, DERIVES_URL, OPENS_PG } from "../scripts/lib/pg-url-own.mjs";

/**
 * ONE PLACE DECIDES WHICH POSTGRES A TEST REACHES — `PG_TEST_URL`, which `scripts/lane-db.sh`
 * redirects to this worktree's own database. A file that spells the URL out again reaches the
 * SHARED box while the box selector says this worktree needs no lock: an unlocked write into
 * another lane's suite.
 *
 * The rule: a test file that OPENS a client may not derive its own URL. One that derives a URL and
 * opens nothing is fixture data, and is admitted — which is what keeps this from being a list of
 * exceptions.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/* The three definitions this census used to carry are now `scripts/lib/pg-url-own.mjs`, because
 * `scripts/box-files.mjs` asks the SAME question under `--lane-db` — a file that decides its own
 * URL cannot be vouched for by a lane database — and two copies of these regexes would be two
 * rules one edit apart. The module's docblock carries the reasoning; the cases below are unchanged. */
/* Typed here rather than at the import: the helper is plain `.mjs` with no declarations, so its
 * exports arrive as `any` and every `.some((re) => …)` below would be an implicit-any parameter. */
const OPENS: RegExp = OPENS_PG;
const DERIVES: RegExp[] = DERIVES_URL;
const strip: (src: string) => string = code;

function testFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e === "node_modules" || e === "dist") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(?:test|spec)\.tsx?$|^_.*\.tsx?$/.test(e)) out.push(relative(REPO, p));
    }
  };
  walk(join(REPO, "test"));
  for (const group of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(REPO, group))) walk(join(REPO, group, pkg, "test"));
  }
  return out.sort();
}

const FILES = testFiles().map((f) => ({ f, src: strip(readFileSync(join(REPO, f), "utf8")) }));

describe("which Postgres a test reaches", () => {
  it("has a suite to measure at all", () => {
    expect(FILES.length).toBeGreaterThan(1000);
  });

  it("lets no client-opening test file derive its own URL", () => {
    const offenders = FILES
      .filter(({ src }) => OPENS.test(src) && DERIVES.some((re) => re.test(src)))
      .map(({ f }) => f);
    expect(offenders,
      "these open a Postgres client AND spell out a test database: take pgTestUrl(import.meta.url) " +
      "from @trafficflow/db/testing (or DB_URL from apps/worker/test/_workerdb.ts) instead").toEqual([]);
  });

  /* The rule above is vacuous if nothing opens a client, and a census that cannot fire is worth
   * less than none — so the population it judges is counted. */
  it("judges a real population — the files that do open a client", () => {
    const opening = FILES.filter(({ src }) => OPENS.test(src));
    expect(opening.length).toBeGreaterThan(60);
    const throughHelper = opening.filter(({ src }) => /\bPG_TEST_URL\b|\bDB_URL\b|\bpgTestUrl\b/.test(src));
    expect(throughHelper.length).toBeGreaterThan(40);
  });

  /* The other half: a file may hold the URL as DATA. These are the config resolver's input and the
   * secret scanner's sample, and the census admits them because they open nothing. */
  it("admits a file that ASSIGNS the resolver's URL into the environment it drives", () => {
    const f = "apps/api-vercel/test/wake-e2e.pg.test.ts";
    const entry = FILES.find((x) => x.f === f);
    expect(entry, `${f} has moved — pick another file that assigns process.env from PG_TEST_URL`)
      .toBeDefined();
    expect(/process\.env\.DATABASE_URL_SESSION\s*=\s*PG_TEST_URL/.test(entry!.src)).toBe(true);
    expect(DERIVES.some((re) => re.test(entry!.src))).toBe(false);
  });

  it("admits a file that names a test database and opens nothing", () => {
    const dataOnly = FILES
      .filter(({ src }) => DERIVES.some((re) => re.test(src)) && !OPENS.test(src))
      .map(({ f }) => f);
    expect(dataOnly.length).toBeGreaterThan(2);
    expect(dataOnly).toContain("apps/worker/test/isolated-db-naming.test.ts");
  });

  it("keeps the fallback URL in one source file and one script", () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const e of entries) {
        if (e === "node_modules" || e === "dist") continue;
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(?:ts|tsx|mjs)$/.test(e) && /\btrafficflow_test\b/.test(strip(readFileSync(p, "utf8")))) {
          sources.push(relative(REPO, p));
        }
      }
    };
    for (const group of ["packages", "apps"]) {
      for (const pkg of readdirSync(join(REPO, group))) walk(join(REPO, group, pkg, "src"));
    }
    walk(join(REPO, "scripts"));
    expect(sources.sort()).toEqual(["packages/db/src/testing.ts", "scripts/lane-db.mjs"]);
  });
});
