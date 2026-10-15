/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE CONNECTION LAYER'S DECIDED STATE — the ordering that decided whether a phone syncs
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured on a release build, over this lane's own GreenMail: the standalone door opened, the
 * engine authenticated and imported two messages into its own store, and the app's mirror held
 * `entities 0` while `organize_consented_at` was NULL and the `ohmail/*` tree never appeared.
 *
 * The cause is one ordering. `net/connection.tsx` kept `live.current = state` in the component
 * BODY, so the ref every late answer reads moved when React PAINTED. `setState` from an async body
 * is a scheduled task; the work that follows `adopt` on the standalone door settles in microtasks —
 * `verifyIdentity()` answers `{ kind: "unverified" }` immediately, because an engine in this
 * process mounts no `/auth/session`, and the roster read is a call into `handle`. So the identity
 * verdict and the consent press both read `k: "connecting"` and returned: the verdict as `false`,
 * which skips the first drain for ever, and the press with no sentence on any surface.
 *
 * ── WHY NOTHING COULD SEE IT, WHICH IS WHY THE RULE IS HERE AND NOT IN A RENDER TEST ──────
 *
 * A PAIRED door cannot reach it: there the identity probe is a real request, so the paint always
 * lands first — and every paired arm was green. And this workspace has no React Native renderer at
 * all (`test/unsaved-changes.test.ts` measured the absence), so the one place React's scheduling
 * decided whether a mailbox syncs was reachable by no test in the repository.
 *
 * So the fix is a value the layer owns (`net/decided.ts`), and this file holds both halves:
 *
 *  1. the ORDERING, driven — `enter` records before it paints, so a reader that runs between the
 *     two sees the decided state. The device's shape is faked by DEFERRING the paint, which is
 *     exactly what React does.
 *  2. a CENSUS over `connection.tsx` — every state change goes through `enter`, and nothing
 *     assigns the ref a second time. A rule inside a component is a rule no test can drive, so
 *     the rule becomes a scan.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { decidedState } from "../src/net/decided";

const CONNECTION = fileURLToPath(new URL("../src/net/connection.tsx", import.meta.url));

/** Comments and strings blanked, so a rule quoted in prose is not a rule broken in code. */
function code(body: string): string {
  let out = "";
  let i = 0;
  let mode: "code" | "line" | "block" | "s" | "d" | "t" = "code";
  while (i < body.length) {
    const ch = body[i]!;
    const next = body[i + 1];
    if (mode === "code") {
      if (ch === "/" && next === "/") { mode = "line"; out += "  "; i += 2; continue; }
      if (ch === "/" && next === "*") { mode = "block"; out += "  "; i += 2; continue; }
      if (ch === "'") { mode = "s"; out += " "; i += 1; continue; }
      if (ch === '"') { mode = "d"; out += " "; i += 1; continue; }
      if (ch === "`") { mode = "t"; out += " "; i += 1; continue; }
      out += ch; i += 1; continue;
    }
    if (mode === "line") {
      if (ch === "\n") { mode = "code"; out += "\n"; } else out += " ";
      i += 1; continue;
    }
    if (mode === "block") {
      if (ch === "*" && next === "/") { mode = "code"; out += "  "; i += 2; continue; }
      out += ch === "\n" ? "\n" : " "; i += 1; continue;
    }
    // a string body: `\x` consumes two, the closing quote returns to code
    if (ch === "\\") { out += "  "; i += 2; continue; }
    const close = mode === "s" ? "'" : mode === "d" ? '"' : "`";
    if (ch === close) { mode = "code"; out += " "; i += 1; continue; }
    out += ch === "\n" ? "\n" : " "; i += 1;
  }
  return out;
}

describe("the decided state, before the paint", () => {
  it("has MOVED by the time the paint is called — the device's ordering", () => {
    /* THE DEVICE'S SHAPE: the paint is DEFERRED, exactly as React defers a render. A reader that
       runs in the gap is the identity verdict and the consent press. */
    const painted: string[] = [];
    const deferred: string[] = [];
    const decided = decidedState<{ k: string }>({ k: "starting" }, (next) => {
      /* Read INSIDE the paint call, before it has any effect. This is the gap. */
      deferred.push(decided.now().k);
      setTimeout(() => painted.push(next.k), 0);
    });

    decided.enter({ k: "live" });

    expect(decided.now().k, "a reader after `enter` sees the state the layer decided").toBe("live");
    expect(deferred, "the value had not moved when the paint was called").toEqual(["live"]);
    expect(painted, "the paint is deferred, as React defers it").toEqual([]);
  });

  it("is the LAST decision, not the last paint — two decisions in one tick", () => {
    /* The shape a render-time mirror gets wrong in the other direction: React renders with the
       state it is committing, so a body assignment would write the OLDER of two decisions over the
       newer one. A reader must see what the layer decided last. */
    const decided = decidedState<{ k: string }>({ k: "starting" }, () => { /* never paints */ });
    decided.enter({ k: "connecting" });
    decided.enter({ k: "live" });
    expect(decided.now().k).toBe("live");
  });

  it("keeps the decision when the paint THROWS, and re-raises", () => {
    /* A render that failed must not leave the layer acting on a state it abandoned; and a failing
       renderer is not this module's to swallow. */
    const decided = decidedState<{ k: string }>({ k: "starting" }, () => {
      throw new Error("the renderer refused");
    });
    expect(() => decided.enter({ k: "live" })).toThrow(/renderer refused/u);
    expect(decided.now().k).toBe("live");
  });

  /**
   * THE CONTROL, and it is the reading the whole file rests on: the OLD shape, driven the same
   * way, answers the stale state. Without this the three cases above measure a helper that could
   * have been written any way at all.
   */
  it("(control) a mirror written by the PAINT answers the stale state in the same gap", () => {
    let mirror: { k: string } = { k: "starting" };
    const paint = (next: { k: string }): void => {
      /* The body assignment, as `connection.tsx` had it: it happens when the render runs. */
      setTimeout(() => { mirror = next; }, 0);
    };
    paint({ k: "live" });
    expect(mirror.k, "this is the device reading: `connecting` where the layer had decided `live`")
      .toBe("starting");
  });
});

describe("connection.tsx routes every state change through the decided state", () => {
  const body = code(readFileSync(CONNECTION, "utf8"));

  it("names `decidedState` and takes `enter` off it", () => {
    expect(body, "the layer must own its state").toMatch(/\bdecidedState\s*[<(]/u);
    expect(body, "`enter` is the one writer").toMatch(/\bconst\s+enter\s*=\s*\w+\.enter\b/u);
  });

  it("has NO bare `setState(` outside the one handed to `decidedState`", () => {
    /* The defect's other half: one `setState` left behind is one state change the decided value
       does not know about, and every late answer after it reads a stale state. */
    const calls = [...body.matchAll(/(?<![.\w])setState\s*\(/gu)];
    expect(calls, "a state change written around `enter`").toHaveLength(0);
    /* THE POSITIVE CONTROL for that scan: the setter IS handed over, so the assertion above is
       about call sites and not about the name being absent from the file. */
    expect(body, "the React setter must reach `decidedState`").toMatch(/decidedState<[^>]*>\([^)]*setState\s*\)/u);
  });

  it("never assigns the ref a second time — the render-time mirror is gone", () => {
    expect(body, "a render-time assignment is the defect itself")
      .not.toMatch(/\blive\.current\s*=\s*state\b/u);
  });

  it("every staleness check reads the DECIDED state", () => {
    /* `live.now()` and nothing else: a check against React's rendered state is the same defect
       under a different name. */
    expect([...body.matchAll(/\blive\.now\(\)/gu)].length,
      "the staleness checks no longer read the decided state").toBeGreaterThanOrEqual(10);
  });
});
