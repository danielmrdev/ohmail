import { describe, it, expect } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { folderState, rules } from "@trafficflow/db";
import { MessageGoneError } from "@trafficflow/core/adapters/imap";
import type { AdapterPort, NativeLocator } from "@trafficflow/core";
import { ScreenerService } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * ARM 4, THE FRONT DOOR — **A SCREENER VERDICT THAT COMMITTED MUST NOT BE
 * REPORTED AS A SERVER ERROR.**
 *
 * `decide` commits everything that matters in ONE transaction: the promoted rule, the contact, the
 * per-message `desired_folder` with `reconcile_status: 'pending'`, the `change_log` deltas, and the
 * idempotency claim holding a 200. The physical IMAP move afterwards is an OPPORTUNISTIC extra —
 * the hosted API path frequently has no adapter injected at all, in which case the move is left
 * entirely to the worker and nobody considers that a failure.
 *
 * So when one message's source locator went stale and `applyReconcileAction` threw, three things
 * happened at once, and the third is the worst:
 *
 *  · the person was shown a 500 for a decision that had committed and was converging;
 *  · every message BEHIND the refusal lost its opportunistic move for this call;
 *  · the stored idempotency response was a 200, so a retry replayed success for a request they had
 *    just watched fail.
 *
 * These cases pin the outcome rather than the mechanism: the verdict succeeds, every message is
 * queued with the right desire, and the healthy ones still move now.
 */

const YES = { decision: "yes" as const, confidence: 0.9, reason: "known", modelVersion: "t" };

/** Refuses exactly the named refs with the adapter's own gone error. */
function partlyGone(goneRefs: Set<string>): AdapterPort & { moves: string[] } {
  const moves: string[] = [];
  let uid = 5000;
  return {
    moves,
    async move(locator: NativeLocator, to: string): Promise<NativeLocator> {
      if (goneRefs.has(locator.ref)) throw new MessageGoneError(locator);
      moves.push(locator.ref);
      return { folder: String(to), ref: `19:${++uid}` };
    },
  } as AdapterPort & { moves: string[] };
}

function classifierReturning(r: typeof YES) {
  return { classify: async () => r } as never;
}

describe("a Screener verdict over a message whose locator went stale", () => {
  it("the verdict SUCCEEDS, and the message that could not move is queued rather than lost", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const stale = await seedMessage(db, accountId, mailboxId, { from: "alice@ex.example", subject: "first", ref: "12:1" });
    const healthy = await seedMessage(db, accountId, mailboxId, { from: "alice@ex.example", subject: "second", ref: "12:2" });
    const adapter = partlyGone(new Set(["12:1"]));
    const svc = new ScreenerService({ adapter, classifier: classifierReturning(YES) });

    const rep = (await svc.list(ctx, {})).items[0]!;
    // NO THROW. This is the assertion: before the fix this rejected, and the route turned it into
    // a 500 over a press the person had every right to see succeed.
    const res = await svc.decide(ctx, rep.id, { decision: "yes" });
    expect(res.appliedFolder).toBe("INBOX");

    // The rule committed, exactly as on the adapter-less path.
    const ruleRows = await db.select().from(rules).where(eq(rules.accountId, accountId));
    expect(ruleRows.some((r) => r.match === "alice@ex.example" && r.destination === "INBOX")).toBe(true);

    // BOTH messages carry the decision. The stale one is pending — which is the queue the
    // organizer drains — and the healthy one has converged.
    const rows = await db.select().from(folderState).where(inArray(folderState.messageId, [stale, healthy]));
    const byId = new Map(rows.map((r) => [r.messageId, r]));
    expect(byId.get(stale)!.desiredFolder).toBe("INBOX");
    expect(byId.get(stale)!.observedFolder).toBe("ohmail/Screener");
    expect(byId.get(healthy)!.desiredFolder).toBe("INBOX");
    expect(byId.get(healthy)!.observedFolder).toBe("INBOX");

    // AND THE MESSAGE BEHIND THE REFUSAL STILL MOVED NOW. A loop that aborted on the first stale
    // locator left this one waiting on a worker cycle for no reason.
    expect(adapter.moves).toEqual(["12:2"]);
  });

  it("a mailbox whose Screener folder was recycled wholesale still returns the verdict, with every message queued", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const ids = [
      await seedMessage(db, accountId, mailboxId, { from: "alice@ex.example", subject: "a", ref: "12:1" }),
      await seedMessage(db, accountId, mailboxId, { from: "alice@ex.example", subject: "b", ref: "12:2" }),
    ];
    const adapter = partlyGone(new Set(["12:1", "12:2"]));
    const svc = new ScreenerService({ adapter, classifier: classifierReturning(YES) });

    const rep = (await svc.list(ctx, {})).items[0]!;
    const res = await svc.decide(ctx, rep.id, { decision: "yes" });
    expect(res.appliedFolder).toBe("INBOX");
    expect(adapter.moves).toEqual([]);

    // Every row queued: `desired` is the verdict, `observed` is the truth. Nothing claims a move
    // that did not happen, and nothing is dropped.
    const rows = await db.select().from(folderState).where(inArray(folderState.messageId, ids));
    for (const r of rows) {
      expect(r.desiredFolder).toBe("INBOX");
      expect(r.observedFolder).toBe("ohmail/Screener");
    }
  });
});
