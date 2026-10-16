import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * THE ALLOCATOR CAP HAS ONE HOME PER DEPLOYMENT SHAPE, AND THESE ARE THE SERVER SHAPES.
 *
 * glibc hands a contending thread its own 64 MB arena and returns those bytes only from the top of
 * one, so a burst stays resident — measured on the local engine as a clear step up in `rss` with the
 * JS heap FALLING across it. `MALLOC_ARENA_MAX` is read at process start, so it belongs in the
 * environment the process is STARTED with: the shell's child on the desktop, an `ENV` line here.
 * This test is what keeps a fourth image, or a rewritten stage, from shipping without one.
 */
const ROOT = new URL("../", import.meta.url).pathname;

/**
 * The value, and it is the ENGINE's — measured on the process that runs the local mirror. The
 * images here talk to a real Postgres rather than a WASM one, so their own allocation profile is
 * NOT what decided this number; it is the same constant by decision, and a reading of the worker's
 * own throughput under it is owed.
 */
const ARENA_CAP = 2;

/** Every image whose process runs mail code. The webapp's is a Next server and carries no mail. */
const IMAGES = [
  "apps/worker/Dockerfile",
  "apps/worker/Dockerfile.selfhost",
  "apps/server/Dockerfile",
];

function envLines(file: string): string[] {
  return readFileSync(`${ROOT}${file}`, "utf8")
    .split("\n")
    .filter((l) => /^ENV\s/.test(l.trim()));
}

describe("every server image starts its process with the allocator cap", () => {
  it.each(IMAGES)("%s sets MALLOC_ARENA_MAX", (file) => {
    const hit = envLines(file).find((l) => /MALLOC_ARENA_MAX/.test(l));
    expect(hit, `${file} starts its process with no allocator cap`).toBeDefined();
    expect(hit).toMatch(new RegExp(`MALLOC_ARENA_MAX=["']?${ARENA_CAP}["']?\\s*$`));
  });

  it("the three images carry ONE value, never a drift", () => {
    const values = IMAGES.map((f) => {
      const hit = envLines(f).find((l) => /MALLOC_ARENA_MAX/.test(l));
      return /MALLOC_ARENA_MAX=["']?(\d+)/.exec(hit ?? "")?.[1];
    });
    expect(new Set(values).size, `the images disagree: ${JSON.stringify(values)}`).toBe(1);
    expect(values[0]).toBe(String(ARENA_CAP));
  });

  /**
   * The cap must be in the RUNTIME stage, not a build stage — a build-stage `ENV` does not reach
   * the process the image starts, which is the whole failure this test exists to prevent and is
   * invisible to every local run.
   */
  it.each(IMAGES)("%s sets it in the stage that carries the CMD", (file) => {
    const text = readFileSync(`${ROOT}${file}`, "utf8");
    const cap = text.lastIndexOf("MALLOC_ARENA_MAX");
    /* The LAST `FROM`, not the one before the cap. The first version of this arm took the nearest
       preceding stage, which every build-stage `ENV` also satisfies — moving the cap into the build
       stage left it GREEN, and a build-stage `ENV` reaches no process at all. */
    const finalStage = text.lastIndexOf("\nFROM ");
    const cmd = text.lastIndexOf("\nCMD ");
    expect(cap, `${file} has no cap at all`).toBeGreaterThan(-1);
    expect(cap, `${file} sets the cap in a build stage, which no process ever reads`).toBeGreaterThan(finalStage);
    expect(cap, `${file} sets the cap after its CMD`).toBeLessThan(cmd);
  });

  /**
   * ANTI-VACUITY: the phone's standalone engine is NOT on this list and must not be, because its
   * runtimes are bionic and libmalloc — neither reads this variable. A test that swept "every
   * runtime" would quietly claim a cap where none can exist.
   */
  it("names only the shapes whose runtime is glibc", () => {
    expect(IMAGES.some((f) => /mobile|phone/.test(f))).toBe(false);
    expect(IMAGES).toHaveLength(3);
  });
});
