import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { mailboxes } from "@trafficflow/db";
import { makeDeps, seedSession, seedMailbox, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/**
 * HAS THE HOSTED DOOR LOOKED AT WHO HOLDS THIS MAILBOX (CLOUD-SETUP-OFFERS-AGREE-BEFORE-THE-HOLDER-IS-READ).
 * A reader row's NULL `organizer_state` is "not looked" until the worker's attach has peeked, and web
 * setup offered Agree over it. Read through the route, because the setup card's own unit reads a
 * field this door never sent. To watch it fail: make the projection's `organizerChecked` `true`.
 */
async function listed(over: Partial<typeof mailboxes.$inferInsert>) {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW });
  const id = await seedMailbox(db, { accountId: s.accountId });
  await db.update(mailboxes).set(over).where(eq(mailboxes.id, id));
  const res = await H(req("GET", "/mailboxes", { bearer: s.token }), deps);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Array<Record<string, unknown>> };
  return body.items.find((m) => m.id === id)!;
}

describe("GET /mailboxes says whether the door has looked at the holder", () => {
  it("a fresh reader row, nothing peeked and no cycle served, is not looked", async () => {
    const m = await listed({ organizerRole: "reader", organizerState: null, lastSyncAt: null });
    expect(m.organizerChecked).toBe(false);
  });

  it("a reader row the worker's peek found held or stopped has been looked at", async () => {
    expect((await listed({ organizerRole: "reader", organizerState: "held", organizedByKind: "local", organizedByName: "W" }))
      .organizerChecked).toBe(true);
    expect((await listed({ organizerRole: "reader", organizerState: "stopped", organizedByKind: "local", organizedByName: "W" }))
      .organizerChecked).toBe(true);
  });

  it("a reader row nobody holds is looked at once a cycle has served it — the attach peeks first", async () => {
    const m = await listed({ organizerRole: "reader", organizerState: null, lastSyncAt: new Date(FIXED_NOW.getTime() - 60_000) });
    expect(m.organizerChecked).toBe(true);
  });

  it("CONTROL: an organizer row is not a question about a holder", async () => {
    expect((await listed({ organizerRole: "organizer", organizerState: null, lastSyncAt: null })).organizerChecked).toBe(true);
  });
});
