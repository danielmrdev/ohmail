import { describe, it, expect } from "vitest";

import { FLATHUB_VERIFICATION, STATIC_REWRITES, rewritesFor } from "../routes.mjs";

/**
 * WHO OWNS A REWRITE ENTRY ONCE IT LEAVES `rewritesFor`.
 *
 * The route table is frozen on purpose: the freeze is the claim that nothing edits the split at
 * runtime. Next does not read it that way. `next/dist/lib/load-custom-routes.js` writes
 * `route.source` and `route.destination` on every rewrite it loads, so a frozen entry handed
 * over kills the build with `Cannot assign to read only property 'source'`.
 *
 * That failure needs an ARMED build to appear — `rewritesFor(null)` returns `[]` and never
 * reaches the entries — and every build gate runs unarmed, so it reached main and sat there.
 * The two readings below are therefore the point of this file: Next's OWN loader, driven
 * against the real answer, and the property that makes it work.
 */
const ARMED = "http://127.0.0.1:3002";

/** Next's loader, as a value — a CJS default behind an ESM default in this build. */
async function nextLoadCustomRoutes(): Promise<
  (config: unknown) => Promise<{ rewrites: { afterFiles: Array<{ source: string }> } }>
> {
  const mod = (await import("next/dist/lib/load-custom-routes.js")) as unknown as {
    default: unknown;
  };
  const inner = (mod.default as { default?: unknown }).default ?? mod.default;
  return inner as (config: unknown) => Promise<{ rewrites: { afterFiles: Array<{ source: string }> } }>;
}

describe("the rewrites answer is Next's to mutate", () => {
  it("is accepted by Next's own loadCustomRoutes when armed — the build's real consumer", async () => {
    const loadCustomRoutes = await nextLoadCustomRoutes();
    const loaded = await loadCustomRoutes({
      rewrites: async () => rewritesFor(ARMED),
      basePath: "",
      trailingSlash: false,
    });
    // Nothing is lost on the way through: the Flathub rewrite and the three armed ones arrive
    // (the `/api` proxy, the refresh door and the sign-out door below it).
    expect(loaded.rewrites.afterFiles.map((r) => r.source)).toEqual(
      rewritesFor(ARMED).map((r) => r.source),
    );
    expect(loaded.rewrites.afterFiles).toHaveLength(4);
  });

  it("hands out entries a `source` assignment succeeds on, for every armed origin", () => {
    for (const origin of [ARMED, "https://api.ohmail.app"]) {
      const entries = rewritesFor(origin);
      expect(entries.length, `${origin} returned no rewrites`).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(Object.isFrozen(entry), `${entry.source} left the table frozen`).toBe(false);
        // The assignment load-custom-routes.js makes, verbatim in shape.
        expect(() => {
          entry.source = `/prefix${entry.source}`;
          entry.destination = `${entry.destination}`;
        }).not.toThrow();
      }
    }
  });

  it("copies rather than thaws — the table is still the frozen source of truth", () => {
    // The positive control for the freeze itself: remove it and this reads false, and the
    // claim that nothing edits the split at runtime stops being enforced anywhere.
    expect(Object.isFrozen(STATIC_REWRITES)).toBe(true);
    expect(Object.isFrozen(FLATHUB_VERIFICATION)).toBe(true);
    for (const entry of STATIC_REWRITES) expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (STATIC_REWRITES[0] as { source: string }).source = "/edited";
    }).toThrow(TypeError);

    // …and what leaves is a different object with the same content.
    const handed = rewritesFor(ARMED)[0];
    expect(handed).not.toBe(STATIC_REWRITES[0]);
    expect(handed).toEqual(STATIC_REWRITES[0]);
  });

  it("returns [] unarmed — the state that kept this off every build gate", () => {
    expect(rewritesFor(null)).toEqual([]);
    expect(rewritesFor("")).toEqual([]);
  });
});
