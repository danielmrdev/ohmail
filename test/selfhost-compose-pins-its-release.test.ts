import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE PUBLISHED COMPOSE PULLS THE RELEASE IT SHIPS WITH. The three ohmail images defaulted to
 * `latest`, and a release moves `latest` three registry writes after its version tags, so a pull in
 * that window could pair a new server with an old organizer. Each default is now the root
 * package version, so the release's version bump (`chore(release): <version>`, which moves the root
 * `package.json`) must move these three lines too, or this file is red.
 */
const at = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const VERSION = (JSON.parse(readFileSync(at("../package.json"), "utf8")) as { version: string }).version;
const COMPOSE = readFileSync(at("../deploy/selfhost/docker-compose.yml"), "utf8");

const IMAGES = ["ohmail-web", "ohmail-server", "ohmail-worker"] as const;

describe("deploy/selfhost/docker-compose.yml pins its own release", () => {
  it("the root version is a bare release number", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each(IMAGES)("%s defaults to the root package version, and nothing else pins it", (image) => {
    const lines = COMPOSE.split("\n").filter((l) => /^\s*image:/.test(l) && l.includes(`/${image}:`));
    expect(lines, `${image} is not pulled exactly once`).toHaveLength(1);
    expect(lines[0]!.trim()).toBe(`image: ghcr.io/trafficflowhq/${image}:\${OHMAIL_IMAGE_TAG:-${VERSION}}`);
  });

  it("no image line defaults to latest, and the header says what the default is", () => {
    expect(COMPOSE).not.toMatch(/OHMAIL_IMAGE_TAG:-latest/);
    expect(COMPOSE).not.toMatch(/default: latest/);
  });
});
