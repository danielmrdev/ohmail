import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

/**
 * OUTBOX-REPLAY-ON-A-NON-IDEMPOTENT-ROUTE: a client whose `POST /tags` answer
 * was lost retries under the same Idempotency-Key, and the route answers the stored creation
 * rather than a 409 over the tag that request made. A different key still meets the name rule.
 */
describe("POST /tags under one Idempotency-Key", () => {
  it("a retry is answered from the first creation, once", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const create = (key: string) => H(req("POST", "/tags", {
      bearer: s.token, headers: { "idempotency-key": key }, body: JSON.stringify({ name: "Invoices" }),
    }), deps);
    const first = await create("k-tag-1");
    expect(first.status).toBe(201);
    const made = await first.json();
    const again = await create("k-tag-1");
    expect({ status: again.status, id: (await again.json()).id }, "the retry was refused or made a second tag")
      .toEqual({ status: 201, id: made.id });
    const other = await create("k-tag-2");
    expect(other.status, "a second key is a second request: the name rule still holds").toBe(409);
    const list = await (await H(req("GET", "/tags", { bearer: s.token }), deps)).json();
    expect(list.items).toHaveLength(1);
  });
});
