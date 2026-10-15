import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * THE MAIL AND THE CONNECTION DO NOT SHARE A MEMO OWNER.
 *
 * `world.tsx` used to derive everything in one memo whose dependencies included `conn.syncing`. A
 * poll walks that value connecting → syncing → idle, so every tick re-derived the partition, both
 * shelves, the piles, History, the tags, the scheduled list and the folder lists — over a mirror
 * that had not moved. The projection is now its own memo, keyed on what the MAILBOX does, and the
 * boot facts are read per render in a second, cheap one.
 *
 * Asserted over the SOURCE, like every other surface claim in this workspace: there is no React
 * Native renderer here (see `cutline-unanswered.test.ts`). Comments are blanked through the
 * repository's one scanner first — a dependency array that survives only in prose is not one.
 */

const SRC = fileURLToPath(new URL("../src/state/world.tsx", import.meta.url));
const code = withoutComments(readFileSync(SRC, "utf8"));

/** The body and the dependency array of the memo that starts at `head`. */
function memo(source: string, head: string): { body: string; deps: string } {
  const start = source.indexOf(head);
  if (start < 0) throw new Error(`no memo starting ${head}`);
  const depsAt = source.indexOf("}, [", start);
  if (depsAt < 0) throw new Error(`no dependency array after ${head}`);
  const end = source.indexOf("]);", depsAt);
  return { body: source.slice(start, depsAt), deps: source.slice(depsAt, end) };
}

/** What a memo may not depend on if it is to survive a poll over an unchanged mailbox. */
const CONNECTION_DEPS = ["conn.syncing", "conn.syncError"];

describe("the phone's world", () => {
  it("derives the mailbox in a memo the connection cannot move", () => {
    const { deps } = memo(code, "const projected = useMemo<");
    // The mirror's DERIVED stamp (bodies excluded) is the dependency that re-derives it; the raw
    // version, which every body write moves, is not.
    expect(deps).toContain("derivedStamp");
    expect(deps).not.toMatch(/\bversion\b/);
    for (const d of CONNECTION_DEPS) expect(deps, `projection depends on ${d}`).not.toContain(d);
  });

  it("keeps the heavy derivations in the projector and out of the assembly", () => {
    const projection = memo(code, "const projected = useMemo<").body;
    const assembly = memo(code, "const world = useMemo<World>").body;
    const projector = withoutComments(readFileSync(fileURLToPath(new URL("../src/state/world-projection.ts", import.meta.url)), "utf8"));
    expect(projection, "the memo body is the projector's run").toContain("projector.project(");
    for (const call of ["presentedWorld(", "livePiles(", "historyRow(", "liveScreener(", "liveTags("]) {
      expect(projector, `${call} belongs to the projector`).toContain(call);
      expect(projection, `${call} must run in the projector, not the provider`).not.toContain(call);
      expect(assembly, `${call} must not run per connection change`).not.toContain(call);
    }
  });

  /**
   * THE COUNTERWEIGHT, and it matters as much as the claim. The settled stamp lands as a drain
   * completes and `conn.syncing` falls, and the label has to clear in the SAME pass — so the
   * assembly still depends on it. What the split changed is what that dependency COSTS.
   */
  it("still re-reads the boot facts when the connection moves", () => {
    const { body, deps } = memo(code, "const world = useMemo<World>");
    for (const d of CONNECTION_DEPS) expect(deps).toContain(d);
    expect(body).toContain("mirrorSettled(");
    expect(body).toContain("staleAsOf(");
    expect(body).toContain("connectionSay(");
  });

  /**
   * THE REFUSAL ARM, over a subject that HAS the property under test: the same predicate, run on a
   * projection that took the connection back.
   */
  it("would refuse a projection that depended on the connection", () => {
    const rogue = code.replace(
      "  }, [engine, projector, session, scopes, zone, locale, actions, derivedStamp, freshBeat,",
      "  }, [engine, projector, session, scopes, zone, locale, actions, derivedStamp, freshBeat, conn.syncing,",
    );
    expect(rogue).not.toBe(code);
    const { deps } = memo(rogue, "const projected = useMemo<");
    expect(deps).toContain("conn.syncing");
  });
});
