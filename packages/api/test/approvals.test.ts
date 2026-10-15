import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { folderState, idempotencyKeys } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { makeDeps, seedSession, seedMessage, seedPendingApproval, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

async function syncMoves(deps: ApiDeps, token: string) {
  const b = await (await H(req("GET", "/sync?since=0", { bearer: token }), deps)).json();
  return b.changes.moves.map((c: { id: string; move: { from: string | null; to: string } }) => ({ id: c.id, move: c.move }));
}

describe("GET /approvals — pending queue", () => {
  it("lists pending routing approvals for the account", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", observedFolder: "INBOX" });
    const id = await seedPendingApproval(db, { accountId: s.accountId, messageId: m.id, folder: "ohmail/News" });

    const res = await H(req("GET", "/approvals?status=pending", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((a: { id: string }) => a.id)).toContain(id);
    expect(body.items[0].proposed.action).toBe("move");
  });
});

describe("POST /approvals/:id — decide (defer + idempotency)", () => {
  it("approve → 200 approved, folder_state pending (deferred, no IMAP), emits a move change", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", observedFolder: "INBOX" });
    const id = await seedPendingApproval(db, { accountId: s.accountId, messageId: m.id, folder: "ohmail/News" });

    const res = await H(req("POST", `/approvals/${id}`, { bearer: s.token, body: JSON.stringify({ decision: "approve" }) }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("approved");

    // Defer proof: desired set, reconcileStatus still 'pending' (the API opened no IMAP).
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, m.id));
    expect(fs).toMatchObject({ desiredFolder: "ohmail/News", reconcileStatus: "pending", lastSetBy: "us" });

    expect((await syncMoves(deps, s.token)).find((x: { id: string }) => x.id === m.id)?.move)
      .toEqual({ from: "INBOX", to: "ohmail/News" });
  });

  it("deciding again (already approved) → 422", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", observedFolder: "INBOX" });
    const id = await seedPendingApproval(db, { accountId: s.accountId, messageId: m.id, folder: "ohmail/News" });

    expect((await H(req("POST", `/approvals/${id}`, { bearer: s.token, body: JSON.stringify({ decision: "approve" }) }), deps)).status).toBe(200);
    expect((await H(req("POST", `/approvals/${id}`, { bearer: s.token, body: JSON.stringify({ decision: "approve" }) }), deps)).status).toBe(422);
  });

  it("idempotent: replay same key+body → verbatim 200 (not 422); different body same key → 409", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", observedFolder: "INBOX" });
    const id = await seedPendingApproval(db, { accountId: s.accountId, messageId: m.id, folder: "ohmail/News" });
    const body = JSON.stringify({ decision: "approve" });

    const first = await H(req("POST", `/approvals/${id}`, { bearer: s.token, headers: { "idempotency-key": "ap1" }, body }), deps);
    expect(first.status).toBe(200);
    const firstJson = await first.json();

    // Replay returns the stored 200 — it does NOT re-decide (which, already resolved, would 422).
    const replay = await H(req("POST", `/approvals/${id}`, { bearer: s.token, headers: { "idempotency-key": "ap1" }, body }), deps);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstJson);

    const idem = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.accountId, s.accountId));
    expect(idem).toHaveLength(1);

    // Same key, different body → 409.
    const conflict = await H(req("POST", `/approvals/${id}`, {
      bearer: s.token, headers: { "idempotency-key": "ap1" }, body: JSON.stringify({ decision: "reject" }),
    }), deps);
    expect(conflict.status).toBe(409);
  });
});
