import { describe, it, expect } from "vitest";
import type {
  AnthropicCallReport, ClassifierInput, ClassifierPort, DraftPort, LogFields, Logger, WorkflowPort,
} from "@trafficflow/core";
import type { AiUsageLine, UsageReceipt } from "@trafficflow/db";
import { makeEntitlementsClient } from "@trafficflow/db/cloud";
import {
  attributedIngestClassifier, attributedProposer, attributedWorkflowDrafter, makeAiUsageBuffer,
  screenerUsageHook, type UsageHook,
} from "../src/ai-usage.js";

/**
 * THE WORKER'S USAGE: the bounded buffer, the wrappers that attribute a call to its account and
 * action, and the relay that says which metered calls nobody attributed.
 */

const ACC = "11111111-1111-4111-8111-111111111111";

function report(over: Partial<AnthropicCallReport> = {}): AnthropicCallReport {
  return {
    model: "claude-haiku-4-5-20251001", ok: true, status: 200, latencyMs: 400, attempts: 1,
    requestId: "req_1", inputTokens: 516, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0,
    thinkingTokens: null, costMicroUsd: 766, ...over,
  };
}

function line(n: number): AiUsageLine {
  return {
    accountId: ACC, action: "classify_ingest", host: "worker", model: "m", at: new Date(n).toISOString(),
    ok: true, attempts: 1, inputTokens: n, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
    thinkingTokens: null,
  };
}

function capturingLogger(): { log: Logger; lines: Array<{ level: string; event: string; fields: LogFields }> } {
  const lines: Array<{ level: string; event: string; fields: LogFields }> = [];
  const at = (level: string) => (event: string, fields: LogFields = {}) => { lines.push({ level, event, fields }); };
  const log: Logger = { level: "debug", child() { return log; }, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
  return { log, lines };
}

function recorder(answer: () => Promise<UsageReceipt>): { recordUsage(l: readonly AiUsageLine[]): Promise<UsageReceipt>; batches: AiUsageLine[][] } {
  const batches: AiUsageLine[][] = [];
  return { batches, recordUsage(l) { batches.push([...l]); return answer(); } };
}

describe("the usage buffer — at most once, bounded, and it says what it lost", () => {
  it("a flush sends what is held and says how many lines", async () => {
    const port = recorder(async () => "settled");
    const { log, lines } = capturingLogger();
    const buf = makeAiUsageBuffer({ port, log, budgetMs: 5_000 });
    buf.push(line(1)); buf.push(line(2)); buf.push(line(3));
    await buf.flush();
    expect(port.batches.map((b) => b.length)).toEqual([3]);
    expect(lines.filter((l) => l.event === "ai_usage_flushed").map((l) => l.fields.lines)).toEqual([3]);
    buf.stop();
  });

  it("sends at most 500 lines per request, several requests per flush", async () => {
    const port = recorder(async () => "settled");
    const buf = makeAiUsageBuffer({ port, log: capturingLogger().log, budgetMs: 5_000 });
    for (let i = 0; i < 1_200; i++) buf.push(line(i));
    await buf.flush();
    expect(port.batches.map((b) => b.length)).toEqual([500, 500, 200]);
    buf.stop();
  });

  it("past its bound it drops the OLDEST lines and counts them into the flush line", async () => {
    const port = recorder(async () => "settled");
    const { log, lines } = capturingLogger();
    const buf = makeAiUsageBuffer({ port, log, max: 5, budgetMs: 5_000 });
    for (let i = 1; i <= 8; i++) buf.push(line(i));
    await buf.flush();
    expect(port.batches[0]!.map((l) => l.inputTokens)).toEqual([4, 5, 6, 7, 8]);
    expect(lines.find((l) => l.event === "ai_usage_flushed")?.fields).toMatchObject({ lines: 5, droppedOldest: 3 });
    buf.stop();
  });

  it("a batch the program does not take is logged and DROPPED, never sent twice", async () => {
    const port = recorder(async () => "unreachable");
    const { log, lines } = capturingLogger();
    const buf = makeAiUsageBuffer({ port, log, budgetMs: 5_000 });
    buf.push(line(1)); buf.push(line(2));
    await buf.flush();
    await buf.flush();
    expect(port.batches).toHaveLength(1);
    expect(lines.find((l) => l.event === "ai_usage_flush_failed")?.fields).toMatchObject({ lines: 2, status: "unreachable" });
    buf.stop();
  });

  it("a batch the program REFUSES is logged as refused, never as an outage", async () => {
    const port = recorder(async () => "refused");
    const { log, lines } = capturingLogger();
    const buf = makeAiUsageBuffer({ port, log, budgetMs: 5_000 });
    buf.push(line(1));
    await buf.flush();
    expect(lines.filter((l) => l.event === "ai_usage_flush_failed").map((l) => l.fields))
      .toEqual([expect.objectContaining({ lines: 1, status: "refused" })]);
    buf.stop();
  });

  it("a program with no /v1/usage (404) stops the buffer for the process, said once", async () => {
    const port = recorder(async () => "no_door");
    const { log, lines } = capturingLogger();
    const buf = makeAiUsageBuffer({ port, log, budgetMs: 5_000 });
    buf.push(line(1)); buf.push(line(2));
    await buf.flush();
    buf.push(line(3));
    await buf.flush();
    expect(port.batches).toHaveLength(1);
    expect(lines.filter((l) => l.event === "ai_usage_recording_stopped")).toHaveLength(1);
    expect(lines.filter((l) => l.event === "ai_usage_flush_failed").map((l) => l.fields))
      .toEqual([expect.objectContaining({ lines: 2, status: "refused" })]);
    buf.stop();
  });

  it("the real client against a program answering 404: one POST, then nothing for the process", async () => {
    const paths: string[] = [];
    const client = makeEntitlementsClient({
      baseUrl: "https://entitlements.example/", secret: "x".repeat(24),
      fetchImpl: async (url) => { paths.push(new URL(url).pathname); return { status: 404, json: async () => ({}) }; },
      onContractFault: () => {}, onCallFault: () => {}, onUsageUnrecorded: () => {},
    });
    const { log, lines } = capturingLogger();
    const buf = makeAiUsageBuffer({ port: { recordUsage: client.recordUsage!.bind(client) }, log, budgetMs: 5_000 });
    buf.push(line(1));
    await buf.flush();
    buf.push(line(2));
    await buf.flush();
    expect(paths).toEqual(["/v1/usage"]);
    expect(lines.filter((l) => l.event === "ai_usage_recording_stopped")).toHaveLength(1);
    buf.stop();
  });

  it("the control: a 400 is refused for that batch only, and the next batch is sent", async () => {
    let n = 0;
    const port = recorder(async () => (n++ === 0 ? "refused" : "settled"));
    const { log, lines } = capturingLogger();
    const buf = makeAiUsageBuffer({ port, log, budgetMs: 5_000 });
    buf.push(line(1));
    await buf.flush();
    buf.push(line(2));
    await buf.flush();
    expect(port.batches).toHaveLength(2);
    expect(lines.filter((l) => l.event === "ai_usage_recording_stopped")).toEqual([]);
    buf.stop();
  });

  it("a flush ends at its budget even when the program never answers", async () => {
    const port = recorder(() => new Promise<UsageReceipt>(() => { /* never */ }));
    const { log, lines } = capturingLogger();
    const buf = makeAiUsageBuffer({ port, log, budgetMs: 50 });
    buf.push(line(1));
    const t0 = Date.now();
    await buf.flush();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(lines.find((l) => l.event === "ai_usage_flush_failed")?.fields).toMatchObject({ lines: 1 });
    buf.stop();
  });

  it("the timer flushes on its own, with no second push", async () => {
    const port = recorder(async () => "settled");
    const buf = makeAiUsageBuffer({ port, log: capturingLogger().log, flushMs: 20, budgetMs: 5_000 });
    buf.push(line(1));
    expect(port.batches).toHaveLength(0);
    await new Promise<void>((r) => { setTimeout(r, 120); });
    expect(port.batches).toHaveLength(1);
    buf.stop();
  });
});

describe("the wrappers — each call attributed to its account and its action", () => {
  const passthrough: UsageHook = (fn) => fn;
  const INPUT: ClassifierInput = { from: { address: "a@b.example", name: null }, subject: "s", snippet: "t", headersDigest: "" };
  const RESULT = { destination: "ohmail/News" as const, confidence: 0.9, rationale: "r", spam: false };

  it("the ingest classifier records classify_ingest into the buffer, and exposes no screen", async () => {
    const pushed: AiUsageLine[] = [];
    const inner: ClassifierPort = {
      async classify(_i, call) { call?.onUsage?.(report()); return RESULT; },
      async screen() { throw new Error("never reached through the ingest wrapper"); },
    };
    const wrapped = attributedIngestClassifier(inner, ACC, passthrough, { push: (l) => pushed.push(l), flush: async () => {}, stop: () => {} });
    await wrapped.classify(INPUT);
    expect("screen" in wrapped).toBe(false);
    expect(pushed).toEqual([expect.objectContaining({ accountId: ACC, action: "classify_ingest", host: "worker", inputTokens: 516 })]);
  });

  it("the workflow drafter records workflow and keeps the caller's signal", async () => {
    const pushed: AiUsageLine[] = [];
    let signal: AbortSignal | undefined;
    const inner: DraftPort = {
      async draft(_i, call) { signal = call?.signal; call?.onUsage?.(report({ model: "claude-sonnet-5" })); return { subject: "s", body: "b", rationale: "r" }; },
    };
    const ac = new AbortController();
    await attributedWorkflowDrafter(inner, ACC, passthrough, { push: (l) => pushed.push(l), flush: async () => {}, stop: () => {} })
      .draft({ incoming: { subject: "q", from: "c@x.example", snippet: "s" }, context: { kbEntries: [], threadMessages: [] } }, { signal: ac.signal });
    expect(signal).toBe(ac.signal);
    expect(pushed).toEqual([expect.objectContaining({ action: "workflow", model: "claude-sonnet-5" })]);
  });

  it("the proposer and the Screener hand their one line to the release that carries it", async () => {
    const taken: AiUsageLine[] = [];
    const inner: WorkflowPort = { async propose(_p, call) { call?.onUsage?.(report({ model: "claude-opus-5" })); return []; } };
    await attributedProposer(inner, ACC, passthrough, (l) => taken.push(l)).propose([]);
    screenerUsageHook(passthrough, ACC, (l) => taken.push(l)).onUsage!(report());
    expect(taken.map((l) => [l.action, l.model])).toEqual([["propose", "claude-opus-5"], ["screener", "claude-haiku-4-5-20251001"]]);
  });
});
