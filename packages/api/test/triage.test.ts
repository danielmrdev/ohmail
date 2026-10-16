import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { idempotencyKeys } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { makeDeps, seedSession, seedMessage, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

describe("POST /messages/:id/triage — set state", () => {
  it("reply_later → 200 MessageStateDTO", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });

    const res = await H(req("POST", `/messages/${m.id}/triage`, { bearer: s.token, body: JSON.stringify({ state: "reply_later" }) }), deps);
    expect(res.status).toBe(200);
    const dto = await res.json();
    expect(dto).toMatchObject({ messageId: m.id, state: "reply_later" });
    expect(dto.setAt).toBeTruthy();
  });

  it("bubbled_up without untilTs → 400", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });

    const res = await H(req("POST", `/messages/${m.id}/triage`, { bearer: s.token, body: JSON.stringify({ state: "bubbled_up" }) }), deps);
    expect(res.status).toBe(400);
  });

  it("idempotent: replay same key+body → verbatim 200", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
    const body = JSON.stringify({ state: "set_aside" });

    const first = await H(req("POST", `/messages/${m.id}/triage`, { bearer: s.token, headers: { "idempotency-key": "tr1" }, body }), deps);
    expect(first.status).toBe(200);
    const firstJson = await first.json();

    const replay = await H(req("POST", `/messages/${m.id}/triage`, { bearer: s.token, headers: { "idempotency-key": "tr1" }, body }), deps);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstJson);

    const idem = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.accountId, s.accountId));
    expect(idem).toHaveLength(1);
  });
});

describe("GET /triage + views", () => {
  it("lists the reply_later pile", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
    await H(req("POST", `/messages/${m.id}/triage`, { bearer: s.token, body: JSON.stringify({ state: "reply_later" }) }), deps);

    const res = await H(req("GET", "/triage?state=reply_later", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).items.map((x: { id: string }) => x.id)).toEqual([m.id]);
  });

  it("GET /views/focus-reply returns the FocusReplyView shape", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
    await H(req("POST", `/messages/${m.id}/triage`, { bearer: s.token, body: JSON.stringify({ state: "reply_later" }) }), deps);

    const res = await H(req("GET", "/views/focus-reply", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view.remaining).toBe(1);
    expect(view.items[0].message.id).toBe(m.id);
    expect(view.items[0].draft).toBeNull();
  });

  it("GET /views/power-through returns the PowerThroughView shape (unread Imbox)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const a = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", unread: true });
    const b = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", unread: true });

    const res = await H(req("GET", "/views/power-through", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view.remaining).toBe(2);
    expect([a.id, b.id]).toContain(view.current.id); // current is one of the unread Imbox messages
    expect(view.nextCursor).not.toBeNull();
  });
});
