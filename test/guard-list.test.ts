import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { GUARD_LIST, GUARD_LIST_ENV, publicModeNote, readGuardList } from "./support/guard-list.js";

/**
 * THE GUARD LIST'S SWITCH, AND THE PUBLIC RUNNER'S READING OF IT.
 *
 * A run names the privacy guard's private list in OHMAIL_GUARD_LIST, and nothing else turns PRIVATE MODE
 * on. The reading is driven here on synthetic files and checkouts: unset is PUBLIC MODE where the checkout
 * has no publisher and a refusal by name where it has one (the private repository), and a value that is not
 * absolute, resolves inside this checkout, names nothing readable or a file with no entry refuses by the
 * variable's name and never prints the value. Under CI with the variable unset, the last case runs every
 * reader of the guard in a child run and asks its report whether each PRIVATE MODE arm was skipped for
 * that reason, and nothing else.
 */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "test/guard-list.test.ts";
const scratch = mkdtempSync(join(tmpdir(), "guard-list-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const refusal = (value: string): string => {
  try {
    readGuardList({ [GUARD_LIST_ENV]: value }, REPO);
  } catch (e) {
    return (e as Error).message;
  }
  return "(no refusal)";
};

describe("the guard list is named by one variable", () => {
  it("unset is PUBLIC MODE in a checkout without the publisher, and the reading says why", () => {
    const publicCheckout = join(scratch, "public-checkout");
    mkdirSync(publicCheckout, { recursive: true });
    expect(readGuardList({}, publicCheckout)).toEqual({ mode: "public", why: `${GUARD_LIST_ENV} is unset` });
  });

  it("unset refuses by name in a checkout that holds the publisher, the private repository", () => {
    const privateCheckout = join(scratch, "private-checkout");
    mkdirSync(join(privateCheckout, "scripts"), { recursive: true });
    writeFileSync(join(privateCheckout, "scripts/publish-desktop.mjs"), "// the publisher\n");
    expect(() => readGuardList({}, privateCheckout)).toThrow(/^OHMAIL_GUARD_LIST is unset in a checkout that holds scripts\/publish-desktop\.mjs/);
  });

  it("a list named by an absolute path outside the checkout is read whole", () => {
    const file = join(scratch, "list.tsv");
    writeFileSync(file, "# a comment\nzqone\tshared\tbrand\n");
    expect(readGuardList({ [GUARD_LIST_ENV]: file }, REPO)).toEqual({ mode: "private", text: "# a comment\nzqone\tshared\tbrand\n" });
  });

  it("refuses by the variable's name and never prints the value", () => {
    writeFileSync(join(scratch, "empty.tsv"), "# only a comment\n\n");
    mkdirSync(join(scratch, "a-directory"));
    symlinkSync(join(REPO, "package.json"), join(scratch, "points-inside.tsv"));
    const cases: Array<[string, RegExp]> = [
      ["relative/list.tsv", /is not an absolute path/],
      [join(REPO, "package.json"), /names a file inside this checkout/],
      [join(scratch, "points-inside.tsv"), /names a file inside this checkout/],
      [join(scratch, "no-such-list.tsv"), /names nothing that exists/],
      [join(scratch, "a-directory"), /names a file that cannot be read/],
      [join(scratch, "empty.tsv"), /names a file with no entry/],
    ];
    for (const [i, [value, why]] of cases.entries()) {
      const message = refusal(value);
      expect(message, `case ${i}`).toMatch(why);
      expect(message.startsWith(`${GUARD_LIST_ENV} `)).toBe(true);
      expect(message.includes(value), "the refusal printed the value").toBe(false);
    }
    // Set but empty is a value, not an absence: a run that meant PUBLIC MODE unsets it.
    expect(refusal("")).toMatch(/is not an absolute path/);
  });
});

const UNDER_CI = Boolean(process.env.CI) && process.env.CI !== "false";
/* The public tree only: the private repository refuses an unset variable before any arm runs. */
const PUBLIC_CHECKOUT = !existsSync(join(REPO, "scripts/publish-desktop.mjs"));
/* The arm lists the readers with git, so its premise is a git checkout whose top is this tree; an archive or a
   render without one skips the arm with that reason in its title rather than failing on the listing. */
const top = spawnSync("git", ["-C", REPO, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
const GIT_CHECKOUT = top.status === 0 && realpathSync(top.stdout.trim()) === realpathSync(REPO);
const CI_ARM = "PUBLIC MODE on CI — every reader runs on the synthetic set, and each PRIVATE MODE arm is skipped for that reason";
const CI_ARMED = UNDER_CI && PUBLIC_CHECKOUT && process.env[GUARD_LIST_ENV] === undefined;

/** The test files that read the guard list: every one importing test/support/guard-list, this file aside. */
function guardReaders(): string[] {
  const tracked = execFileSync("git", ["-C", REPO, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\0");
  return tracked
    .filter((f) => /\.test\.tsx?$/.test(f) && f !== SELF)
    .filter((f) => /from\s+["'][^"']*support\/guard-list(?:\.js)?["']/.test(readFileSync(join(REPO, f), "utf8")));
}

type Report = { testResults: Array<{ name: string; assertionResults: Array<{ title: string; status: string }> }> };

describe("the public runner", () => {
  it.runIf(CI_ARMED && GIT_CHECKOUT)(
    CI_ARMED && !GIT_CHECKOUT ? `${CI_ARM} [skipped: this tree is not a git checkout, so its readers cannot be listed]` : CI_ARM,
    () => {
      expect(GUARD_LIST).toEqual({ mode: "public", why: `${GUARD_LIST_ENV} is unset` });
      const readers = guardReaders();
      expect(readers.length, "no test file reads the guard list").toBeGreaterThan(0);
      const out = join(scratch, "readers.json");
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k !== GUARD_LIST_ENV && !/^(VITEST|TINYPOOL)/.test(k)) env[k] = v;
      }
      const vitest = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");
      const run = spawnSync(process.execPath, [vitest, "run", ...readers, "--reporter=json", `--outputFile.json=${out}`],
        { cwd: REPO, env, encoding: "utf8", timeout: 240_000, maxBuffer: 1 << 26 });
      expect(run.status, `the child run of ${readers.length} reader(s) exited ${run.status}`).toBe(0);
      const report = JSON.parse(readFileSync(out, "utf8")) as Report;
      const byFile = new Map(report.testResults.map((r) => [relative(REPO, r.name).split(sep).join("/"), r.assertionResults]));
      expect([...byFile.keys()].sort(), "a reader the child run did not read").toEqual([...readers].sort());
      const arms = [...byFile.values()].flat();
      const note = ` ${publicModeNote(`${GUARD_LIST_ENV} is unset`)}`;
      const privateArms = arms.filter((a) => a.title.startsWith("PRIVATE MODE"));
      expect(privateArms.length, "the readers declare no PRIVATE MODE arm").toBeGreaterThan(0);
      expect(privateArms.filter((a) => a.status !== "skipped" || !a.title.endsWith(note)).map((a) => a.title),
        "a PRIVATE MODE arm that ran, or skipped for another reason").toEqual([]);
      expect(arms.filter((a) => a.status === "skipped" && !a.title.startsWith("PRIVATE MODE")).map((a) => a.title),
        "a skip PUBLIC MODE does not explain").toEqual([]);
      expect(arms.filter((a) => a.status === "failed").map((a) => a.title)).toEqual([]);
      const publicArms = arms.filter((a) => a.title.startsWith("PUBLIC MODE"));
      expect(publicArms.length, "the readers declare no PUBLIC MODE arm").toBeGreaterThan(0);
      expect(publicArms.filter((a) => a.status !== "passed").map((a) => a.title)).toEqual([]);
      console.info(`[guard] PUBLIC MODE on CI: ${readers.length} reader(s), ${privateArms.length} PRIVATE MODE arm(s) skipped for it, `
        + `${publicArms.length} PUBLIC MODE arm(s) passed`);
    },
    300_000,
  );
});
