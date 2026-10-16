import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { drafts } from "@trafficflow/db";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { makeDeps, seedSession, seedMailbox, req, FIXED_NOW } from "./helpers.js";

/**
 * ═══ A REPLAYED SEND KEY SAYS WHOSE SEND IT IS ANSWERING FROM ═══════════════════════════════
 * One intent carries one key while it is retryable, which stops a second press delivering a
 * second copy. The cost: that press is answered from the FIRST one's reservation, and the 200
 * was the same shape a fresh send returns — so a client announced the newer words as sent when
 * they had not been. `firstSend` is that statement, in the shape the duplicate refusal carries.
 * Mutations: the field dropped from the service's replay arm, or the route not passing it
 * through → case 2 each; the field put on the fresh arm → case 1; the shapes drifting → case 3.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

function fakeAdapter() {
  const state = { sendCalls: 0, delivered: [] as OutboundMessage[] };
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      state.sendCalls += 1;
      state.delivered.push(msg);
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() { return false; },
    async close() { /* no-op */ },
  });
  return { factory, state };
}

async function world() {
  const { factory, state } = fakeAdapter();
  const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
  const s = await seedSession(db, { now: FIXED_NOW });
  const mailboxId = await seedMailbox(db, { accountId: s.accountId });
  const make = async (body: string): Promise<string> => {
    const [d] = await db.insert(drafts).values({
      accountId: s.accountId, mailboxId, subject: "the invoice", body,
      to: [{ name: null, address: "chosen@example.com" }], status: "draft",
    } as never).returning();
    return d!.id;
  };
  const send = (draftId: string, key: string): Promise<Response> =>
    H(req("POST", `/drafts/${draftId}/send`, {
      bearer: s.token, headers: { "idempotency-key": key },
    }), deps);
  return { db, deps, s, make, send, state };
}

describe("POST /drafts/:id/send — a key that was already settled", () => {
  it("1 — an ordinary send names no earlier one", async () => {
    const { make, send, state } = await world();
    const res = await send(await make("the first words"), "key-ordinary");
    const wire = (await res.json()) as Record<string, unknown>;

    expect(
      { status: res.status, sent: wire.status, firstSend: wire.firstSend ?? null, delivered: state.sendCalls },
      "a fresh send claimed to be answering for somebody else's press",
    ).toEqual({ status: 200, sent: "sent", firstSend: null, delivered: 1 });
  });

  /**
   * THE WHOLE POINT. The second press names a DIFFERENT draft row — which is what a resumed key
   * over freshly written words really is — and the key is what decides the answer. One delivery,
   * and the answer says it was the first one's.
   */
  it("2 — a second press under the same key is answered from the first, and says so", async () => {
    const { make, send, state } = await world();
    await send(await make("the first words"), "key-resumed");
    const second = await send(await make("the words I typed after"), "key-resumed");
    const wire = (await second.json()) as { status?: string; firstSend?: { status?: string; at?: string } };

    expect(state.delivered.map((m) => m.text), "the second press delivered a second message").toEqual(["the first words"]);
    expect(
      {
        http: second.status, status: wire.status,
        firstStatus: wire.firstSend?.status,
        atIsIso: typeof wire.firstSend?.at === "string" && !Number.isNaN(Date.parse(wire.firstSend!.at!)),
      },
      "the replay was indistinguishable from a fresh send",
    ).toEqual({ http: 200, status: "sent", firstStatus: "sent", atIsIso: true });
  });

  /**
   * ONE SHAPE, TWO DOORS. The 409 that refuses a duplicate and the 200 that replays a settled key
   * say the same thing about the same row; a client that learned to read one must not have to
   * learn the other. Both are built by `firstSendFacts`, and this is what would catch a drift.
   */
  it("3 — the duplicate refusal and the replay carry the same shape", async () => {
    const { make, send } = await world();
    // TWO ROWS, ONE MESSAGE. The content claim is what the duplicate refusal is about, so the
    // second press is a different draft saying exactly the same thing under a different key.
    await send(await make("one message, two presses"), "key-a");
    const dup = await send(await make("one message, two presses"), "key-b");
    const dupBody = (await dup.json()) as { error?: { code?: string; details?: { firstSend?: Record<string, unknown> } } };

    // And the replay: one key, two presses, the second answered from the first's reservation.
    await send(await make("a different message"), "key-c");
    const replayBody = (await (await send(await make("a different message, retyped"), "key-c")).json()) as
      { firstSend?: Record<string, unknown> };

    const keysOf = (o: Record<string, unknown> | undefined) => Object.keys(o ?? {}).sort();
    expect(
      {
        refusedWith: dupBody.error?.code,
        refusal: keysOf(dupBody.error?.details?.firstSend),
        replay: keysOf(replayBody.firstSend),
      },
      "the two doors describe the same earlier send differently",
    ).toEqual({ refusedWith: "duplicate_send", refusal: ["at", "status"], replay: ["at", "status"] });
  });
});
