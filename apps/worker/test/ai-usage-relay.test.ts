import { describe, it, expect } from "vitest";
import type { AnthropicCallReport, LogFields, Logger } from "@trafficflow/core";
import { loadConfig } from "../src/config.js";
import { FIXTURE_SHAPES, anthropicKey } from "../../../test/support/fixture-credentials.js";

/**
 * THE RELAY: every call's `ai_call` line through the logger `loadConfig` was handed, and, once
 * armed, a warning for a metered call no per-call hook attributed.
 */

const KEY = anthropicKey("ai-usage-relay");

it("the fixture key has the vendor key's shape", () => {
  expect(KEY).toMatch(FIXTURE_SHAPES.anthropic);
});

function report(over: Partial<AnthropicCallReport> = {}): AnthropicCallReport {
  return {
    model: "claude-haiku-4-5-20251001", ok: true, status: 200, latencyMs: 400, attempts: 1,
    requestId: "req_1", inputTokens: 516, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0,
    thinkingTokens: null, costMicroUsd: 766, ...over,
  };
}

function capturingLogger(): { log: Logger; lines: Array<{ level: string; event: string; fields: LogFields }> } {
  const lines: Array<{ level: string; event: string; fields: LogFields }> = [];
  const at = (level: string) => (event: string, fields: LogFields = {}) => { lines.push({ level, event, fields }); };
  const log: Logger = { level: "debug", child() { return log; }, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
  return { log, lines };
}

describe("the relay — the ai_call line, and the metered call nobody attributed", () => {
  function relay() {
    const { log, lines } = capturingLogger();
    const cfg = loadConfig({ DATABASE_URL_SESSION: "postgres://u:p@127.0.0.1:1/none", ANTHROPIC_API_KEY: KEY }, { log: () => log });
    return { relay: cfg.aiUsage!, lines };
  }

  it("the logger handed to loadConfig receives every ai_call line", () => {
    const { relay: r, lines } = relay();
    r.onUsage(report());
    expect(lines.filter((l) => l.event === "ai_call")).toHaveLength(1);
  });

  it("unarmed it never warns; armed it warns for an unclaimed report and not for a claimed one", () => {
    const { relay: r, lines } = relay();
    r.onUsage(report());
    expect(lines.filter((l) => l.event === "ai_call_unattributed")).toHaveLength(0);
    r.arm();
    const claimed = report({ requestId: "req_claimed" });
    r.hook(() => {})(claimed);
    r.onUsage(claimed);
    r.onUsage(report({ requestId: "req_orphan" }));
    expect(lines.filter((l) => l.event === "ai_call_unattributed").map((l) => l.fields.requestId)).toEqual(["req_orphan"]);
  });
});
