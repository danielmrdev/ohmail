/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  EVERY `process` MEMBER THE ARTIFACT READS IS ONE THE STAND-IN HAS — censused, not argued
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A phone has no `process`, so the bundler binds a stand-in object as that global. It is
 * deliberately thin: `env` stays empty for ever, because a library that finds a value there starts
 * behaving differently, and one that starts logging on a device is a privacy failure rather than a
 * noisy one.
 *
 * Thin has a cost, and the cost is what this file measures. `startEngineVitals` called
 * `process.memoryUsage()` unconditionally at boot; the stand-in had no such member; a phone died
 * with `processShim.memoryUsage is not a function` after a successful load, a successful migration
 * and a successful credential seal. One member, found the expensive way.
 *
 * The question "which members does the shipped code read?" has an exact answer and it is in the
 * ARTIFACT, so this reads the artifact. A census over the stand-in's own source could only say what
 * it defines; a census over the engine's source would miss every dependency, which is where five of
 * the seven rows below live.
 *
 * ── AN EXCEPTION NAMES ITS GUARD, AND THE GUARD IS CHECKED ────────────────────────────────
 *
 * A member may be absent when reaching it cannot break anything, and a table of reasons in prose is
 * a table nobody can check. So each row carries the TEXT of the guard that makes it safe, and the
 * case asserts that text is still in the artifact. A guard someone removes takes its exception with
 * it, which is the difference between an exception and a permission slip.
 */
import { createRequire } from "node:module";
import { readFileSync, rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { BUNDLE, bundleProbe } from "../scripts/bundle-engine.mjs";
import { process as standIn } from "../src/engine/shims/globals.mjs";

const require_ = createRequire(import.meta.url);
const source = readFileSync(BUNDLE, "utf8");
const lines = source.split("\n");

/**
 * The name the bundler gave the stand-in, derived from the artifact rather than pinned.
 *
 * esbuild renames module-scope bindings when it merges modules, so a hard-coded `processShim` is a
 * census that silently reads nothing the day a rename happens — which is the failure this whole
 * file exists to prevent, one level up.
 */
function injectedIdentifier(): string {
  const section = sectionOf("apps/mobile/src/engine/shims/globals.mjs").join("\n");
  const m = /(\w+) = \{\s*\n\s*env: \{\}/.exec(section);
  expect(m, "the stand-in's own binding, found in the artifact").not.toBeNull();
  return m![1]!;
}

/** The lines the bundler attributed to one input, by its `// <path>` marker. */
function sectionOf(path: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    const marker = /^\/\/ (.+)$/.exec(line);
    if (marker) {
      inside = marker[1] === path;
      continue;
    }
    if (inside) out.push(line);
  }
  return out;
}

/** Every `<ident>.<member>` in the artifact, with the input the bundler attributed it to. */
function readsOutsideTheStandIn(ident: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  let owner = "(preamble)";
  const pattern = new RegExp(`\\b${ident}\\.([A-Za-z_$][A-Za-z0-9_$]*)`, "g");
  for (const line of lines) {
    const marker = /^\/\/ (.+)$/.exec(line);
    if (marker) {
      owner = marker[1]!;
      continue;
    }
    // The stand-in refers to ITSELF (`on: () => processShim`), which is not a read of a member it
    // might not have.
    if (owner === "apps/mobile/src/engine/shims/globals.mjs") continue;
    for (const hit of line.matchAll(pattern)) {
      const member = hit[1]!;
      if (!found.has(member)) found.set(member, new Set());
      found.get(member)!.add(owner);
    }
  }
  return found;
}

/**
 * THE MEMBERS THE STAND-IN DOES NOT DEFINE AND DOES NOT NEED TO.
 *
 * `guardedAt` is text that must still be present in the artifact. If it is not, the guard has moved
 * or gone and the row is void — which reddens here rather than on somebody's phone.
 */
const EXCEPTIONS: { member: string; kind: string; reason: string; guardedAt: string }[] = [
  {
    member: "memoryUsage",
    kind: "typeof guard",
    reason:
      "the engine's own memory sampler. It is the reason this file exists: it called this "
      + "unconditionally at boot and took the launch down. It now asks first and reports the "
      + "reading as unavailable rather than inventing one — and the stand-in still does not "
      + "define it, because a fabricated number would be worse than an absent one.",
    guardedAt: 'typeof processShim.memoryUsage === "function"',
  },
  {
    member: "binding",
    kind: "try/catch at module scope",
    reason:
      "safer-buffer reaches for an internal Node binding to learn a maximum string length, inside "
      + "a try/catch whose empty body IS the fallback. The artifact loads, which is the proof.",
    guardedAt: "safer.kStringMaxLength = processShim.binding(",
  },
  {
    member: "stderr",
    kind: "try/catch at the call",
    reason:
      "the engine's default log sink writes to stderr inside a try whose empty catch drops the "
      + "line. The phone hands the engine its own sink, and an absent stream lands in that catch.",
    guardedAt: "try {\n    processShim.stderr.write(`${line}",
  },
  {
    member: "pid",
    kind: "read only",
    reason:
      "read at module scope into a debug-log prefix that is only formatted when the debug "
      + "environment variable names this module — and the stand-in's environment is empty for ever.",
    guardedAt: "var pid = processShim.pid;",
  },
  {
    member: "noDeprecation",
    kind: "read only",
    reason: "a deprecation-printing switch. Absent reads as off, which is what a phone wants.",
    guardedAt: "processShim.noDeprecation === true",
  },
  {
    member: "throwDeprecation",
    kind: "read only",
    reason: "the same switch's louder sibling. Absent reads as off.",
    guardedAt: "if (processShim.throwDeprecation)",
  },
  {
    member: "traceDeprecation",
    kind: "read only",
    reason: "the same switch's noisier sibling. Absent reads as off.",
    guardedAt: "processShim.traceDeprecation",
  },
];

describe("the process stand-in covers every member the artifact reads", () => {
  const ident = injectedIdentifier();
  const reads = readsOutsideTheStandIn(ident);
  const defined = new Set(Object.keys(standIn));

  it("read a real artifact — the census is not vacuous", () => {
    // A rename, a marker-comment change or a stale bundle would make every case below pass over
    // nothing at all, which is exactly the shape this file exists to catch one level down.
    expect(ident).toMatch(/^\w+$/);
    expect(reads.size).toBeGreaterThan(8);
    expect(defined.size).toBeGreaterThan(10);
    // `env` is read by more of this graph than anything else; if it is missing, the scan is broken.
    expect(reads.has("env")).toBe(true);
  });

  it("names nothing the stand-in lacks and no exception covers", () => {
    const excepted = new Set(EXCEPTIONS.map((e) => e.member));
    const uncovered = [...reads.keys()]
      .filter((m) => !defined.has(m) && !excepted.has(m))
      .sort()
      .map((m) => `${m}  <- ${[...reads.get(m)!].join(", ")}`);
    expect(uncovered).toEqual([]);
  });

  it("every exception's guard is still in the artifact", () => {
    // The half that makes an exception checkable. A guard that is removed, renamed or refactored
    // away takes its row with it and lands here rather than on a device.
    const missing = EXCEPTIONS.filter((e) => !source.includes(e.guardedAt)).map((e) => e.member);
    expect(missing).toEqual([]);
  });

  it("every exception is for a member that is actually read, and is actually absent", () => {
    // An obsolete row is a claim about code that is gone. And a row for a member the stand-in DOES
    // define would be an exception granting permission for nothing, which reads as coverage.
    const notRead = EXCEPTIONS.filter((e) => !reads.has(e.member)).map((e) => e.member);
    expect(notRead).toEqual([]);
    const alsoDefined = EXCEPTIONS.filter((e) => defined.has(e.member)).map((e) => e.member);
    expect(alsoDefined).toEqual([]);
  });

  it("the stand-in still invents nothing", () => {
    // The rule the whole module is written to. An environment with values in it is a library
    // taking a branch nobody chose, and on this door that includes logging mail content.
    expect(Object.keys(standIn.env)).toEqual([]);
    expect(standIn.platform).toBe("android");
    // And it does NOT define the member this file was written for: a fabricated memory reading
    // would be a number in a series that nothing measured.
    expect("memoryUsage" in standIn).toBe(false);
  });
});

/**
 * `emit` THROWS the reason of an unwatched rejection. It used to be an exception in the table
 * above, and a phone then got `<shim>.emit is not a function` out of a timer, with no trace of the
 * failure being announced. The library that announced one (`lie`, under the zip archiver) has left
 * the artifact, and the member stays for the next one; these cases drive it through a probe built
 * under the artifact's own substitutions, so `process` is the injected stand-in.
 */
const probeDirs: string[] = [];
afterAll(() => {
  for (const dir of probeDirs) rmSync(dir, { recursive: true, force: true });
});

async function emitProbe(): Promise<{ announce: (reason: unknown) => string; emit: (event: string) => unknown }> {
  const probe = await bundleProbe(`
export function announce(reason) {
  try {
    process.emit("unhandledRejection", reason, null);
    return "__nothing was thrown__";
  } catch (err) {
    return err instanceof Error ? err.message : "__a non-Error escaped: " + String(err) + "__";
  }
}

export function emit(event) { return process.emit(event, 0); }
`);
  probeDirs.push(probe.dir);
  return require_(probe.bundlePath) as {
    announce: (reason: unknown) => string;
    emit: (event: string) => unknown;
  };
}

describe("an unwatched rejection announced through the stand-in", () => {
  it("arrives carrying the REASON, not a TypeError about this directory", async () => {
    const probe = await emitProbe();
    // The whole point. Before the member existed this read `<ident>.emit is not a function`.
    expect(probe.announce(new Error("the archive's central directory is truncated")))
      .toBe("the archive's central directory is truncated");
  }, 120_000);

  it("wraps a non-Error reason instead of throwing it raw", async () => {
    const probe = await emitProbe();
    // A thrown string reaches a catch with `errorClass: "String"` and no message at all — this
    // repository has lost a diagnosis to exactly that. The text has to survive.
    expect(probe.announce("the zip entry is not a zip entry")).toBe("the zip entry is not a zip entry");
  }, 120_000);

  it("answers `false` for an event nobody announced — the positive control", async () => {
    const probe = await emitProbe();
    // A shim that threw on everything would satisfy the two cases above and take down any library
    // that emits an ordinary lifecycle event. `false` is what Node's own `emit` returns with no
    // listeners registered, and `on`/`once` here register none.
    expect(probe.emit("beforeExit")).toBe(false);
    expect(probe.emit("exit")).toBe(false);
  }, 120_000);
});
