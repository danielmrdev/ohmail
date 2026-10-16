import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

describe("kb CRUD", () => {
  it("create → get → list → PUT replace → delete", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    const created = await H(req("POST", "/kb", {
      bearer: s.token, body: JSON.stringify({ title: "Refund policy", content: "30 days.", tags: ["billing"] }),
    }), deps);
    expect(created.status).toBe(201);
    const entry = await created.json();
    expect(entry.title).toBe("Refund policy");
    expect(entry.tags).toEqual(["billing"]);

    const got = await H(req("GET", `/kb/${entry.id}`, { bearer: s.token }), deps);
    expect(got.status).toBe(200);
    expect((await got.json()).content).toBe("30 days.");

    const listed = await H(req("GET", "/kb", { bearer: s.token }), deps);
    expect((await listed.json()).items.map((x: { id: string }) => x.id)).toContain(entry.id);

    const put = await H(req("PUT", `/kb/${entry.id}`, {
      bearer: s.token, body: JSON.stringify({ title: "Refund v2", content: "45 days." }),
    }), deps);
    expect(put.status).toBe(200);
    const pj = await put.json();
    expect(pj.title).toBe("Refund v2");
    expect(pj.tags).toEqual([]);

    const deleted = await H(req("DELETE", `/kb/${entry.id}`, { bearer: s.token }), deps);
    expect(deleted.status).toBe(204);
    expect((await H(req("GET", `/kb/${entry.id}`, { bearer: s.token }), deps)).status).toBe(404);
  });

  it("empty title → 400; empty content → 400", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    expect((await H(req("POST", "/kb", { bearer: s.token, body: JSON.stringify({ title: "", content: "x" }) }), deps)).status).toBe(400);
    expect((await H(req("POST", "/kb", { bearer: s.token, body: JSON.stringify({ title: "t", content: " " }) }), deps)).status).toBe(400);
  });

  it("cross-account get / PUT / delete → 404", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "kb-owner" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "kb-other" });
    const entry = await (await H(req("POST", "/kb", { bearer: owner.token, body: JSON.stringify({ title: "t", content: "c" }) }), deps)).json();

    expect((await H(req("GET", `/kb/${entry.id}`, { bearer: other.token }), deps)).status).toBe(404);
    expect((await H(req("PUT", `/kb/${entry.id}`, { bearer: other.token, body: JSON.stringify({ title: "x", content: "y" }) }), deps)).status).toBe(404);
    expect((await H(req("DELETE", `/kb/${entry.id}`, { bearer: other.token }), deps)).status).toBe(404);
    expect((await (await H(req("GET", "/kb", { bearer: other.token }), deps)).json()).items).toHaveLength(0);
  });
});
