import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bracketSpan, withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";
import { gateFor } from "../src/state/gate";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE SERVERS PANE IS NEVER A DEAD END
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * With NO server paired, More → "Connect to a server" → Back left the pane standing with no
 * Back control and no tab bar, unescapable by three edge swipes; only a relaunch left it. It
 * did not reproduce paired, where the same Back pops on the first press — the condition is the
 * empty stack, which `DetailBar` reads as `router.canGoBack() === false` and answers by
 * rendering nothing. The pane states its own way out for exactly that state.
 *
 * ── HOW IT IS MEASURED ─────────────────────────────────────────────────────────────────────
 *
 * There is no React Native renderer in this workspace (a pinned decision — see
 * `pairing-confirm-lands-in-the-mailbox.test.ts`, whose shape this file follows), so the
 * handler is EXTRACTED from `app/servers.tsx` and RUN with `router` and `conn` injected. §1
 * reads it, §2 drives the three arms, §3 puts the shipped shape back and requires both to
 * refuse it, §4 is the anti-vacuity half and the one-Back rule against `chrome.tsx`.
 */

const SERVERS = fileURLToPath(new URL("../app/servers.tsx", import.meta.url));
const CHROME = fileURLToPath(new URL("../src/ui/chrome.tsx", import.meta.url));
const SRC = readFileSync(SERVERS, "utf8");
const CHROME_SRC = readFileSync(CHROME, "utf8");


/**
 * The `leave` handler's function expression, read off the pane's own source. Positions are
 * preserved by the scanner, so the index found in the blanked reading slices the ORIGINAL text
 * — which is what §2 executes. A runaway brace is returned rather than clamped and refused
 * here: a span that never closed is a reading of the rest of the file, not of a handler.
 */
function leaveOf(src: string): string {
  const blank = withoutCommentsAndLiterals(src);
  const at = blank.indexOf("const leave = () => {");
  if (at === -1) throw new Error("no `const leave = () => {` in this file");
  const body = bracketSpan(blank, blank.indexOf("{", at), "{", "}");
  if (!body.closed) throw new Error("the handler never closed");
  return `() => {${src.slice(body.start, body.end)}}`;
}

type Run = { routed: string[][] };
type Verdict = { to: string };

/**
 * THE EXTRACTED HANDLER, RUN — `new Function` over the pane's own bytes with the two names it
 * closes over supplied. Nothing is re-typed here, so a handler that stops doing what §1 reads
 * cannot pass §2, and the compile is the parse.
 */
function press(fn: string, args: { canGoBack: boolean; verdict: Verdict }): Run {
  const run: Run = { routed: [] };
  const router = {
    canGoBack: () => args.canGoBack,
    back: () => void run.routed.push(["back"]),
    replace: (p: string) => void run.routed.push(["replace", p]),
    push: (p: string) => void run.routed.push(["push", p]),
  };
  const make = new Function("router", "verdict", `"use strict"; return (${fn});`) as (
    a: typeof router, b: Verdict,
  ) => () => void;
  make(router, args.verdict)();
  return run;
}

/** The gate's own verdict for a state, so the arms below are the app's states, not invented ones. */
const WELCOME: Verdict = gateFor({ k: "idle" }, 0);
const MAIL: Verdict = gateFor({ k: "live" } as never, 1);
const HELD: Verdict = gateFor({ k: "idle" }, 1);

describe("§1 the way out, read off the pane", () => {
  it("pops where there is something to pop, and routes explicitly where there is not", () => {
    const fn = leaveOf(SRC);
    expect(fn, "the handler never asks whether the stack has anything under it").toContain("router.canGoBack()");
    expect(fn, "the handler never pops").toContain("router.back()");
    expect(fn, "an empty stack is left on the pane").toContain("router.replace(");
    expect(fn, "nothing paired has nowhere to land").toContain('"/welcome"');
    expect(fn, "a pairing lands nowhere").toContain('"/"');
    expect(fn, "the destination is not read off the gate, so it can land back on this pane")
      .toContain("verdict.to");
  });
});

describe("§2 the handler itself, run", () => {
  const fn = (): string => leaveOf(SRC);

  it("pops exactly once where the stack has something under it", () => {
    expect(press(fn(), { canGoBack: true, verdict: MAIL }).routed).toEqual([["back"]]);
    /* And it pops there whatever the gate would have said: a stack is a stack. */
    expect(press(fn(), { canGoBack: true, verdict: WELCOME }).routed).toEqual([["back"]]);
  });

  it("lands on the welcome screen where the gate sends an unpaired phone there", () => {
    expect(press(fn(), { canGoBack: false, verdict: WELCOME }).routed).toEqual([["replace", "/welcome"]]);
  });

  it("lands in the mailbox where the gate says the mail is the phone's screen", () => {
    expect(press(fn(), { canGoBack: false, verdict: MAIL }).routed).toEqual([["replace", "/"]]);
  });
});

describe("§3 the shipped shape, put back", () => {
  /** The pane as it shipped: no way out of its own, and the control that pressed it gone. */
  const OLD = SRC
    .replace(leaveOf(SRC).slice("() => {".length, -1), "\n    router.back();\n  ")
    .replace("const stranded = !router.canGoBack() && verdict.to !== \"servers\";", "const stranded = false;");

  it("the fixture really is the old shape, and differs in nothing else", () => {
    expect(OLD, "the substitution did not take — §3 would then measure the fixed file").not.toBe(SRC);
    expect(OLD, "the fixture kept the routing half of the fix")
      .not.toContain('verdict.to === "welcome" ? "/welcome" : "/"');
    expect(OLD, "the fixture kept the control the fix renders").toContain("const stranded = false;");
  });

  it("§2's run refuses it by name — an empty stack goes nowhere", () => {
    expect(press(leaveOf(OLD), { canGoBack: false, verdict: WELCOME }).routed).toEqual([["back"]]);
    expect(press(leaveOf(OLD), { canGoBack: false, verdict: MAIL }).routed).toEqual([["back"]]);
  });
});

describe("§4 one Back stands, and the reading is not vacuous", () => {
  const code = withoutCommentsAndLiterals(SRC);

  it("the extractor read a real handler out of a real pane", () => {
    expect(SRC.length, "the pane is empty").toBeGreaterThan(2000);
    const fn = leaveOf(SRC);
    expect(fn.length, "the handler came back empty").toBeGreaterThan(40);
    expect(fn, "the extractor swallowed the rest of the component").not.toContain("return (");
  });

  it("the pane's own control stands on exactly the condition the bar's Back does not", () => {
    /* `DetailBar` renders its Back under `router.canGoBack()`; this one under its negation, so
       a person always has one way out and a count refusal on the device never finds two. */
    expect(CHROME_SRC, "the bar stopped gating its Back on the stack").toContain(
      "const canBack = router.canGoBack() && !railBack;",
    );
    expect(code, "the pane's control is not gated on the empty stack").toContain(
      "const stranded = !router.canGoBack() && verdict.to !== ",
    );
    expect(code, "the control does not press the way out").toContain("onPress={leave}");
    expect(code, "the control is not rendered under that condition").toMatch(/\{stranded \?/);
  });

  it("the control speaks the app's own word for it, from the catalogue", () => {
    expect(SRC, "a way out a screen reader cannot name").toContain("accessibilityLabel={Copy.back}");
    expect(SRC).toContain("<Txt variant=\"button\" tone=\"ink2\">{Copy.back}</Txt>");
  });
});

describe("§5 where the gate holds the phone here, the pane is the destination", () => {
  const code = withoutCommentsAndLiterals(SRC);

  it("the gate really does send a paired phone with no live session back to this pane", () => {
    // Driven from the app's own gate, not from a sentence about it: these are the states a
    // Disconnect, a refusal and a death leave behind, and all three land on the pane.
    expect(HELD.to).toBe("servers");
    expect(gateFor({ k: "ended", reason: "pair_ended" } as never, 1).to).toBe("servers");
    expect(gateFor({ k: "refused", reason: "pair_ended" } as never, 0).to).toBe("servers");
    // And the two the way out is FOR.
    expect(WELCOME.to).toBe("welcome");
    expect(MAIL.to).toBe("mail");
  });

  it("so the control is withheld there rather than returning to the screen it was pressed on", () => {
    expect(code).toContain("verdict.to !== ");
    // The handler still answers, because the bar's Back can pop while the gate holds the pane.
    expect(press(leaveOf(SRC), { canGoBack: true, verdict: HELD }).routed).toEqual([["back"]]);
  });
});
