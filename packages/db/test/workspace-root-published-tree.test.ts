import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { workspaceRootFrom } from "../src/testing.js";

/**
 * THE LANE DATABASE IS FOUND IN BOTH TREES. `.lane-db.env` is read from the workspace root, and the
 * published tree is an npm workspace with no `pnpm-workspace.yaml`: a walk that knew only the pnpm
 * file found no root there, so every pg file resolved to the shared database and refused at collection.
 */
const scratch = mkdtempSync(join(tmpdir(), "ohmail-ws-root-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function tree(name: string, rootFiles: Record<string, string>): { root: string; src: string } {
  const root = join(scratch, name);
  const src = join(root, "packages", "db", "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(root, "packages", "db", "package.json"), JSON.stringify({ name: "@trafficflow/db" }));
  for (const [f, text] of Object.entries(rootFiles)) writeFileSync(join(root, f), text);
  return { root, src };
}

describe("the workspace root a lane database is read from", () => {
  it("is the directory holding pnpm-workspace.yaml in the development tree", () => {
    const t = tree("pnpm", { "pnpm-workspace.yaml": "packages:\n  - packages/*\n", "package.json": "{}" });
    expect(workspaceRootFrom(t.src)).toBe(t.root);
  });

  it("is the package.json declaring workspaces in the published tree, past a package's own manifest", () => {
    const t = tree("npm", { "package.json": JSON.stringify({ name: "ohmail-desktop", workspaces: ["packages/db"] }) });
    expect(workspaceRootFrom(t.src)).toBe(t.root);
  });

  it("is nothing where neither marker stands, and a manifest without workspaces is not one", () => {
    const t = tree("none", { "package.json": JSON.stringify({ name: "x" }) });
    expect(workspaceRootFrom(t.src)).toBeNull();
    const broken = tree("broken", { "package.json": "{ not json" });
    expect(workspaceRootFrom(broken.src)).toBeNull();
  });
});
