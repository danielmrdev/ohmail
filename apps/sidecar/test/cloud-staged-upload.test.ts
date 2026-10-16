import { describe, expect, it } from "vitest";
import {
  createStagedUploads, STAGED_GRANTS_KEPT, STAGED_UPLOAD_PATH_PREFIX,
} from "../src/cloud-staged-upload.js";

/**
 * THE HOSTED DOOR'S STAGED UPLOADS, at this process's door. The window cannot reach storage, so
 * the relayed mint is rewritten: the signed grant stays here, the window gets a root-relative
 * path, and its PUT there is carried to the grant with the grant's method and headers verbatim.
 *
 * Mutations watched: hand the window the signed URL (drop the rewrite) → the "never reaches the
 * window" case goes red; add our bearer to the PUT → the credential case goes red; PUT to a URL
 * the window names → the unknown-ticket case goes red.
 */

const SIGNED = "https://storage.example/upload/sign/staging/t-1?token=secret-signature";

const minted = (over: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({
    id: "t-1", uploadUrl: SIGNED, uploadMethod: "PUT",
    uploadHeaders: { "content-type": "video/mp4", "x-upsert": "false" },
    expiresAt: "2026-10-16T12:00:00.000Z", ...over,
  }), { status: 201, headers: { "content-type": "application/json", "content-length": "999" } });

interface Put { url: string; method: string; headers: Record<string, string>; bytes: number }

function storage(status = 200) {
  const puts: Put[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    puts.push({ url, method: init?.method ?? "GET", headers, bytes: (init?.body as ArrayBuffer).byteLength });
    return new Response("", { status, headers: status === 429 ? { "retry-after": "7" } : {} });
  }) as typeof fetch;
  return { puts, fetchImpl };
}

const putReq = (id: string, bytes: number, headers: Record<string, string> = {}): Request =>
  new Request(`http://engine.local${STAGED_UPLOAD_PATH_PREFIX}${id}`, {
    method: "PUT", headers, body: new Uint8Array(bytes),
  });

describe("the relayed ticket is rewritten", () => {
  it("the window gets a root-relative path and never the signed URL", async () => {
    const staged = createStagedUploads({ fetchImpl: storage().fetchImpl });
    const res = await staged.rewriteMint(minted());
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain("storage.example");
    expect(text).not.toContain("secret-signature");
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.uploadUrl).toBe(`${STAGED_UPLOAD_PATH_PREFIX}t-1`);
    expect(body.uploadMethod).toBe("PUT");
    expect(body.uploadHeaders).toEqual({});
    // Everything else the account said travels unchanged.
    expect(body.id).toBe("t-1");
    expect(body.expiresAt).toBe("2026-10-16T12:00:00.000Z");
    // The rewritten body is not described by the account's length.
    expect(res.headers.get("content-length")).not.toBe("999");
  });

  it("a refusal passes through untouched", async () => {
    const staged = createStagedUploads({ fetchImpl: storage().fetchImpl });
    const refusal = new Response(JSON.stringify({ error: { code: "payload_too_large" } }), { status: 413 });
    const res = await staged.rewriteMint(refusal);
    expect(res.status).toBe(413);
    expect(await res.text()).toContain("payload_too_large");
  });

  it("a ticket this door cannot carry goes back WITHOUT an upload URL, never with the signed one", async () => {
    const staged = createStagedUploads({ fetchImpl: storage().fetchImpl });
    const res = await staged.rewriteMint(minted({ id: "bad id/../x" }));
    const body = JSON.parse(await res.text()) as Record<string, unknown>;
    expect(body.uploadUrl).toBeUndefined();
  });
});

describe("the window's PUT is carried to the grant", () => {
  it("with the grant's method and headers verbatim, the bytes whole, and no credential of ours", async () => {
    const { puts, fetchImpl } = storage();
    const staged = createStagedUploads({ fetchImpl });
    await staged.rewriteMint(minted());
    const res = await staged.upload(putReq("t-1", 4 * 1024 * 1024, { authorization: "Bearer launch-token" }));
    expect(res.status).toBe(200);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toBe(SIGNED);
    expect(puts[0]!.method).toBe("PUT");
    expect(puts[0]!.headers).toEqual({ "content-type": "video/mp4", "x-upsert": "false" });
    expect(puts[0]!.bytes).toBe(4 * 1024 * 1024);
  });

  it("a ticket this process never minted is refused retryably and nothing is sent", async () => {
    const { puts, fetchImpl } = storage();
    const staged = createStagedUploads({ fetchImpl });
    const res = await staged.upload(putReq("t-never", 10));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(puts).toHaveLength(0);
  });

  it("storage's own refusal reaches the window with its status and Retry-After", async () => {
    const { fetchImpl } = storage(429);
    const staged = createStagedUploads({ fetchImpl });
    await staged.rewriteMint(minted());
    const res = await staged.upload(putReq("t-1", 10));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
  });

  it("an unreachable storage is a retryable 503, and the log line carries no URL", async () => {
    const lines: Array<[string, Record<string, unknown>]> = [];
    const staged = createStagedUploads({
      fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch,
      log: (event, detail) => { lines.push([event, detail]); },
    });
    await staged.rewriteMint(minted());
    const res = await staged.upload(putReq("t-1", 10));
    expect(res.status).toBe(503);
    expect(lines.map(([e]) => e)).toEqual(["cloud_staged_upload_failed"]);
    expect(JSON.stringify(lines[0]![1])).not.toContain("storage.example");
  });

  it("the grants are bounded, the oldest dropped first", async () => {
    const staged = createStagedUploads({ fetchImpl: storage().fetchImpl });
    for (let i = 0; i <= STAGED_GRANTS_KEPT; i += 1) await staged.rewriteMint(minted({ id: `t-${i}` }));
    expect((await staged.upload(putReq("t-0", 1))).status).toBe(503);
    expect((await staged.upload(putReq(`t-${STAGED_GRANTS_KEPT}`, 1))).status).toBe(200);
  });
});
