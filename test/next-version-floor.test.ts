import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { withoutComments } from "../scripts/lib/source-scan.mjs";

/**
 * THE FRAMEWORK IS THE AUTH GATE, so its declared floor is a security control: middleware is the only
 * thing between an anonymous visitor and the app route, and the admin cloak is middleware too. 15.5.24
 * is the first release that fixes GHSA-2xp9-vwfh-vxw4 (code execution in the image optimizer) and
 * GHSA-p293-qw3h-jr36 (code execution on a Windows-hosted server); it carries the 14.2.25 middleware
 * bypass fix as well. The lockfile arms keep one React major and every react-dom on its own react:
 * react-dom refuses a react of another version at load, and the desktop renders webapp modules.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (p: string): string => readFileSync(`${HERE}${p}`, "utf8");

/** The first release carrying both critical fixes named above. */
const NEXT_FLOOR = [15, 5, 24] as const;

const APPS = ["apps/webapp", "apps/admin", "apps/api-vercel"];

const parse = (v: string): number[] => v.replace(/^[^\d]*/, "").split(".").map(Number);

const atLeast = (got: number[], want: readonly number[]): boolean => {
  for (let i = 0; i < want.length; i++) {
    if ((got[i] ?? 0) > want[i]!) return true;
    if ((got[i] ?? 0) < want[i]!) return false;
  }
  return true;
};

/** The lockfile's `snapshots:` section, keyed by each node's own line. */
const snapshotKeys = (lock: string): string[] =>
  [...lock.slice(lock.indexOf("\nsnapshots:\n")).matchAll(/^ {2}'?([^ '\n][^'\n]*?)'?:(?: \{\})?$/gm)].map((m) => m[1]!);

describe("the declared Next floor carries the critical fixes", () => {
  it.each(APPS)("%s declares a floor at or above 15.5.24", (app) => {
    const pkg = JSON.parse(read(`../${app}/package.json`)) as { dependencies?: Record<string, string> };
    const declared = pkg.dependencies?.next;
    expect(declared, `${app} does not depend on next`).toBeDefined();
    expect(
      atLeast(parse(declared!), NEXT_FLOOR),
      `${app} declares "next": "${declared}" — that range resolves to versions carrying ` +
        `GHSA-2xp9-vwfh-vxw4 and GHSA-p293-qw3h-jr36`,
    ).toBe(true);
  });

  it("the LOCKED version — what actually deploys — is above it too", () => {
    // The floor is what a regeneration may pick; this is what every `--frozen-lockfile`
    // install, including Vercel's, really resolves.
    const lock = read("../pnpm-lock.yaml");
    const locked = [...lock.matchAll(/^ {2}next@(\d+\.\d+\.\d+):/gm)].map((m) => m[1]!);
    expect(locked.length, "no next@x.y.z entry found in pnpm-lock.yaml").toBeGreaterThan(0);
    for (const v of locked) {
      expect(atLeast(parse(v), NEXT_FLOOR), `pnpm-lock.yaml pins next@${v}`).toBe(true);
    }
  });

  it("all three apps agree — one framework version across the deployment", () => {
    const declared = APPS.map(
      (app) => (JSON.parse(read(`../${app}/package.json`)) as { dependencies: Record<string, string> }).dependencies.next,
    );
    expect(new Set(declared).size, `the three apps declare different Next ranges: ${declared.join(", ")}`).toBe(1);
  });
});

describe("one React across the workspace", () => {
  it("pnpm-lock.yaml holds one react major, and every react-dom node is keyed on its own react", () => {
    const lock = read("../pnpm-lock.yaml");
    const reacts = [...lock.matchAll(/^ {2}react@(\d+)\.\d+\.\d+:/gm)].map((m) => m[1]!);
    expect(reacts.length, "no react@x.y.z entry found in pnpm-lock.yaml").toBeGreaterThan(0);
    expect([...new Set(reacts)], "pnpm-lock.yaml holds more than one react major").toEqual(["19"]);
    const pairs = snapshotKeys(lock).filter((k) => k.startsWith("react-dom@"));
    expect(pairs.length, "no react-dom snapshot found in pnpm-lock.yaml").toBeGreaterThan(0);
    for (const key of pairs) {
      const m = /^react-dom@(\d+\.\d+\.\d+)\(react@(\d+\.\d+\.\d+)\)$/.exec(key);
      expect(m, `unreadable react-dom snapshot key ${key}`).not.toBeNull();
      expect(m![1], `${key}: react-dom is paired with a react of another version`).toBe(m![2]);
    }
  });

  it("the desktop's npm lockfile resolves the same pair", () => {
    const lock = JSON.parse(read("../apps/desktop/package-lock.json")) as {
      packages: Record<string, { version?: string }>;
    };
    const react = lock.packages["node_modules/react"]?.version;
    expect(react, "apps/desktop/package-lock.json has no node_modules/react").toBeDefined();
    expect(react!.split(".")[0]).toBe("19");
    expect(lock.packages["node_modules/react-dom"]?.version).toBe(react);
  });
});

/* GHSA-2xp9-vwfh-vxw4 decodes AVIF through sharp. Next 15 installs sharp as its own optional
   dependency; nothing here configures the optimizer or depends on sharp directly. */
describe("the image optimizer is left as the framework ships it", () => {
  it.each(APPS)("%s/next.config.mjs sets no `images` key", (app) => {
    const src = withoutComments(read(`../${app}/next.config.mjs`));
    expect(src, `${app}/next.config.mjs configures the image optimizer`).not.toMatch(/\bimages\s*:/);
  });

  it("no workspace manifest declares sharp", () => {
    const manifests = ["package.json"];
    for (const group of ["apps", "packages"]) {
      for (const name of readdirSync(`${HERE}../${group}`)) {
        if (existsSync(`${HERE}../${group}/${name}/package.json`)) manifests.push(`${group}/${name}/package.json`);
      }
    }
    expect(manifests.length).toBeGreaterThan(10);
    for (const rel of manifests) {
      const pkg = JSON.parse(read(`../${rel}`)) as Record<string, Record<string, string> | undefined>;
      for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        expect(pkg[field]?.sharp, `${rel} ${field} declares sharp`).toBeUndefined();
      }
    }
  });

  it("next is the only node in pnpm-lock.yaml that depends on sharp", () => {
    const lock = read("../pnpm-lock.yaml");
    const snapshots = lock.slice(lock.indexOf("\nsnapshots:\n"));
    const importers = new Set<string>();
    let node = "";
    for (const line of snapshots.split("\n")) {
      const key = /^ {2}'?([^ '][^']*?)'?:(?: \{\})?$/.exec(line);
      if (key) node = key[1]!;
      else if (/^ {6}sharp: /.test(line)) importers.add(node.replace(/\(.*$/, ""));
    }
    expect([...importers].every((n) => /^next@\d/.test(n)), `sharp is reached from ${[...importers].join(", ")}`).toBe(true);
    const workspace = lock.slice(lock.indexOf("\nimporters:\n"), lock.indexOf("\npackages:\n"));
    expect(workspace, "a workspace importer depends on sharp").not.toMatch(/^ {6}sharp:/m);
  });
});
