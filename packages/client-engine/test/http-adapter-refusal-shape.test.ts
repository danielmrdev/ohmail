import { describe, expect, it } from "vitest";
import { HttpAdapter, MutationRejectedError } from "@ohmail/client-engine";
import { classifyRefusal } from "../src/adapters/refusal-shape.js";

/**
 * A REFUSAL WITHOUT OUR ENVELOPE IS CLASSIFIED BY ITS STATUS. Measured 2026-09-21 in the real
 * webapp: one 401 answered with an HTML body on a message's body and attachment-list reads left
 * "Couldn't load this message's files." (no Retry) and "Couldn't load the full message" standing
 * for the whole session — nothing probed the session, nothing re-asked — while the API's own
 * coded 401 healed in 0.7 s through probe → refresh → revival. The difference: `code: null` from
 * an unreadable body and `retryable: false` from the 4xx default.
 * Mutation (kit/mutate/mutation-control.sh): replace `status === 401 ? "unauthorized" : null` with
 * `null` — four cases red; the envelope cases stay green, which is the point.
 */
function fetchAnswering(status: number, body: string, contentType: string): typeof globalThis.fetch {
  return (() => Promise.resolve(new Response(body, { status, headers: { "content-type": contentType } }))) as typeof globalThis.fetch;
}

function adapterWith(fetchImpl: typeof globalThis.fetch): HttpAdapter {
  return new HttpAdapter({ baseUrl: "https://api.test", fetch: fetchImpl });
}

async function refusalOf(run: () => Promise<unknown>): Promise<MutationRejectedError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof MutationRejectedError) return err;
    throw err;
  }
  throw new Error("the read answered instead of refusing");
}

describe("classifyRefusal — the status decides where the envelope is missing", () => {
  it("an envelope-less 401 on a read carries the session's code and stays retryable", () => {
    expect(classifyRefusal(401, undefined, "read")).toEqual({ code: "unauthorized", retryable: true });
  });
  it("an envelope-less 401 on a WRITE carries the code and keeps the write's default", () => {
    expect(classifyRefusal(401, undefined, "write")).toEqual({ code: "unauthorized", retryable: false });
  });
  it("an envelope-less 4xx on a read is unclassified but retryable — not a proven content refusal", () => {
    expect(classifyRefusal(403, undefined, "read")).toEqual({ code: null, retryable: true });
    expect(classifyRefusal(404, undefined, "read")).toEqual({ code: null, retryable: true });
  });
  it("an envelope-less 4xx on a write is NOT retryable — the outbox must not loop on a platform page", () => {
    expect(classifyRefusal(413, undefined, "write")).toEqual({ code: null, retryable: false });
    expect(classifyRefusal(503, undefined, "write")).toEqual({ code: null, retryable: true });
  });
  it("the server's own envelope rules unchanged — code and retryable verbatim, default 5xx/429", () => {
    expect(classifyRefusal(404, { code: "not_found" }, "read")).toEqual({ code: "not_found", retryable: false });
    expect(classifyRefusal(503, { code: "db_busy", retryable: true }, "read")).toEqual({ code: "db_busy", retryable: true });
    expect(classifyRefusal(409, { code: "conflict", retryable: false }, "write")).toEqual({ code: "conflict", retryable: false });
    expect(classifyRefusal(429, { code: "rate_limited" }, "write")).toEqual({ code: "rate_limited", retryable: true });
  });
});

describe("HttpAdapter reads — the classification reaches the thrown MutationRejectedError", () => {
  it("an HTML 401 on the attachment list is an auth-shaped, retryable refusal", async () => {
    const a = adapterWith(fetchAnswering(401, "<html>Unauthorized</html>", "text/html"));
    const err = await refusalOf(() => a.listAttachments("m-1"));
    expect(err.status).toBe(401);
    expect(err.code).toBe("unauthorized");
    expect(err.retryable).toBe(true);
  });
  it("an HTML 401 on the body read is the same shape", async () => {
    const a = adapterWith(fetchAnswering(401, "<html>Unauthorized</html>", "text/html"));
    const err = await refusalOf(() => a.fetchBody("m-1"));
    expect(err.code).toBe("unauthorized");
    expect(err.retryable).toBe(true);
  });
  it("a text 403 on the attachment list is unclassified and retryable — Retry is offered", async () => {
    const a = adapterWith(fetchAnswering(403, "Forbidden", "text/plain"));
    const err = await refusalOf(() => a.listAttachments("m-1"));
    expect(err.code).toBeNull();
    expect(err.retryable).toBe(true);
  });
  it("the API's own 404 envelope on a read keeps its code and is NOT retryable", async () => {
    const a = adapterWith(fetchAnswering(404, JSON.stringify({ error: { code: "not_found", message: "message not found" } }), "application/json"));
    const err = await refusalOf(() => a.listAttachments("m-1"));
    expect(err.code).toBe("not_found");
    expect(err.retryable).toBe(false);
    expect(err.message).toBe("message not found");
  });
});
