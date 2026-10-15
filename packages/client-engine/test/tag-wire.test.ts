import { describe, expect, it } from "vitest";
import { HttpAdapter } from "@ohmail/client-engine";

/**
 * THE TAG VERB REACHES THE WIRE, AND IN THE RIGHT SHAPE.
 *
 * This file exists because of the exact failure the slice was written to end. `tag_assign` was
 * mapped to `throw new UnsupportedMutationError(m.kind)` for the whole of Stage 2, so on every
 * real Cloud account the tag picker, the `t` shortcut and the bulk verb all painted their
 * optimistic effect and were then silently rolled back. Nothing was red: `FixturesAdapter`
 * serves the same mutation in place, so the demo world — which is what the suite exercised —
 * worked perfectly. A feature can be fully built, fully tested and completely unreachable, and
 * the only assertion that catches it is one that watches the HTTP call.
 *
 * The second assertion is about the BODY, and it is not cosmetic. `EngineMutation.tag_assign`
 * carries a `labels` array filled by `Engine.enrich`, and sending THAT to the server would be a
 * read-modify-write: two concurrent toggles of different tags on one message each compute their
 * array from the same starting state and the later request erases the earlier one's tag. The
 * array is for the optimistic overlay; the wire gets a delta. If someone ever "simplifies" this
 * by forwarding `m.labels`, this test is what says no.
 */

interface Captured { method: string; url: string; body: unknown }

function adapterCapturing(into: Captured[], response: Response): HttpAdapter {
  return new HttpAdapter({
    baseUrl: "https://api.test",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      into.push({
        method: init?.method ?? "GET",
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return response.clone();
    }) as unknown as typeof globalThis.fetch,
  });
}

const ok = (body: unknown, seq?: string): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: seq
      ? { "content-type": "application/json", "X-Sync-Seq": seq }
      : { "content-type": "application/json" },
  });

describe("tag_assign is a real HTTP call, not an UnsupportedMutationError", () => {
  it("POSTs the DELTA to /messages/:id/tags — never the labels array", async () => {
    const calls: Captured[] = [];
    const adapter = adapterCapturing(calls, ok({ labels: ["t-1"], tagId: "t-1" }, "42"));

    const res = await adapter.mutate(
      {
        kind: "tag_assign",
        messageId: "m-1",
        tagId: "t-1",
        assigned: true,
        // Present, and deliberately NOT what goes on the wire.
        labels: ["t-1", "t-9"],
      },
      { idempotencyKey: "idem-1" },
    );

    expect(calls, "the mutation never reached the network").toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.test/messages/m-1/tags");
    // The delta, and ONLY the delta.
    expect(calls[0]!.body).toEqual({ tagId: "t-1", assigned: true });
    expect(calls[0]!.body).not.toHaveProperty("labels");
    // No fabricated changes — the authoritative drain is what updates the mirror.
    expect(res.changes).toEqual([]);
    expect(res.seq).toBe(42);
  });

  it("unassign is the same verb with assigned:false, not a DELETE", async () => {
    const calls: Captured[] = [];
    const adapter = adapterCapturing(calls, ok({ labels: [], tagId: "t-1" }));

    await adapter.mutate(
      { kind: "tag_assign", messageId: "m-2", tagId: "t-1", assigned: false, labels: [] },
      { idempotencyKey: "idem-2" },
    );

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ tagId: "t-1", assigned: false });
  });

  it("tag-or-create carries the typed name AND the client-minted id", async () => {
    // The only way to mint a tag from the shared shell: it may not import `app/api-client`
    // (`scripts/publish-desktop.mjs` DENYs it), so the engine is the only wire. The id travels
    // with the name so a genuinely new tag lands under the id the optimistic paint used.
    const calls: Captured[] = [];
    const adapter = adapterCapturing(calls, ok({ labels: ["new-id"], tagId: "new-id" }));

    await adapter.mutate(
      {
        kind: "tag_assign",
        messageId: "m-3",
        tagId: "new-id",
        assigned: true,
        createName: "Quarterly",
        labels: ["new-id"],
      },
      { idempotencyKey: "idem-3" },
    );

    expect(calls[0]!.url).toBe("https://api.test/messages/m-3/tags");
    expect(calls[0]!.body).toEqual({ tagId: "new-id", name: "Quarterly", assigned: true });
  });

  it("the message id is URL-encoded, so an id with a slash cannot forge a path", async () => {
    const calls: Captured[] = [];
    const adapter = adapterCapturing(calls, ok({ labels: [], tagId: "t-1" }));

    await adapter.mutate(
      { kind: "tag_assign", messageId: "a/../b", tagId: "t-1", assigned: true, labels: [] },
      { idempotencyKey: "idem-4" },
    );

    expect(calls[0]!.url).toBe("https://api.test/messages/a%2F..%2Fb/tags");
  });
});
