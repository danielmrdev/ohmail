import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

// NODE RUNS THE FILE THE EXPORTS MAP NAMES, AND SOME OF THEM ARE SOURCE.
//
// Nine `@trafficflow/core` leaves point at `src/*.ts` on purpose: a browser graph bundles them
// and wants the source. Node does not bundle. It resolves the specifier to the .ts, strips the
// types, and then has to resolve THAT file's own relative imports — and `./types.js` beside a
// .ts file does not exist on disk. 0.16.2 shipped that into a worker image: green build,
// `ERR_MODULE_NOT_FOUND` at boot.
//
// The remedy is a `node` condition on the leaf, so plain Node takes the compiled twin while every
// bundler keeps taking `default` (the source). This census holds the invariant that makes the
// class unrepresentable rather than pinning the two names that had it: a leaf Node resolves to
// `src/` may carry no relative import. `apps/worker/test/dist-import-graph.test.ts` is the
// expensive half — it starts the built worker and reads its stderr.
const ROOT = new URL("../", import.meta.url).pathname;

// The roots whose modules Node executes unbundled. A browser graph is NOT one of them.
const NODE_ROOTS = [
  "apps/worker/src",
  "packages/db/src",
  "packages/api/src",
  "packages/services/src",
  "apps/api-vercel/src",
];

/** The target PLAIN NODE picks: the conditions it matches, in the map's own key order. */
function nodeTarget(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    for (const [k, t] of Object.entries(v as Record<string, unknown>)) {
      // `types` is TypeScript's, not Node's — Node skips it and reads the next key.
      if (["node", "import", "default"].includes(k) && typeof t === "string") return t;
    }
  }
  return undefined;
}

/** The target a BUNDLER picks, which must stay the source — the whole reason these leaves exist. */
function defaultTarget(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const t = (v as Record<string, unknown>).default;
    if (typeof t === "string") return t;
  }
  return undefined;
}

const relativeImports = (src: string) =>
  [...new Set([...src.matchAll(/from\s+"(\.\.?\/[^"]+)"/g)].map((m) => m[1]))];

/** Leaf name -> the relative imports its source carries, for every leaf Node resolves into `src/`. */
function unfollowableIn(exports: Record<string, unknown>, dir = `${ROOT}packages/core/`): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [name, value] of Object.entries(exports)) {
    const target = nodeTarget(value);
    if (!target || !target.includes("/src/")) continue;
    const rel = relativeImports(readFileSync(`${dir}${target.replace(/^\.\//, "")}`, "utf8"));
    if (rel.length > 0) out.set(name.replace(/^\.\//, ""), rel);
  }
  return out;
}

const coreExports = () =>
  (JSON.parse(readFileSync(`${ROOT}packages/core/package.json`, "utf8")) as
    { exports: Record<string, unknown> }).exports;

function tsFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const e of entries) {
    const p = `${dir}/${e}`;
    if (statSync(p).isDirectory()) { tsFiles(p, acc); continue; }
    if (/\.(ts|tsx)$/.test(e)) acc.push(p);
  }
  return acc;
}

describe("no core leaf resolves, under Node, to a source file Node cannot follow", () => {
  it("every leaf Node resolves into src/ is free of relative imports", () => {
    // THE INVARIANT. A leaf whose Node target is source may only be a module with no relative
    // import of its own — seven of the nine are exactly that. The two that are not (`folder-name`
    // and `destinations`, both on `./types.js`) carry a `node` condition instead, which moves
    // their Node target out of `src/` and out of this set.
    const unfollowable = unfollowableIn(coreExports());
    expect([...unfollowable].map(([l, r]) => `${l} -> ${r.join(", ")}`),
      "give each of these leaves a `node` condition pointing at its ./dist twin, or remove the"
      + " relative import; as they stand, importing one from a Node program is ERR_MODULE_NOT_FOUND"
      + " at boot with a green build behind it").toEqual([]);
  });

  it("the deriver flags a leaf that does have one", () => {
    /* The case above is a 0-ceiling, so it must be watched finding something or it is decoration:
     * the same deriver over a map shaped like the one 0.16.2 shipped. `folder-name.ts` is the real
     * file and really does import `./types.js` — only the exports entry is synthetic. */
    const shipped = unfollowableIn({ "./folder-name": "./src/folder-name.ts" });
    expect([...shipped.keys()]).toEqual(["folder-name"]);
    expect(shipped.get("folder-name")).toEqual(["./types.js"]);
    // And a `node` condition on that same entry takes it back out.
    expect([...unfollowableIn({
      "./folder-name": { node: "./dist/folder-name.js", types: "./dist/folder-name.d.ts", default: "./src/folder-name.ts" },
    }).keys()]).toEqual([]);
  });

  it("a leaf with a node condition keeps `types` AND `default` on the source, and its dist twin is buildable", () => {
    /* `default` is what every bundler takes AND what the publisher's manifest trimmer reads to
     * render the mirror's manifest, where there is no `dist/` at all. A `default` moved to dist
     * would put build output into the browser graph and publish a manifest naming files the
     * mirror does not carry.
     *
     * `types` ahead of `node` is the second half, a ruling rather than a mechanism: the type layer
     * reads SOURCE, so a `dist/` nobody rebuilt can never be believed by a typecheck. Measured both
     * ways — with `types` on dist a mutated `dist/types.d.ts` reddens
     * `apps/webapp/app/shell/FoldersRailGroup.tsx`; with it on src the same mutation is invisible.
     *
     * Scoped to leaves carrying a `node` key rather than to every conditional entry: a future leaf
     * could take a condition for another reason, and refusing that would be unsatisfiable. */
    const withNode = Object.entries(coreExports())
      .filter(([, v]) => typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).node === "string");
    expect(withNode.length, "no leaf carries a `node` condition — the fix is gone").toBeGreaterThan(0);
    for (const [name, value] of withNode) {
      const node = nodeTarget(value), dflt = defaultTarget(value);
      const types = (value as Record<string, unknown>).types;
      expect(dflt, `${name}: \`default\` is what bundlers and the mirror's manifest read — it stays on the source`)
        .toMatch(/^\.\/src\/.*\.ts$/);
      expect(types, `${name}: \`types\` is what every typecheck reads — it stays on the source, ahead of \`node\``)
        .toMatch(/^\.\/src\/.*\.ts$/);
      // Key ORDER, not just presence: Node skips `types`, so a `node` placed FIRST would take the
      // compiled twin for tsc too and put the type layer back on a build output.
      const keys = Object.keys(value as Record<string, unknown>);
      expect(keys.indexOf("types"), `${name}: \`types\` must come before \`node\` (keys: ${keys.join(", ")})`)
        .toBeLessThan(keys.indexOf("node"));
      expect(node, `${name}: \`node\` must be the compiled twin`).toMatch(/^\.\/dist\/.*\.js$/);
      // The source `tsc -b` compiles into that dist path, under the core package tsconfig's
      // `include: ["src"]`. Asserted on disk rather than on a build, so this needs none.
      const twin = `${ROOT}packages/core/${node!.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts")}`;
      expect(existsSync(twin), `${name}: \`node\` names ${node}, and ${twin.slice(ROOT.length)} is absent`).toBe(true);
    }
  });

  it("and no module under a Node root names a leaf Node cannot follow", () => {
    // The second line of defence: empty above means empty here, and it stays readable if a leaf
    // ever legitimately keeps a relative import on a source-only target.
    const unfollowable = unfollowableIn(coreExports());
    const offences: string[] = [];
    for (const root of NODE_ROOTS) {
      for (const file of tsFiles(`${ROOT}${root}`)) {
        const src = readFileSync(file, "utf8");
        for (const leaf of unfollowable.keys()) {
          const rx = new RegExp(`from\\s+"@trafficflow/core/${leaf}"`);
          if (rx.test(src)) offences.push(`${file.slice(ROOT.length)} imports @trafficflow/core/${leaf}`);
        }
      }
    }
    expect(offences, `these would fail at boot with ERR_MODULE_NOT_FOUND:\n  ${offences.join("\n  ")}`)
      .toEqual([]);
  });

  it("reads the roots it claims to read", () => {
    // A census that walked nothing would pass the case above for the wrong reason.
    for (const root of NODE_ROOTS) {
      expect(tsFiles(`${ROOT}${root}`).length, `${root} yielded no TypeScript files`).toBeGreaterThan(0);
    }
  });
});
