import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

describe("snippets CRUD", () => {
  it("create → get → list → PUT replace → delete", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    const created = await H(req("POST", "/snippets", {
      bearer: s.token, body: JSON.stringify({ title: "Signature", body: "Cheers, Ada", shortcut: "/sig" }),
    }), deps);
    expect(created.status).toBe(201);
    const snip = await created.json();
    expect(snip.title).toBe("Signature");
    expect(snip.shortcut).toBe("/sig");

    const got = await H(req("GET", `/snippets/${snip.id}`, { bearer: s.token }), deps);
    expect(got.status).toBe(200);
    expect((await got.json()).body).toBe("Cheers, Ada");

    const listed = await H(req("GET", "/snippets", { bearer: s.token }), deps);
    expect((await listed.json()).items.map((x: { id: string }) => x.id)).toContain(snip.id);

    // PUT full replace (shortcut dropped)
    const put = await H(req("PUT", `/snippets/${snip.id}`, {
      bearer: s.token, body: JSON.stringify({ title: "Sig v2", body: "Regards" }),
    }), deps);
    expect(put.status).toBe(200);
    const pj = await put.json();
    expect(pj.title).toBe("Sig v2");
    expect(pj.body).toBe("Regards");
    expect(pj.shortcut).toBeNull();

    const deleted = await H(req("DELETE", `/snippets/${snip.id}`, { bearer: s.token }), deps);
    expect(deleted.status).toBe(204);
    expect((await H(req("GET", `/snippets/${snip.id}`, { bearer: s.token }), deps)).status).toBe(404);
  });

  it("empty title → 400; empty body → 400", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    expect((await H(req("POST", "/snippets", { bearer: s.token, body: JSON.stringify({ title: "", body: "x" }) }), deps)).status).toBe(400);
    expect((await H(req("POST", "/snippets", { bearer: s.token, body: JSON.stringify({ title: "t", body: "  " }) }), deps)).status).toBe(400);
  });

  it("cross-account get / PUT / delete → 404", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "owner-tok" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const snip = await (await H(req("POST", "/snippets", { bearer: owner.token, body: JSON.stringify({ title: "t", body: "b" }) }), deps)).json();

    expect((await H(req("GET", `/snippets/${snip.id}`, { bearer: other.token }), deps)).status).toBe(404);
    expect((await H(req("PUT", `/snippets/${snip.id}`, { bearer: other.token, body: JSON.stringify({ title: "x", body: "y" }) }), deps)).status).toBe(404);
    expect((await H(req("DELETE", `/snippets/${snip.id}`, { bearer: other.token }), deps)).status).toBe(404);
    // owner's list is unaffected
    expect((await (await H(req("GET", "/snippets", { bearer: owner.token }), deps)).json()).items).toHaveLength(1);
    expect((await (await H(req("GET", "/snippets", { bearer: other.token }), deps)).json()).items).toHaveLength(0);
  });
});
