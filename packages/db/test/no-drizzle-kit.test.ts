import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `drizzle-kit` IS GONE, AND IT HAS TO STAY GONE.
 *
 * The change that destroys a database in the stage-3 journal split is not the split — it is the
 * first `drizzle-kit generate` after it. `prepareOutFolder` reads every `meta/*_snapshot.json`,
 * validates them all, and diffs the schema against the LAST one. The 18 committed snapshots
 * described all 55 tables; against a cloud-only `schema.ts` the next generate would emit
 * `DROP TABLE` for the 35 mail tables. A MISSING snapshot is safe — empty previous state
 * produces a full CREATE diff, obviously wrong, caught in the first second. A WRONG snapshot is
 * silent.
 *
 * And the gun was already loaded before the split: `0015` and `0019`–`0023` never had a
 * snapshot, so the newest was `0018_snapshot.json` while the journal was at `0023`. Running
 * `generate` on `main` would have re-emitted DDL for five migrations. Those five are
 * hand-written — CHECK constraints, triggers, a partial unique index, a deferred
 * constraint-trigger pair — none of which the generator can produce.
 *
 * So the generator, its config and its snapshots were deleted (the project's design notes
 * §3a), which **overturns** the snapshot discipline the project's design notes recorded as a binding
 * acceptance criterion. This file is what makes the removal structural instead of a convention
 * somebody remembers: a deleted script with the tool still in `devDependencies` is one
 * `npx drizzle-kit generate` from a fresh checkout away.
 *
 * What is NOT lost by removing it: nothing this repository was relying on. The acceptance check
 * "`generate` reports no schema changes" proved *snapshot ≡ schema.ts*; it never proved
 * *journal ≡ schema.ts*. The two guarantees that matter are both intact and neither involves
 * drizzle-kit:
 *
 *  · **journal ≡ schema.ts** — `makeTestDb()` replays the journal into PGlite and every test
 *    writes through the drizzle schema, so a column the schema declares that the journal never
 *    creates fails loudly. (It does not catch a nullable journal-only column, or a missing
 *    index/trigger/constraint — do not over-claim it.)
 *  · **the journals build the right schema** — `journal-split.pg.test.ts`'s full catalog diff,
 *    which carries that second weight alone now.
 */

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

const JOURNALS = [
  join(REPO, "packages/db/drizzle"),
  join(REPO, "packages/db/drizzle-cloud"),
  join(REPO, "packages/db-mail/drizzle"),
];

/** Every `package.json` in the workspace: the root, `packages/*`, `apps/*`. */
function workspaceManifests(): Array<{ rel: string; json: Record<string, unknown> }> {
  const out: Array<{ rel: string; json: Record<string, unknown> }> = [];
  const add = (rel: string) => {
    const abs = join(REPO, rel);
    if (existsSync(abs)) out.push({ rel, json: JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown> });
  };
  add("package.json");
  for (const dir of ["packages", "apps"]) {
    const base = join(REPO, dir);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      if (statSync(join(base, name)).isDirectory()) add(`${dir}/${name}/package.json`);
    }
  }
  return out;
}

describe("the drizzle-kit generator cannot come back", () => {
  it("found the manifests it means to check", () => {
    // Without this, a walker that silently returned nothing would make every case below pass.
    const found = workspaceManifests().map((m) => m.rel);
    expect(found.length).toBeGreaterThan(10);
    expect(found).toContain("packages/db/package.json");
    expect(found).toContain("package.json");
  });

  it("no package declares `drizzle-kit` in any dependency field", () => {
    const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
    const offenders: string[] = [];
    for (const { rel, json } of workspaceManifests()) {
      for (const field of FIELDS) {
        const deps = json[field] as Record<string, string> | undefined;
        if (deps && "drizzle-kit" in deps) offenders.push(`${rel} → ${field}`);
      }
    }
    expect(offenders, "drizzle-kit is installed again — see STAGE3-DB-SPLIT.md §3a").toEqual([]);
  });

  it("no package declares a migration-generating script", () => {
    const offenders: string[] = [];
    for (const { rel, json } of workspaceManifests()) {
      const scripts = (json.scripts ?? {}) as Record<string, string>;
      for (const [name, body] of Object.entries(scripts)) {
        if (name.startsWith("//")) continue;   // this repo documents scripts as `//name` siblings
        if (name === "generate" || /drizzle-kit/.test(body)) offenders.push(`${rel} → ${name}`);
      }
    }
    expect(offenders, "migrations here are hand-written — see the journal READMEs").toEqual([]);
  });

  it("no `drizzle.config.ts` exists anywhere in the workspace", () => {
    const candidates = ["drizzle.config.ts", "packages/" + "db/drizzle.config.ts",
      "packages/" + "db-mail/drizzle.config.ts"];
    for (const rel of candidates) {
      expect(existsSync(join(REPO, rel)), `${rel} exists — it is the generator's entry point`).toBe(false);
    }
  });

  it.each(JOURNALS.map((d) => [d.slice(REPO.length), d] as const))(
    "%s carries no snapshot files", (_rel, dir) => {
      const meta = join(dir, "meta");
      expect(existsSync(meta), `${dir}/meta is missing`).toBe(true);
      const files = readdirSync(meta);
      // The journal itself must still be there…
      expect(files).toContain("_journal.json");
      // …and nothing else. A snapshot is what makes a wrong generate silent.
      expect(files.filter((f) => f !== "_journal.json"),
        "snapshots are back — a wrong one is silent where a missing one is loud").toEqual([]);
    },
  );

  it.each(JOURNALS.map((d) => [d.slice(REPO.length), d] as const))(
    "%s tells a reader that migrations are hand-written", (_rel, dir) => {
      // The procedure has to live where somebody about to write a migration will look. The
      // strictly-increasing `when` rule in particular: it is the one drizzle-kit did not
      // guarantee either, and it is now nobody's job but the author's.
      const readme = join(dir, "README.md");
      expect(existsSync(readme), `${dir}/README.md is missing`).toBe(true);
      const text = readFileSync(readme, "utf8");
      expect(text).toMatch(/hand-written/i);
      // Either the authoring procedure (the two live journals) or the reason this folder is
      // frozen (the pre-split one). A reader must land on one or the other.
      expect(text).toMatch(/strictly greater|pre-split journal/i);
    },
  );
});
