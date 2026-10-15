import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bracketSpan, withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A CONFIRMED PAIRING LANDS IN THE MAILBOX — both doors, one rule
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Both pairing doors replaced the route with `/servers` once the confirm succeeded. `/connect`
 * and `/scan` are pushed from `/welcome` on a first run and from `/servers` itself through
 * Settings, and the two replace each other — so after the replace the Servers pane sat on a
 * stack with nothing under it to pop into. On a device that is a person who has just paired,
 * pressing Back six times and edge-swiping, and getting out only by killing the app. The
 * standalone door has always replaced with `/` at the same point; this is that rule, stated once
 * for all three.
 *
 * ── HOW IT IS MEASURED, AND WHY NOT BY MOUNTING ────────────────────────────────────────────
 *
 * There is no React Native renderer in this workspace — `react-test-renderer` and
 * `@testing-library/react-native` are absent from the store, which `test/unsaved-changes.test.ts`
 * pins as a shared-file decision — so no test here mounts a screen. A substring census alone is
 * the weak instrument: it cannot tell the route inside the success branch from a route anywhere
 * else in the file.
 *
 * So the handler is EXTRACTED and RUN. §1 reads each door's `confirm` callback out of its own
 * source through the repository's one scanner, §2 evaluates that exact text with `setPhase`,
 * `pressed`, `conn` and `router` injected and drives both outcomes through it, and §3 puts the
 * shipped defect back in a fixture and requires both halves to refuse it by name. §4 is the
 * anti-vacuity half: an extractor that returned nothing would satisfy every "did not route to
 * the pane" assertion above and mean nothing at all.
 */

/* @reads: apps/mobile/app/standalone.tsx
   Read by a path built at runtime, so no landing pass selects this file when that source
   moves — the shape `reads-list.mjs` exists for. */

const DOORS = {
  connect: fileURLToPath(new URL("../app/connect.tsx", import.meta.url)),
  scan: fileURLToPath(new URL("../app/scan.tsx", import.meta.url)),
} as const;

/** The mailbox, and the pane a confirmed pairing may not be left on. */
const MAILBOX = '"/"';
const PANE = '"/servers"';

type Door = { fn: string; ok: string };

/**
 * The `confirm` callback's function expression, and the body of its success branch.
 *
 * Positions are preserved by the scanner, so every index found in the blanked reading slices the
 * ORIGINAL text — which is what §2 then executes. A runaway bracket is returned rather than
 * clamped, and both are refused here: a span that never closed is a reading of the rest of the
 * file, not of a handler.
 */
function doorOf(src: string): Door {
  const blank = withoutCommentsAndLiterals(src);
  const at = blank.indexOf("const confirm = useCallback(");
  if (at === -1) throw new Error("no `const confirm = useCallback(` in this file");
  const call = bracketSpan(blank, blank.indexOf("(", at));
  if (!call.closed) throw new Error("the useCallback( never closed");

  /* The dependency array is the LAST top-level argument; everything before it is the handler. */
  let depth = 0;
  let comma = -1;
  for (let i = call.start; i < call.end; i++) {
    const c = blank[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) comma = i;
  }
  if (comma === -1) throw new Error("the useCallback( has no dependency array");
  const fn = src.slice(call.start, comma);

  const branch = blank.indexOf("if (outcome.ok) {", call.start);
  if (branch === -1 || branch > comma) throw new Error("no `if (outcome.ok) {` success branch");
  const body = bracketSpan(blank, blank.indexOf("{", branch), "{", "}");
  if (!body.closed) throw new Error("the success branch never closed");
  return { fn, ok: src.slice(body.start, body.end) };
}

type Router = { replace: (p: string) => void; push: (p: string) => void; back: () => void };
type Phase = Record<string, unknown>;
type Run = { routed: string[][]; phases: Phase[]; spent: unknown[][]; pressed: boolean };

/**
 * THE EXTRACTED HANDLER, RUN. `new Function` over the door's own bytes with the four names it
 * closes over supplied — nothing is re-typed here, so a handler that stops doing what §1 reads
 * cannot pass §2. The compile is the parse: a body that is not plain JavaScript throws by name.
 */
async function press(fn: string, outcome: unknown, presses = 1): Promise<Run> {
  const run: Run = { routed: [], phases: [], spent: [], pressed: false };
  const pressed = { current: false };
  let phase: Phase = { k: "confirming", admission: { origin: "https://example.invalid" }, token: "t", busy: false };
  const setPhase = (next: Phase | ((p: Phase) => Phase)): void => {
    phase = typeof next === "function" ? next(phase) : next;
    run.phases.push(phase);
  };
  const router: Router = {
    replace: (p) => void run.routed.push(["replace", p]),
    push: (p) => void run.routed.push(["push", p]),
    back: () => void run.routed.push(["back"]),
  };
  const conn = {
    pairConfirmed: (admission: unknown, token: unknown) => {
      run.spent.push([admission, token]);
      return Promise.resolve(outcome);
    },
  };
  const make = new Function("setPhase", "pressed", "conn", "router", `"use strict"; return (${fn});`) as (
    a: typeof setPhase, b: typeof pressed, c: typeof conn, d: Router,
  ) => () => void;
  const confirm = make(setPhase, pressed, conn, router);
  for (let i = 0; i < presses; i++) confirm();
  /* Two turns of the loop: the redeem's promise, then the `.then` the handler attached to it. */
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  run.pressed = pressed.current;
  return run;
}

const READ = Object.fromEntries(
  Object.entries(DOORS).map(([name, path]) => [name, readFileSync(path, "utf8")]),
) as Record<keyof typeof DOORS, string>;

describe("§1 the route a confirmed pairing takes, read off each door", () => {
  for (const name of Object.keys(DOORS) as (keyof typeof DOORS)[]) {
    it(`${name}: the success branch lands in the mailbox and not on the Servers pane`, () => {
      const { ok } = doorOf(READ[name]);
      expect(ok, `${name}: the confirm's success branch routes nowhere at all`).toContain("router.replace(");
      expect(ok, `${name}: a confirmed pairing is left on a pane it cannot press Back out of`)
        .not.toContain(PANE);
      expect(ok, `${name}: a confirmed pairing does not land in the mailbox`)
        .toContain(`router.replace(${MAILBOX})`);
    });
  }
});

describe("§2 the handler itself, run", () => {
  for (const name of Object.keys(DOORS) as (keyof typeof DOORS)[]) {
    const fn = (): string => doorOf(READ[name]).fn;

    it(`${name}: a redeem that succeeds replaces the route with the mailbox, exactly once`, async () => {
      const run = await press(fn(), { ok: true });
      expect(run.spent, `${name}: the press never spent the code`).toHaveLength(1);
      expect(run.spent[0]?.[1], `${name}: the redeem was sent a token the phase did not hold`).toBe("t");
      expect(run.routed, `${name}: a confirmed pairing did not land in the mailbox`)
        .toEqual([["replace", "/"]]);
      /* The halves the fix may not have moved: the press is recorded, so the unmount effect does
         not hand the admission back, and the phase is flipped busy so a second press is dead. */
      expect(run.pressed, `${name}: a spent code would be discarded by the unmount effect`).toBe(true);
      expect(run.phases[0]?.busy, `${name}: the confirm did not flip busy`).toBe(true);
    });

    it(`${name}: a refused redeem routes nowhere and says why`, async () => {
      const run = await press(fn(), { ok: false, reason: "pairing_invalid" });
      expect(run.routed, `${name}: a refused pairing moved the person off the door anyway`).toEqual([]);
      expect(run.phases.at(-1), `${name}: a refused redeem did not render its refusal`)
        .toEqual({ k: "failed", reason: "pairing_invalid" });
    });

    it(`${name}: a second press while the first is in flight spends and routes nothing extra`, async () => {
      const run = await press(fn(), { ok: true }, 2);
      expect(run.spent, `${name}: a double press spent the code twice`).toHaveLength(1);
      expect(run.routed, `${name}: a double press routed twice`).toEqual([["replace", "/"]]);
    });
  }
});

describe("§3 the shipped defect, put back", () => {
  /** One door's real text with the one line as it shipped — the only difference. */
  const OLD = READ.connect.replace(`router.replace(${MAILBOX});`, `router.replace(${PANE});`);

  it("the fixture really is the old shape, and differs in nothing else", () => {
    expect(OLD, "the substitution did not take — §3 would then measure the fixed file").not.toBe(READ.connect);
    expect(OLD.length - READ.connect.length, "the fixture changed more than the route")
      .toBe(PANE.length - MAILBOX.length);
  });

  it("§1's reader refuses it by name", () => {
    const { ok } = doorOf(OLD);
    expect(ok).toContain(PANE);
    expect(ok).not.toContain(`router.replace(${MAILBOX})`);
  });

  it("§2's run refuses it by name — the person is put on the pane", async () => {
    const run = await press(doorOf(OLD).fn, { ok: true });
    expect(run.routed).toEqual([["replace", "/servers"]]);
  });
});

describe("§4 the reading is not vacuous", () => {
  for (const name of Object.keys(DOORS) as (keyof typeof DOORS)[]) {
    it(`${name}: the extractor read a real handler out of a real door`, () => {
      const { fn, ok } = doorOf(READ[name]);
      expect(READ[name].length, `${name}: the door is empty`).toBeGreaterThan(2000);
      expect(fn, `${name}: the handler does not redeem the code`).toContain("conn.pairConfirmed(");
      expect(fn, `${name}: the extractor swallowed the dependency array`).not.toContain("[conn]");
      expect(ok.length, `${name}: the success branch came back empty`).toBeGreaterThan(20);
    });
  }

  it("the standalone door states the same rule, which is where it came from", () => {
    const standalone = readFileSync(fileURLToPath(new URL("../app/standalone.tsx", import.meta.url)), "utf8");
    expect(withoutCommentsAndLiterals(standalone), "the third door no longer lands in the mailbox")
      .toContain("router.replace(");
    expect(standalone).toContain(`router.replace(${MAILBOX});`);
  });
});
