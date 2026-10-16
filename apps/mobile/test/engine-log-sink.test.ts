/**
 * ═══ THE ENGINE'S LOG REACHES A SHIPPED PHONE — ONE SINK, AND THE REDACTION RUNS FIRST ═══════
 *
 * MEASURED (2026-09-22, four ways): the engine's only sink
 * on a phone was `console.log`, a Release iOS build drops it entirely (RN pins the iOS threshold
 * to error when `RCT_DEBUG` is off), the unified log carried no engine JSON in either
 * configuration, and a Debug build with an embedded bundle dies at startup — so no shipped iPhone
 * build could hand anybody the engine's log. The fix is a native half, and the two things that
 * could go wrong with it are ARITY (a second carrier duplicating every line) and ORDER (something
 * reaching the platform log before the logger's redaction).
 *
 * The logger here is the REAL one: `createLogger` is what `apps/sidecar/src/log.ts` builds inside
 * the engine artifact, so the bytes these arms read are the bytes a phone writes.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/* The engine's own logger, by relative path like this dir's other cross-package reads: the phone
   depends on the ENGINE ARTIFACT and not on that package, and a dependency added for
   a test would be a real edge. `log.ts` is dependency-free and is the module the artifact's
   `createSidecarLog` is built over. */
import { createLogger } from "../../../packages/core/src/log.js";

import {
  engineLogLevel,
  engineLogSink,
  installEngineLogWriter,
  installedEngineLogWriter,
  logAttachmentRefusal,
  logBackupExclusion,
  logNetwork,
  logWithdrawUnsupported,
  type EngineLogLevel,
} from "../src/engine/engine-log";

/** Every write the installed native half received, in order. */
function recorder(opts: { throws?: boolean } = {}): { level: EngineLogLevel; line: string }[] {
  const seen: { level: EngineLogLevel; line: string }[] = [];
  installEngineLogWriter({
    write: (level, line) => {
      seen.push({ level, line });
      if (opts.throws === true) throw new Error("the platform log refused");
    },
  });
  return seen;
}

/** What `console.log` received while `body` ran. */
function consoleLines(body: () => void): string[] {
  const written: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { written.push(String(a[0])); });
  try {
    body();
  } finally {
    spy.mockRestore();
  }
  return written;
}

function setDev(on: boolean): void {
  (globalThis as { __DEV__?: boolean }).__DEV__ = on;
}

afterEach(() => {
  installEngineLogWriter(null);
  delete (globalThis as { __DEV__?: boolean }).__DEV__;
  vi.restoreAllMocks();
});

describe("the phone engine's log sink", () => {
  it("hands a shipped build's platform log exactly one write, and console none", () => {
    const seen = recorder();
    const console_ = consoleLines(() => { engineLogSink()("{\"service\":\"app\",\"event\":\"x\"}"); });
    expect(seen.length, "one line, one write — a second carrier duplicates every line").toBe(1);
    expect(console_.length, "a Release iOS build drops console; writing there too is noise").toBe(0);
  });

  it("falls back to console where no native half is installed, and never throws", () => {
    installEngineLogWriter(null);
    expect(installedEngineLogWriter()).toBeNull();
    const console_ = consoleLines(() => { engineLogSink()("{\"service\":\"app\",\"event\":\"x\"}"); });
    expect(console_, "an old build or a web runtime keeps the line it had").toEqual(["{\"service\":\"app\",\"event\":\"x\"}"]);
  });

  it("writes BOTH in a dev build, so metro keeps the lines the unified log is also getting", () => {
    const seen = recorder();
    setDev(true);
    const console_ = consoleLines(() => { engineLogSink()("{\"service\":\"app\",\"event\":\"x\"}"); });
    expect(seen.length).toBe(1);
    expect(console_.length).toBe(1);
  });

  it("does not lose a line the platform log refused, and does not take the caller down", () => {
    const seen = recorder({ throws: true });
    let threw = false;
    const console_ = consoleLines(() => {
      try { engineLogSink()("{\"service\":\"app\",\"event\":\"x\"}"); } catch { threw = true; }
    });
    expect(threw, "a log line is never worth a mailbox").toBe(false);
    expect(seen.length).toBe(1);
    expect(console_.length, "the fallback carries the line the native half dropped").toBe(1);
  });

  /**
   * THE ORDER, AND IT IS THE WHOLE POINT. The native module is handed a FINISHED line: the field
   * allowlist, the value scrubber and the bounds have all run in the engine's own logger. A call
   * site that reached the module itself would be outside every one of them, which is why the
   * bytes at the writer are asserted to be the REDACTED rendering and nothing else.
   */
  it("hands the native half the logger's redacted bytes, never a call site's fields", () => {
    const seen = recorder();
    const sentinel = "SENTINEL-VALUE-THAT-MUST-NOT-TRAVEL";
    const logger = createLogger({ service: "sidecar", sink: engineLogSink(), level: "info" });
    const console_ = consoleLines(() => {
      logger.info("mailbox_attached", { imapPassword: sentinel, accountId: "acc-1" });
      logger.info("mailbox_attached", { somethingUndeclared: sentinel, accountId: "acc-1" });
    });

    expect(seen.length, "two lines, two writes, through exactly one sink").toBe(2);
    expect(console_.length).toBe(0);
    for (const s of seen) expect(s.line, "a value reached the platform log unredacted").not.toContain(sentinel);
    /* The two halves of the logger's gate, and each one alone would miss the other: a
       secret-NAMED field keeps its key and loses its value, an undeclared field is dropped by
       name and reported. */
    const named = JSON.parse(seen[0]!.line) as Record<string, unknown>;
    expect(named.imapPassword, "the value scrubber did not run before the native call").toBe("[redacted]");
    const undeclared = JSON.parse(seen[1]!.line) as Record<string, unknown>;
    expect(undeclared.droppedFields, "the field allowlist did not run before the native call")
      .toEqual(["somethingUndeclared"]);
    expect(named.accountId, "an allowlisted field did not survive").toBe("acc-1");
    expect(named.service).toBe("sidecar");
  });

  it("takes the level off the rendered line, at every level the logger writes", () => {
    const seen = recorder();
    const logger = createLogger({ service: "sidecar", sink: engineLogSink(), level: "debug" });
    logger.debug("a"); logger.info("b"); logger.warn("c"); logger.error("d");
    expect(seen.map((s) => s.level)).toEqual(["debug", "info", "warn", "error"]);
  });

  /**
   * A LINE'S CONTENT MAY NOT MOVE ITS LEVEL. The match is anchored at the start of the rendering,
   * so a field whose value spells another level decides nothing — an unanchored read would let
   * anything that reaches a log line choose which os_log class it lands in.
   */
  it("refuses to take a level out of a field's value", () => {
    const seen = recorder();
    const logger = createLogger({ service: "sidecar", sink: engineLogSink(), level: "info" });
    logger.info("evt", { reason: "\"level\":\"error\"" });
    expect(seen[0]!.level, "content decided the level").toBe("info");
    expect(engineLogLevel("{\"service\":\"app\",\"level\":\"error\"}"), "an unrendered line is not the logger's")
      .toBe("info");
  });

  it("gives the app's own closed-set lines the level a reader sees without a flag", () => {
    const seen = recorder();
    logAttachmentRefusal("bytes_unavailable");
    logBackupExclusion("excluded", "ios");
    logNetwork("offline");
    expect(seen.map((s) => s.level)).toEqual(["info", "info", "info"]);
    expect(seen.map((s) => (JSON.parse(s.line) as { event: string }).event))
      .toEqual(["attachment_refused", "backup_exclusion", "network"]);
    expect(JSON.parse(seen[2]!.line)).toEqual({ service: "app", event: "network", state: "offline" });
  });

  it("says a server without the Cancel route in one content-free line", () => {
    const seen = recorder();
    logWithdrawUnsupported();
    expect(seen.map((s) => [s.level, JSON.parse(s.line)]))
      .toEqual([["info", { service: "app", event: "send_withdraw_unsupported" }]]);
  });
});

/* @reads: apps/mobile/app/_layout.tsx apps/mobile/src/ apps/mobile/app/
   Read by paths built at runtime from MOBILE, so no landing pass selects this file when those
   sources move — the shape `reads-list.mjs` exists for. */

/**
 * ONE FILE MAY REACH THE NATIVE MODULE, and that file hands it nothing but a finished line. A
 * second `requireOptionalNativeModule("OhmailEngineLogSink")` anywhere is a call site that can
 * write BEFORE the redaction, which is the defect this whole change exists to make unrepresentable
 * — so it is counted rather than trusted. The census is driven over a fixture that HAS the second
 * call site as well as over the real tree, because a census that has never refused is not evidence.
 */
const MOBILE = fileURLToPath(new URL("..", import.meta.url));

function filesNamingTheModule(rel: string): string[] {
  const root = join(MOBILE, rel);
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (readFileSync(p, "utf8").includes("OhmailEngineLogSink")) hits.push(relative(MOBILE, p));
    }
  };
  walk(root);
  return hits;
}

describe("the native log module's call sites", () => {
  it("is named by exactly one file in the app", () => {
    const hits = [
      ...filesNamingTheModule("src"),
      ...filesNamingTheModule("app"),
    ];
    expect(hits).toEqual(["src/engine/engine-log-native.ts"]);
  });

  /**
   * AND SOMETHING HAS TO CALL THE INSTALL. Every arm above drives the sink with a writer this
   * file installed, so all of them stay green on a build that never wires one — which is the
   * whole defect, wearing a passing suite. The call is at MODULE scope in the root layout: at
   * the left margin, ahead of the first render and of anything that opens a mirror.
   */
  it("is installed at the root layout's module scope, before the first render", () => {
    const layout = readFileSync(join(MOBILE, "app/_layout.tsx"), "utf8");
    expect(/^installNativeEngineLogWriter\(\);$/m.test(layout), "nothing wires the platform sink")
      .toBe(true);
  });

  it("counts a second call site — the census refuses what it exists to refuse", () => {
    const hits = filesNamingTheModule("test/fixtures/engine-log-census");
    expect(hits.length, "a planted second call site was not seen").toBe(2);
  });
});
