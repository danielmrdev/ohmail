import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* Untyped module, read through one typed door rather than a second declaration file. */
const bundler = (await import(new URL("../scripts/engine-bundle.mjs", import.meta.url).href)) as {
  ROOT: string; buildOptionsFor(root: string): { define?: Record<string, string> };
};
const { ROOT, buildOptionsFor } = bundler;

/**
 * THE DESKTOP ENGINE CARRIES THE APP VERSION AS ITS BUILD LABEL. A shell built from a tree with no
 * `.git` and no `GITHUB_SHA` (the Flatpak's `type: dir` source skips `.git`) sends `unknown`, and the
 * engine then had no label: its write-offs read `dev` on every release, so a deterministic one and a
 * held backstop were never read again. The bundler bakes `apps/desktop/package.json`'s version,
 * which `engineBuildLabel` falls back to (VERIFY-026-PHONE-ONE-MESSAGE-B L2).
 */
describe("the desktop engine bundle's build label", () => {
  it("defines the desktop app's version, the one the release bump writes", () => {
    const version = (JSON.parse(readFileSync(join(ROOT, "apps", "desktop", "package.json"), "utf8")) as { version: string }).version;
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(buildOptionsFor(ROOT).define)
      .toEqual({ __OHMAIL_ENGINE_VERSION__: JSON.stringify(version) });
  });
});
