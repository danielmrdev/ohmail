import { describe, it, expect } from "vitest";
import type { SpendPort } from "@trafficflow/db";
import {
  makeAnthropicClient, makeHaikuClassifier, ModelDeclinedError, type AnthropicCallReport,
} from "@trafficflow/core";
import { makeClassifierCircuit, ClassifierFaultError } from "../src/ai-circuit.js";

/**
 * THE REVIEW'S PROBE, KEPT: a Haiku 5.5 refusal at the worker's classify door, through the REAL
 * client, classifier and circuit. Haiku 5.5 runs safety classifiers Haiku 4.5 did not, and a
 * refusal is HTTP 200 with no content and `stop_reason: "refusal"`. Measured before the fix: the
 * client priced it, the classifier threw "no text content block", the circuit counted 30 faults
 * over 30 cycles while another mailbox's successes kept it shut (0 opens), and the one charge was
 * never refunded. The invariant now: a decline answers for its one message, is never a fault,
 * and its charge comes back. Mutation: delete the circuit's `ModelDeclinedError` arm.
 */

/** Anthropic's documented refusal (refusals page, 2026-10-12). One message refused. */
const REFUSAL = {
  id: "msg_probe", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [],
  stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
  usage: { input_tokens: 900, output_tokens: 0 },
};
const ANSWER = {
  id: "msg_ok", type: "message", role: "assistant", model: "claude-haiku-5-5",
  content: [{ type: "text", text: JSON.stringify({ destination: "ohmail/News", confidence: 0.9, rationale: "bulk", spam: false }) }],
  stop_reason: "end_turn", usage: { input_tokens: 150, cache_read_input_tokens: 800, output_tokens: 80 },
};

function input(subject: string) {
  return { from: { name: null, address: "sender@example.com" }, subject, snippet: "preview text", headersDigest: "", fewShot: [] };
}

/** The live client over a fetch that refuses `poison`, answers everything else, and 529s `down`. */
function liveShapedClassifier(reports: AnthropicCallReport[]) {
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const params = JSON.parse(init.body) as { messages: { content: string }[] };
    const subject = (JSON.parse(params.messages[0]!.content) as { subject: string }).subject;
    if (subject === "down") {
      return new Response(JSON.stringify({ error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529 });
    }
    return new Response(JSON.stringify(subject === "poison" ? REFUSAL : ANSWER), {
      status: 200, headers: { "content-type": "application/json", "request-id": "req_probe" },
    });
  }) as unknown as typeof fetch;
  const client = makeAnthropicClient({ apiKey: "probe-not-a-key", fetchImpl, maxRetries: 0, onUsage: (r) => { reports.push(r); } });
  return makeHaikuClassifier({ client });
}

/** A gate that charges a key once and names the attempt; every release is recorded. */
function spendRecorder() {
  const spends: string[] = [];
  const refunds: string[] = [];
  const seen = new Set<string>();
  const port = {
    async spend(_accountId: string, _action: string, attemptKey: string) {
      spends.push(attemptKey);
      if (seen.has(attemptKey)) return { verdict: "duplicate", charged: false, attempt: `attempt:${attemptKey}` };
      seen.add(attemptKey);
      return { verdict: "ok", charged: true, attempt: `attempt:${attemptKey}` };
    },
    async release(_accountId: string, r: { refund?: boolean; attempt?: string }) {
      if (r.refund) refunds.push(r.attempt ?? "");
      return "settled";
    },
  } as unknown as SpendPort;
  return { port, spends, refunds };
}

describe("a Haiku 5.5 refusal at the worker's classify door", () => {
  it("is a decline the client does not price and the circuit does not count", async () => {
    const reports: AnthropicCallReport[] = [];
    const circuit = makeClassifierCircuit(liveShapedClassifier(reports));
    const err = await circuit.port("A")!.classify(input("poison")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelDeclinedError);
    expect(err).not.toBeInstanceOf(ClassifierFaultError);
    expect(reports[0]).toMatchObject({ ok: true, status: 200, model: "claude-haiku-5-5", stopReason: "refusal" });
    expect(reports[0]!.costMicroUsd, "a cyber refusal before output is not billed").toBeNull();
    expect(circuit.state().consecutiveFaults).toBe(0);
  });

  it("over 30 cycles beside a succeeding mailbox: no fault, no open, and the one charge refunded", async () => {
    let clock = 1_000_000;
    const circuit = makeClassifierCircuit(liveShapedClassifier([]), { now: () => clock });
    const a = spendRecorder();
    const meteredA = circuit.meter("A", a.port);
    let declines = 0;
    let faults = 0;
    for (let cycle = 0; cycle < 30; cycle++) {
      // The pipeline's order: spend first (the same message, the same key), then classify.
      await meteredA.spend("acct-A", "classify_ingest", "classify-A-M", { mailboxId: "A" });
      const err = await circuit.port("A")!.classify(input("poison")).catch((e: unknown) => e);
      if (err instanceof ModelDeclinedError) declines++;
      if (err instanceof ClassifierFaultError) faults++;
      clock += 30_000;
      await circuit.port("B")!.classify(input("ordinary newsletter"));
      clock += 30_000;
    }
    expect({ declines, faults, opens: circuit.state().opens }).toEqual({ declines: 30, faults: 0, opens: 0 });
    // The first cycle charged and the decline refunded it; the rest were `duplicate`s that charged nothing.
    expect(a.refunds).toEqual(["attempt:classify-A-M"]);
  });

  it("CONTROL: a real provider outage with no success between still trips and refunds", async () => {
    let clock = 1_000_000;
    const circuit = makeClassifierCircuit(liveShapedClassifier([]), { now: () => clock });
    const a = spendRecorder();
    const meteredA = circuit.meter("A", a.port);
    for (let i = 0; i < 2; i++) {
      await meteredA.spend("acct-A", "classify_ingest", "classify-A-D", { mailboxId: "A" });
      await circuit.port("A")!.classify(input("down")).catch(() => undefined);
      clock += 1_000;
    }
    expect(circuit.state().opens).toBe(1);
    expect(circuit.port("A")).toBeUndefined();
    await Promise.resolve();
    expect(a.refunds).toEqual(["attempt:classify-A-D"]);
  });
});
