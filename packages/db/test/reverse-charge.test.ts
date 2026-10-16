import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  reverseCharge,
  type AiUsageLine, type RefundObligation, type RefundObligationPort, type ReleaseReceipt,
  type ReverseChargeFact, type SpendRelease,
} from "../src/entitlements-port.js";

/**
 * ONE REVERSAL, ONE ORDER — the debt, the release, the settlement — for the three doors that refund
 * a charge that bought nothing (the drafting route, the pressed Screener, the worker's pass). A debt
 * write that throws is said and the release still tried; only a written debt is settled, and only
 * on `settled`; a settle that throws is said and never thrown. Mutations: let the write's throw skip
 * the release, settle an unwritten debt, settle on any receipt, rethrow the settle.
 */

const CHARGE = {
  accountId: "acct-1", action: "screener", attemptKey: "msg-1", attempt: "attempt-7",
  reason: "drafter_failed", meta: { messageId: "msg-1" },
} as const satisfies RefundObligation;

const LINE: AiUsageLine = {
  accountId: "acct-1", action: "screener", host: "worker", model: "claude-haiku-5-5", at: "2026-10-13T00:00:00.000Z",
  ok: false, attempts: 1, inputTokens: 900, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null,
  thinkingTokens: null,
};

/** A gate and a store that record every call into one list, in call order. */
function rig(o: { owe?: "throws"; receipt?: ReleaseReceipt | "throws"; settle?: "throws" } = {}) {
  const events: string[] = [];
  const releases: SpendRelease[] = [];
  const owed: RefundObligation[] = [];
  const settled: string[] = [];
  const said: ReverseChargeFact[] = [];
  const gate = {
    async release(_accountId: string, r: SpendRelease): Promise<ReleaseReceipt> {
      events.push("release");
      releases.push(r);
      if (o.receipt === "throws") throw new Error("the program blew up");
      return o.receipt ?? "settled";
    },
  };
  const obligations: RefundObligationPort = {
    async owe(d) {
      events.push("owe");
      if (o.owe === "throws") throw new Error("08006 connection failure");
      owed.push(d);
    },
    async settle(_accountId, attempt) {
      events.push("settle");
      if (o.settle === "throws") throw new Error("57014 statement timeout");
      settled.push(attempt);
    },
  };
  return { gate, obligations, events, releases, owed, settled, said, say: (f: ReverseChargeFact) => { said.push(f); } };
}

describe("reverseCharge — the debt, the release, the settlement", () => {
  it("writes the debt, releases the refund naming the attempt, then settles the debt", async () => {
    const r = rig();
    expect(await reverseCharge(r.gate, r.obligations, CHARGE, r.say)).toEqual({ receipt: "settled", owed: true });
    expect(r.events).toEqual(["owe", "release", "settle"]);
    expect(r.owed).toEqual([CHARGE]);
    expect(r.releases).toEqual([{
      action: "screener", attemptKey: "msg-1", refund: true, attempt: "attempt-7", meta: { messageId: "msg-1" },
    }]);
    expect(r.settled).toEqual(["attempt-7"]);
    expect(r.said).toEqual([]);
  });

  it("a LOST release leaves the written debt unsettled, for the drain", async () => {
    const r = rig({ receipt: "unreachable" });
    expect(await reverseCharge(r.gate, r.obligations, CHARGE, r.say)).toEqual({ receipt: "unreachable", owed: true });
    expect(r.events).toEqual(["owe", "release"]);
    expect(r.settled).toEqual([]);
  });

  it("a debt write that THROWS is said, the refund is still released, and nothing is settled", async () => {
    const r = rig({ owe: "throws" });
    expect(await reverseCharge(r.gate, r.obligations, CHARGE, r.say)).toEqual({ receipt: "settled", owed: false });
    expect(r.events, "the refund was skipped, or an unwritten debt was settled").toEqual(["owe", "release"]);
    expect(r.said).toEqual([{ fact: "unrecorded", err: expect.objectContaining({ message: "08006 connection failure" }) }]);
  });

  it("a debt write that throws and a LOST release: nothing is settled and nothing is owed on record", async () => {
    const r = rig({ owe: "throws", receipt: "unreachable" });
    expect(await reverseCharge(r.gate, r.obligations, CHARGE, r.say)).toEqual({ receipt: "unreachable", owed: false });
    expect(r.events).toEqual(["owe", "release"]);
  });

  it("with NO store composed the debt is said and the refund is still released", async () => {
    const r = rig();
    expect(await reverseCharge(r.gate, undefined, CHARGE, r.say)).toEqual({ receipt: "settled", owed: false });
    expect(r.events).toEqual(["release"]);
    expect(r.said).toEqual([{ fact: "no_store" }]);
  });

  it("a settle that THROWS after a settled refund is said, never thrown, and the receipt stands", async () => {
    const r = rig({ settle: "throws" });
    expect(await reverseCharge(r.gate, r.obligations, CHARGE, r.say)).toEqual({ receipt: "settled", owed: true });
    expect(r.events).toEqual(["owe", "release", "settle"]);
    expect(r.said).toEqual([{ fact: "settle_failed", err: expect.objectContaining({ message: "57014 statement timeout" }) }]);
  });

  it("a release that THROWS propagates after the debt is written, and nothing is settled", async () => {
    const r = rig({ receipt: "throws" });
    await expect(reverseCharge(r.gate, r.obligations, CHARGE, r.say)).rejects.toThrow("the program blew up");
    expect(r.events).toEqual(["owe", "release"]);
    expect(r.owed).toEqual([CHARGE]);
  });

  it("the usage rides the refund and never the debt", async () => {
    const r = rig();
    await reverseCharge(r.gate, r.obligations, { ...CHARGE, usage: [LINE] }, r.say);
    expect(r.owed).toEqual([CHARGE]);
    expect(r.releases[0]).toMatchObject({ refund: true, attempt: "attempt-7", usage: [LINE] });
  });
});

/* ── THE DEBT HAS ONE WRITER IN THIS MODULE ─────────────────────────────────────────────────
 * Every `owe`, `release` and `settle` call in the port module sits inside `reverseCharge`, once
 * each and in that order. Read from CALL expressions, so a comment or a string is no call; the
 * reading is proved on a planted fixture first.
 */
function portCalls(src: string): { inside: string[]; outside: string[] } {
  const sf = ts.createSourceFile("port.ts", src, ts.ScriptTarget.Latest, true);
  const doors: ts.Node[] = [];
  const find = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === "reverseCharge") doors.push(n);
    ts.forEachChild(n, find);
  };
  find(sf);
  const out = { inside: [] as string[], outside: [] as string[] };
  const walk = (x: ts.Node): void => {
    if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression)
      && ["owe", "release", "settle"].includes(x.expression.name.text)) {
      (doors.some((d) => x.pos >= d.pos && x.end <= d.end) ? out.inside : out.outside).push(x.expression.name.text);
    }
    ts.forEachChild(x, walk);
  };
  walk(sf);
  return out;
}

describe("reverseCharge is the only caller of the debt in the port module", () => {
  it("reads a planted call beside the door, and not a comment or a string", () => {
    const planted = `
      export async function reverseCharge(g: G, o: O): Promise<void> { await o.owe(); await g.release(); await o.settle(); }
      // o.owe() used to live here
      const s = "o.settle()"; void s;
      export async function beside(o: O): Promise<void> { await o.owe(); }`;
    expect(portCalls(planted)).toEqual({ inside: ["owe", "release", "settle"], outside: ["owe"] });
  });

  it("the port module calls owe, release and settle once each, in that order, inside reverseCharge", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/entitlements-port.ts", import.meta.url)), "utf8");
    expect(portCalls(src)).toEqual({ inside: ["owe", "release", "settle"], outside: [] });
  });
});
