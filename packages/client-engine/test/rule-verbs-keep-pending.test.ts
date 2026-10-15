import { describe, expect, it } from "vitest";
import { HttpAdapter } from "../src/adapters/http-adapter.js";

/**
 * THE THREE RULE VERBS' 202 ARMS, WATCHED.
 *
 * `rule_create`, `rule_update` and `rule_delete` all read `queuedAnswer`, and nothing has ever
 * been made to fail over them: `pending-is-not-confirmed.test.ts` drives Move and Delete, and
 * the 202 census reads the SOURCE for the call rather than the behaviour. So the arm that keeps
 * a rule edit pending was unmeasured code, and the row it closes
 * (ENGINE-READS-A-QUEUED-RULE-EDIT-AS-DONE) is about exactly that arm.
 *
 * A rules door has no `organizer_requests` id, so the holder travels in `travel` and `requestId`
 * is null there rather than invented — both are asserted, because a queued answer a surface
 * cannot attribute is a sentence that cannot name who it is waiting for.
 */

const HOLDER = { kind: "local", name: "Studio laptop" };

/** A rules door answering `202 {pending, travel}` — `routes/rules.ts`'s own shape. */
function rulesDoor(status: number, body: unknown) {
  const seen: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(`${init?.method ?? "GET"} ${String(url).replace(/^https:\/\/api\.test/, "")}`);
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: status === 204 ? {} : { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { adapter: new HttpAdapter({ baseUrl: "https://api.test", fetch: fetchImpl }), seen };
}

const QUEUED = { pending: true, travel: [{ mailboxId: "mb1", holder: HOLDER }] };
const RULE = {
  id: "r1", kind: "sender", match: "a@b.test", destination: "ohmail/News",
  priority: 0, enabled: true, createdAt: "2026-09-15T08:00:00.000Z", updatedAt: "2026-09-15T08:00:00.000Z",
};

describe("a rule verb answered 202 stays pending, and the holder is named", () => {
  it("rule_update — 202 is a queued answer carrying the holder, never an applied edit", async () => {
    const { adapter } = rulesDoor(202, QUEUED);
    const out = await adapter.mutate(
      { kind: "rule_update", ruleId: "r1", destination: "ohmail/News" },
      { idempotencyKey: "k1" },
    );
    expect(out.settlement, "a recorded rule edit reported as an applied one").toBe("queued");
    expect(out.settlement === "queued" && out.queuedWith.name).toBe("Studio laptop");
    expect(out.settlement === "queued" && out.requestId, "the rules door names no request id").toBeNull();
    expect(out.changes, "a queued edit wrote nothing, so it describes no change").toEqual([]);
    expect(out.seq).toBeNull();
  });

  it("rule_delete — 202 is a delete ASKED FOR; only 204 is a rule gone", async () => {
    const queued = await rulesDoor(202, QUEUED).adapter.mutate(
      { kind: "rule_delete", ruleId: "r1" }, { idempotencyKey: "k2" },
    );
    expect(queued.settlement, "a rule still filing mail reported as revoked").toBe("queued");
    expect(queued.settlement === "queued" && queued.queuedWith.name).toBe("Studio laptop");

    /* THE POSITIVE CONTROL, and it is the arm the defect wore: a real 204 IS a rule gone, and
       must not be dragged into the queued arm by a widened read. */
    const gone = await rulesDoor(204, null).adapter.mutate(
      { kind: "rule_delete", ruleId: "r1" }, { idempotencyKey: "k3" },
    );
    expect(gone.settlement).toBeUndefined();
    expect(gone.changes).toEqual([]);
  });

  it("rule_create — 202 is a rule ASKED FOR; 201 is a rule that exists", async () => {
    const queued = await rulesDoor(202, QUEUED).adapter.mutate(
      { kind: "rule_create", ruleKind: "sender", match: "a@b.test", destination: "ohmail/News" },
      { idempotencyKey: "k4" },
    );
    expect(queued.settlement).toBe("queued");
    expect(queued.changes, "a rule nobody wrote described as a created entity").toEqual([]);

    const made = await rulesDoor(201, RULE).adapter.mutate(
      { kind: "rule_create", ruleKind: "sender", match: "a@b.test", destination: "ohmail/News" },
      { idempotencyKey: "k5" },
    );
    expect(made.settlement).toBeUndefined();
  });

  /**
   * A BODY THIS CODE CANNOT PARSE IS NOT A QUEUED ANSWER — `queuedAnswer`'s own rule, and the
   * direction that matters: guessing one would withhold a write that DID happen.
   */
  it("a 202 without `pending: true` is not read as queued", async () => {
    const out = await rulesDoor(202, { travel: [] }).adapter.mutate(
      { kind: "rule_update", ruleId: "r1", destination: "ohmail/News" },
      { idempotencyKey: "k6" },
    );
    expect(out.settlement).toBeUndefined();
  });
});
