import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE UMBREL DRAFT SAYS IT IS STALE WHILE IT PINS AN OLDER RELEASE. The package is not submitted
 * anywhere and pins images several releases behind the one this tree ships, yet its README called it
 * "submission-ready". Nothing bumps it per release (a gap row), so while its manifest `version` is not
 * the root package version, the README and the manifest both say so; a repin to the current release
 * is the only thing that may drop the note, and then it must go.
 */
const at = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string): string => readFileSync(at(rel), "utf8");
const RELEASE = (JSON.parse(read("../package.json")) as { version: string }).version;
const MANIFEST = read("../deploy/umbrel/ohmail/umbrel-app.yml");
const README = read("../deploy/umbrel/README.md");
const COMPOSE = read("../deploy/umbrel/ohmail/docker-compose.yml");

const pinned = /^version:\s*"([^"]+)"/m.exec(MANIFEST)?.[1];
const STALE = /\bstale\b/i;

describe("the Umbrel draft package states how current it is", () => {
  it("reads a pinned version, and the compose pulls that version of all three images", () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    for (const image of ["ohmail-web", "ohmail-server", "ohmail-worker"]) {
      expect(COMPOSE).toContain(`ghcr.io/trafficflowhq/${image}:${pinned}@sha256:`);
    }
  });

  it("while it pins another release, the README and the manifest say it is stale and not ready", () => {
    if (pinned === RELEASE) {
      expect(README).not.toMatch(STALE);
      expect(MANIFEST).not.toMatch(STALE);
      return;
    }
    expect(README).toMatch(STALE);
    expect(README).toContain(`pins ${pinned}`);
    expect(README).not.toMatch(/submission-ready/i);
    expect(MANIFEST).toMatch(STALE);
  });
});
