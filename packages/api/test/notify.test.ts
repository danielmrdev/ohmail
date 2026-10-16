import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

describe("notify-rules", () => {
  it("create + list + delete", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    const created = await H(req("POST", "/notify-rules", {
      bearer: s.token, body: JSON.stringify({ target: "boss@example.com" }),
    }), deps);
    expect(created.status).toBe(201);
    const rule = await created.json();
    expect(rule.target).toBe("boss@example.com");
    expect(rule.kind).toBe("sender");   // default

    const withKind = await H(req("POST", "/notify-rules", {
      bearer: s.token, body: JSON.stringify({ target: "acme-com.example", kind: "domain" }),
    }), deps);
    expect((await withKind.json()).kind).toBe("domain");

    const listed = await H(req("GET", "/notify-rules", { bearer: s.token }), deps);
    expect((await listed.json()).items).toHaveLength(2);

    const deleted = await H(req("DELETE", `/notify-rules/${rule.id}`, { bearer: s.token }), deps);
    expect(deleted.status).toBe(204);
    expect((await (await H(req("GET", "/notify-rules", { bearer: s.token }), deps)).json()).items).toHaveLength(1);
  });

  it("empty target → 400", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    expect((await H(req("POST", "/notify-rules", { bearer: s.token, body: JSON.stringify({ target: "" }) }), deps)).status).toBe(400);
  });

  it("cross-account delete → 404", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "owner-tok" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const rule = await (await H(req("POST", "/notify-rules", { bearer: owner.token, body: JSON.stringify({ target: "x@y.example" }) }), deps)).json();

    expect((await H(req("DELETE", `/notify-rules/${rule.id}`, { bearer: other.token }), deps)).status).toBe(404);
    // other account sees none; owner still has it
    expect((await (await H(req("GET", "/notify-rules", { bearer: other.token }), deps)).json()).items).toHaveLength(0);
    expect((await (await H(req("GET", "/notify-rules", { bearer: owner.token }), deps)).json()).items).toHaveLength(1);
  });
});
