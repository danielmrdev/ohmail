import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, seedRule, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/** Collect the change ids from a bootstrap /sync, partitioned by bucket. */
async function syncBuckets(deps: ApiDeps, token: string): Promise<{ creates: string[]; updates: string[]; deletes: string[] }> {
  const res = await H(req("GET", "/sync?since=0", { bearer: token }), deps);
  const b = await res.json();
  return {
    creates: b.changes.creates.map((c: { id: string }) => c.id),
    updates: b.changes.updates.map((c: { id: string }) => c.id),
    deletes: b.changes.deletes.map((c: { id: string }) => c.id),
  };
}

describe("rules CRUD", () => {
  it("full lifecycle: create → get → list → patch → delete, each mutation emits a change with X-Sync-Seq", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    // CREATE
    const created = await H(req("POST", "/rules", {
      bearer: s.token, body: JSON.stringify({ kind: "domain", match: "example.com", destination: "ohmail/News", priority: 5 }),
    }), deps);
    expect(created.status).toBe(201);
    const rule = await created.json();
    expect(rule.kind).toBe("domain");
    expect(rule.destination).toBe("ohmail/News");
    expect(rule.priority).toBe(5);
    expect(rule.provenance).toBe("manual");
    const createSeq = created.headers.get("x-sync-seq");
    expect(createSeq).toBeTruthy();

    // GET /rules/:id
    const got = await H(req("GET", `/rules/${rule.id}`, { bearer: s.token }), deps);
    expect(got.status).toBe(200);
    expect((await got.json()).id).toBe(rule.id);

    // LIST
    const listed = await H(req("GET", "/rules", { bearer: s.token }), deps);
    const { items } = await listed.json();
    expect(items.map((r: { id: string }) => r.id)).toContain(rule.id);

    // create change visible in /sync
    expect((await syncBuckets(deps, s.token)).creates).toContain(rule.id);

    // PATCH
    const patched = await H(req("PATCH", `/rules/${rule.id}`, {
      bearer: s.token, body: JSON.stringify({ enabled: false, priority: 9 }),
    }), deps);
    expect(patched.status).toBe(200);
    const pj = await patched.json();
    expect(pj.enabled).toBe(false);
    expect(pj.priority).toBe(9);
    const patchSeq = patched.headers.get("x-sync-seq");
    expect(Number(patchSeq)).toBeGreaterThan(Number(createSeq));
    expect((await syncBuckets(deps, s.token)).updates).toContain(rule.id);

    // DELETE
    const deleted = await H(req("DELETE", `/rules/${rule.id}`, { bearer: s.token }), deps);
    expect(deleted.status).toBe(204);
    const delSeq = deleted.headers.get("x-sync-seq");
    expect(Number(delSeq)).toBeGreaterThan(Number(patchSeq));
    expect((await syncBuckets(deps, s.token)).deletes).toContain(rule.id);

    // gone
    expect((await H(req("GET", `/rules/${rule.id}`, { bearer: s.token }), deps)).status).toBe(404);
  });

  it("cross-account GET / PATCH / DELETE → 404", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "owner-tok" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const ruleId = await seedRule(db, { accountId: owner.accountId });

    expect((await H(req("GET", `/rules/${ruleId}`, { bearer: other.token }), deps)).status).toBe(404);
    expect((await H(req("PATCH", `/rules/${ruleId}`, { bearer: other.token, body: JSON.stringify({ priority: 1 }) }), deps)).status).toBe(404);
    expect((await H(req("DELETE", `/rules/${ruleId}`, { bearer: other.token }), deps)).status).toBe(404);

    // owner still sees it (no cross-account write leaked through).
    expect((await H(req("GET", `/rules/${ruleId}`, { bearer: owner.token }), deps)).status).toBe(200);
  });

  it("invalid kind / destination / priority → 400", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    const badKind = await H(req("POST", "/rules", { bearer: s.token, body: JSON.stringify({ kind: "subject", match: "x", destination: "INBOX" }) }), deps);
    expect(badKind.status).toBe(400);

    const badDest = await H(req("POST", "/rules", { bearer: s.token, body: JSON.stringify({ kind: "sender", match: "x@y.example", destination: "Nope" }) }), deps);
    expect(badDest.status).toBe(400);

    const badPrio = await H(req("POST", "/rules", { bearer: s.token, body: JSON.stringify({ kind: "sender", match: "x@y.example", destination: "INBOX", priority: 1.5 }) }), deps);
    expect(badPrio.status).toBe(400);
  });
});
