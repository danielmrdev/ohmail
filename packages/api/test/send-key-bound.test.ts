import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { drafts, outboundSends } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { makeDeps, seedSession, seedMailbox, req, FIXED_NOW } from "./helpers.js";
import { SEND_KEY_MAX } from "../src/routes/drafts.js";

/**
 * THE SEND KEY IS BOUNDED AT THE ROUTES: a reservation and a Cancel's tombstone keep it in a row
 * that is never pruned. The shape the clients mint is admitted; one character past the bound is
 * refused 400 with nothing stored and nothing sent. Driven through `createApp`, the real pipeline.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

async function world() {
  const delivered: OutboundMessage[] = [];
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) { delivered.push(msg); return { providerMessageId: msg.messageId! }; },
    async messageInSent() { return false; },
    async close() { /* no-op */ },
  });
  const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
  const s = await seedSession(db, { now: FIXED_NOW });
  const mailboxId = await seedMailbox(db, { accountId: s.accountId });
  const [d] = await db.insert(drafts).values({
    accountId: s.accountId, mailboxId, subject: "the invoice", body: "Here it is.",
    to: [{ name: null, address: "you@example.com" }], status: "draft",
  } as never).returning();
  const keys = async (): Promise<string[]> =>
    (await db.select({ k: outboundSends.idempotencyKey }).from(outboundSends).where(eq(outboundSends.accountId, s.accountId))).map((r) => r.k);
  return { deps, token: s.token, draftId: d!.id, delivered, keys };
}

describe("the send key's bound", () => {
  it("a key the clients mint is inside it", () => {
    expect(crypto.randomUUID().length).toBeLessThanOrEqual(SEND_KEY_MAX);
    expect(`send-${crypto.randomUUID()}`.length).toBeLessThanOrEqual(SEND_KEY_MAX);
  });

  it("POST /sends/withdraw: at the bound a Cancel is decided; one past it is refused 400 and nothing is stored", async () => {
    const w = await world();
    const at = "k".repeat(SEND_KEY_MAX);
    const ok = await H(req("POST", "/sends/withdraw", {
      bearer: w.token, headers: { "idempotency-key": at }, body: JSON.stringify({ draftId: null }),
    }), w.deps);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ outcome: "withdrawn" });

    const past = await H(req("POST", "/sends/withdraw", {
      bearer: w.token, headers: { "idempotency-key": `${at}k` }, body: JSON.stringify({ draftId: null }),
    }), w.deps);
    expect(past.status).toBe(400);
    expect(((await past.json()) as { error: { code: string } }).error.code).toBe("validation_failed");
    expect(await w.keys(), "a refused key was stored").toEqual([at]);
  });

  it("POST /drafts/:id/send: one past the bound is refused 400 and nothing is sent", async () => {
    const w = await world();
    const past = await H(req("POST", `/drafts/${w.draftId}/send`, {
      bearer: w.token, headers: { "idempotency-key": "s".repeat(SEND_KEY_MAX + 1) },
    }), w.deps);
    expect(past.status).toBe(400);
    expect({ delivered: w.delivered.length, keys: await w.keys() }).toEqual({ delivered: 0, keys: [] });
  });

  it("POST /drafts/:id/send: a key at the bound sends, once", async () => {
    const w = await world();
    const at = "s".repeat(SEND_KEY_MAX);
    const sent = await H(req("POST", `/drafts/${w.draftId}/send`, { bearer: w.token, headers: { "idempotency-key": at } }), w.deps);
    expect(sent.status).toBe(200);
    expect({ delivered: w.delivered.length, keys: await w.keys() }).toEqual({ delivered: 1, keys: [at] });
  });

  it("GET /drafts/:id/send-attempt: at the bound it answers; one past it is refused 400", async () => {
    const w = await world();
    const ask = (key: string) => H(req("GET", `/drafts/${w.draftId}/send-attempt`, { bearer: w.token, headers: { "idempotency-key": key } }), w.deps);
    const at = await ask("a".repeat(SEND_KEY_MAX));
    expect(at.status).toBe(200);
    expect(await at.json()).toEqual({ found: false });
    const past = await ask("a".repeat(SEND_KEY_MAX + 1));
    expect(past.status).toBe(400);
    expect(((await past.json()) as { error: { code: string } }).error.code).toBe("validation_failed");
  });
});
