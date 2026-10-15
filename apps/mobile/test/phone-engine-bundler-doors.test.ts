/**
 * THE PUBLISHED PHONE BUNDLER MUST HAVE A DOOR THE PUBLISHED TREE CAN OPEN.
 *
 * `apps/mobile/scripts/bundle-engine.mjs` is published, and the first step of every phone build
 * runs it. Its acquirer reaches for the workspace's guarded engine builder, which the mirror
 * does NOT publish, so in the published repository that door is always shut. Until this landing
 * the only other door was `OHMAIL_ESBUILD_FROM`, which the workflow does not set — so the mirror's
 * Android build refused on the first release that shipped a bundled engine, with the pinned
 * bundler sitting installed in `node_modules` and never looked at.
 *
 * Measured against a mirror-shaped tree (`git archive` of the mirror + `npm ci`): pre-fix rc 1
 * naming the refusal, post-fix rc 0 with the artifact built, and a checkout carrying a different
 * esbuild refused BY VERSION rather than bundled with.
 *
 * A source assertion, and it says so: what it defends is that the third door and its version check
 * are both still there. The behaviour itself is proved by running the script in a mirror-shaped
 * tree, which is what the release path does.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const src = readFileSync(join(ROOT, "apps/mobile/scripts/bundle-engine.mjs"), "utf8");

describe("the phone engine's bundler can be found in a published checkout", () => {
  it("resolves esbuild from the checkout itself, not only from the private acquirer", () => {
    // The acquirer stays first — the ordinary monorepo run must not change.
    expect(src).toContain("ensure-engine-artifacts.mjs");
    // …and the checkout's own node_modules is a door after it.
    expect(src).toMatch(/createRequire\(join\(root, "noop\.js"\)\)/);
    expect(src).toMatch(/req\("esbuild\/package\.json"\)\.version/);
  });

  it("checks the version rather than trusting whatever is installed", () => {
    // A different bundler produces a different artifact, and the difference is not visible in the
    // output — so the door refuses by version instead of bundling with it.
    expect(src).toMatch(/if \(v === ESBUILD_VERSION\) return root;/);
    expect(src).toContain("this checkout has esbuild ${v}, and the phone engine is reproducible for ${ESBUILD_VERSION}");
  });

  it("still refuses, naming the command, when no door opens", () => {
    expect(src).toContain("and this checkout has no way to fetch it");
    expect(src).toContain("OHMAIL_ESBUILD_FROM=$D node apps/mobile/scripts/bundle-engine.mjs");
  });
});
