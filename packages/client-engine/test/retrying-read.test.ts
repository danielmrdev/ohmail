import { describe, expect, it } from "vitest";
import {
  HttpAdapter,
  OUTBOX_BACKOFF_CAP_MS,
  RETRYING_READ_ATTEMPTS,
  retryingRead,
} from "@ohmail/client-engine";

/**
 * THE RETRYING READ — a `503` that names a `Retry-After` is asked again, a write never is.
 *
 * The API answers `503 db_busy` with `Retry-After: 5` and the mutation queue has honoured it
 * since the header shipped. The client's READS did not: one refusal was the whole answer, so a
 * poll rendered "can't check" for a server that had said when to come back. These arms watch the
 * one wrapper the reads now share.
 */

const busy = (seconds: string | null): Response =>
  new Response("{\"code\":\"db_busy\"}", {
    status: 503,
    ...(seconds === null ? {} : { headers: { "retry-after": seconds } }),
  });

const ok = (): Response => new Response("{\"items\":[]}", { status: 200 });

/** Every wait the wrapper asked for, and no wall clock anywhere. */
function recorder(): { waits: number[]; waitFor: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return { waits, waitFor: async (ms) => { waits.push(ms); } };
}

describe("retryingRead", () => {
  it("waits the interval the server named, once, and then has its answer", async () => {
    const rec = recorder();
    const answers = [busy("5"), ok()];
    let asked = 0;
    const read = retryingRead(async () => { asked++; return answers.shift()!; }, { waitFor: rec.waitFor });

    const res = await read("/local/mailboxes/connections");

    expect(res.status).toBe(200);
    expect(asked, "the read was asked twice — the refusal and the answer").toBe(2);
    expect(rec.waits).toEqual([5_000]);
  });

  it("clamps a wait no queue would honour to the cap the mutation path uses", async () => {
    const rec = recorder();
    // A week, which a proxy is free to send. `min(header, cap)` is the mutation queue's own rule.
    const answers = [busy("604800"), ok()];
    const read = retryingRead(async () => answers.shift()!, { waitFor: rec.waitFor });

    await read("/mailboxes");

    expect(rec.waits).toEqual([OUTBOX_BACKOFF_CAP_MS]);
  });

  it("gives up after the attempt bound and hands back the last refusal", async () => {
    const rec = recorder();
    let asked = 0;
    const read = retryingRead(async () => { asked++; return busy("1"); }, { waitFor: rec.waitFor });

    const res = await read("/mailboxes");

    /* THE GIVE-UP IS THE 503 ITSELF, not a throw and not a synthetic status: every caller's
       existing derivation of "the server is not answering" already reads it. */
    expect(res.status).toBe(503);
    expect(asked).toBe(RETRYING_READ_ATTEMPTS);
    expect(rec.waits.length).toBe(RETRYING_READ_ATTEMPTS - 1);
  });

  it("does not retry a 503 that names no interval", async () => {
    const rec = recorder();
    let asked = 0;
    const read = retryingRead(async () => { asked++; return busy(null); }, { waitFor: rec.waitFor });

    const res = await read("/mailboxes");

    /* A misconfigured host answers 503 and names nothing. Retrying it would be a client
       inventing an interval the server never offered. */
    expect(res.status).toBe(503);
    expect(asked).toBe(1);
    expect(rec.waits).toEqual([]);
  });

  it("does not retry a NON-503 that names an interval either", async () => {
    const rec = recorder();
    let asked = 0;
    const read = retryingRead(
      async () => { asked++; return new Response("{}", { status: 429, headers: { "retry-after": "5" } }); },
      { waitFor: rec.waitFor },
    );

    const res = await read("/mailboxes");

    /* THE DISCRIMINATOR between the status test and the header test. A 429 carrying an interval
       is a real shape and it is not this rule's: the answer being retried is a pool declining
       work it has not started (`503 db_busy`), and a client that read every `Retry-After` as an
       invitation would re-ask a rate limiter it has just been told to back off from. Written
       because the 500 case below stays green when the status test is removed — the absent header
       covers for it, so that pair measures neither half on its own. */
    expect(res.status).toBe(429);
    expect(asked).toBe(1);
    expect(rec.waits).toEqual([]);
  });

  it("does not retry an answer that is not a 503, and leaves its body readable", async () => {
    let asked = 0;
    const read = retryingRead(async () => { asked++; return new Response("{\"a\":1}", { status: 500 }); });

    const res = await read("/mailboxes");

    expect(asked).toBe(1);
    /* THE BODY IS NEVER CONSUMED. The decision is status plus header, so a caller that reads the
       refusal's own JSON still can — which is what `readMailboxReachVia` does. */
    expect(await res.json()).toEqual({ a: 1 });
  });

  it("REFUSES a write rather than passing it through", async () => {
    let asked = 0;
    const read = retryingRead(async () => { asked++; return ok(); });

    await expect(read("/drafts/d1", { method: "PUT" })).rejects.toThrow(/GET only/);
    await expect(read("/messages/m1/move", { method: "post" })).rejects.toThrow(/GET only/);
    expect(asked, "nothing reached the transport").toBe(0);
  });

  it("treats an absent method as the GET it is", async () => {
    const read = retryingRead(async () => ok());
    expect((await read("/mailboxes")).status).toBe(200);
    expect((await read("/mailboxes", { method: "get" })).status).toBe(200);
  });
});

describe("HttpAdapter reads ride the wrapper and writes do not", () => {
  it("retries a GET the server refused with an interval", async () => {
    const waits: number[] = [];
    const answers = [busy("5"), new Response(JSON.stringify({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "1", hasMore: false, serverTime: "2026-09-10T00:00:00.000Z",
    }), { status: 200 })];
    let asked = 0;
    const adapter = new HttpAdapter({
      baseUrl: "",
      fetch: async () => { asked++; return answers.shift()!; },
      readWaitFor: async (ms) => { waits.push(ms); },
    });

    const page = await adapter.sync({ since: "0" });

    expect(page.cursor).toBe("1");
    expect(asked).toBe(2);
    expect(waits).toEqual([5_000]);
  });

  it("asks a mutation exactly once, whatever the server names", async () => {
    let asked = 0;
    const adapter = new HttpAdapter({
      baseUrl: "",
      fetch: async () => { asked++; return busy("5"); },
      readWaitFor: async () => { throw new Error("a write must never reach the read wrapper"); },
    });

    await expect(adapter.mutate(
      { kind: "draft_discard", draftId: "d1" },
      { idempotencyKey: "k1" },
    )).rejects.toThrow();
    /* ONE attempt. The durable outbox is what retries a verb, under its own key and its own
       backoff; a second attempt from inside the transport would be an invisible duplicate. */
    expect(asked).toBe(1);
  });
});
