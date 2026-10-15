import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PGLITE_TEMPLATE_ENV } from "../packages/db/src/testing-template.js";

/**
 * THE TEMPLATE'S OFF SWITCH IS A PERSON'S, NEVER A TEST'S. `makeTestDb` without the template is
 * the old replay, and a file that turned it off would measure a path nothing else runs and hide
 * whatever the template got wrong. So no test file, test helper, setup file, vitest config or
 * package manifest may name the variable at all; the template module reads it and nothing else.
 */
const REPO = join(import.meta.dirname, "..");

/** The files that decide what a test run does. A documentation tree is not a suite, even where it
 *  parks copies of test files. */
export function inScope(path: string): boolean {
  if (path.startsWith("docs/")) return false;
  return /(^|\/)test\//.test(path)
    || /\.test\.[cm]?[jt]sx?$/.test(path)
    || /(^|\/)vitest[^/]*\.config\.[cm]?[jt]s$/.test(path)
    || /(^|\/)package\.json$/.test(path);
}

export function names(text: string): boolean {
  return new RegExp(`\\b${PGLITE_TEMPLATE_ENV}\\b`).test(text);
}

const tracked = (): string[] =>
  execFileSync("git", ["-C", REPO, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 << 20 })
    .split("\0").filter(Boolean);

describe(`no test file sets ${PGLITE_TEMPLATE_ENV}`, () => {
  it("the matcher refuses every way of setting it and admits the sidecar's own switch", () => {
    for (const body of [
      `process.env.${PGLITE_TEMPLATE_ENV} = "0";`,
      `vi.stubEnv("${PGLITE_TEMPLATE_ENV}", "0");`,
      `test: { env: { ${PGLITE_TEMPLATE_ENV}: "0" } }`,
      `"test": "${PGLITE_TEMPLATE_ENV}=0 vitest run"`,
    ]) expect(names(body), body).toBe(true);
    expect(names(`process.env.OHMAIL_PGDATA_TEMPLATE = "0";`)).toBe(false);
    expect(names(`${PGLITE_TEMPLATE_ENV}_SALT`)).toBe(false);
  });

  it("the read path finds the name where it lives, so a zero below is a reading", () => {
    expect(names(readFileSync(join(REPO, "packages/db/src/testing-template.ts"), "utf8"))).toBe(true);
    expect(inScope("packages/db/src/testing-template.ts")).toBe(false);
  });

  it("no file in scope names it", () => {
    const scope = tracked().filter(inScope);
    expect(scope.length, "the census read almost nothing — it is guarding nothing").toBeGreaterThan(1500);
    expect(scope).toContain("test/setup/pgdata-template.global.ts");
    expect(scope).toContain("vitest.config.ts");
    // An unreadable file throws here rather than reading as a file that does not name it.
    const offenders = scope.filter((f) => names(readFileSync(join(REPO, f), "utf8")));
    expect(offenders, `these files name ${PGLITE_TEMPLATE_ENV}; it is for a person at a shell only`).toEqual([]);
  });
});
