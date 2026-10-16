import { describe, it, expect } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { staffRoleGrants } from "@trafficflow/db/cloud";
import { totpNow } from "@trafficflow/services";
import type { ApiDeps } from "@trafficflow/api";
import { FIXED_NOW } from "./helpers.js";
import { H, get, post, seedStaff, staffDeps, auditRowsFor, type Staff } from "./_staff-fixtures.js";

/**
 * Staff roles (cloud 0047): read live on every request, granted and revoked by an owner with a
 * TOTP consumed by the call. Nobody changes their own roles; the last owner stays.
 */

const STEP = 30_000;
const later = (deps: ApiDeps, steps: number): ApiDeps => {
  const t = new Date(FIXED_NOW.getTime() + steps * STEP);
  return { ...deps, now: () => t } as ApiDeps;
};

const change = (by: Staff, deps: ApiDeps, body: Record<string, unknown>): Promise<Response> =>
  H(post("/admin/staff/roles", { sessionToken: by.token, totp: totpNow(by.totpSecret, deps.now()), ...body }), deps);

const liveRoles = async (deps: ApiDeps, staffId: string): Promise<string[]> =>
  (await deps.db.select({ role: staffRoleGrants.role }).from(staffRoleGrants)
    .where(and(eq(staffRoleGrants.staffUserId, staffId), isNull(staffRoleGrants.revokedAt)))).map((r) => r.role).sort();

describe("roles are read live", () => {
  it("whoami names the live roles, and a revoke is the next request's answer", async () => {
    const deps = await staffDeps();
    const owner = await seedStaff(deps, { roles: ["owner"] });
    const other = await seedStaff(deps, { roles: [] });
    const who = async (s: Staff) => (await (await H(post("/admin/staff/whoami", { token: s.token }), deps)).json()) as { roles: string[] };
    expect((await who(other)).roles).toEqual([]);
    expect((await H(get("/admin/overview", other.token), deps)).status).toBe(403);

    expect((await change(owner, deps, { op: "grant", role: "support", staffEmail: other.email })).status).toBe(200);
    expect((await who(other)).roles).toEqual(["support"]);
    expect((await H(get("/admin/overview", other.token), deps)).status).toBe(200);

    const d2 = later(deps, 1);
    expect((await change(owner, d2, { op: "revoke", role: "support", staffEmail: other.email })).status).toBe(200);
    expect((await H(get("/admin/overview", other.token), d2)).status).toBe(403);
    expect((await who(other)).roles).toEqual([]);
  });
});

describe("POST /admin/staff/roles", () => {
  it("grants, answers no_change for a grant already held, and records both", async () => {
    const deps = await staffDeps();
    const owner = await seedStaff(deps, { roles: ["owner"] });
    const other = await seedStaff(deps, { roles: [] });
    const first = await change(owner, deps, { op: "grant", role: "billing", staffEmail: other.email.toUpperCase() });
    expect(await first.json()).toMatchObject({ ok: true, op: "grant", role: "billing", changed: true });
    const again = await change(owner, later(deps, 1), { op: "grant", role: "billing", staffEmail: other.email });
    expect(await again.json()).toMatchObject({ ok: true, changed: false });
    expect(await liveRoles(deps, other.staffId)).toEqual(["billing"]);
    const rows = await auditRowsFor(deps, owner.staffId);
    expect(rows.map((r) => [r.action, r.outcome])).toEqual([["staff.role_grant", "ok"], ["staff.role_grant", "no_change"]]);
    expect(rows[0]!.detail).toEqual({ role: "billing", targetStaffUserId: other.staffId });
  });

  it("asks for a TOTP, and one code buys one change", async () => {
    const deps = await staffDeps();
    const owner = await seedStaff(deps, { roles: ["owner"] });
    const other = await seedStaff(deps, { roles: [] });
    const none = await H(post("/admin/staff/roles", { sessionToken: owner.token, op: "grant", role: "ops", staffEmail: other.email }), deps);
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: { code: "totp_required" } });
    expect((await change(owner, deps, { op: "grant", role: "ops", staffEmail: other.email })).status).toBe(200);
    const replay = await change(owner, deps, { op: "grant", role: "support", staffEmail: other.email });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: { code: "totp_invalid" } });
    expect(await liveRoles(deps, other.staffId)).toEqual(["ops"]);
  });

  it("is an owner's act alone", async () => {
    const deps = await staffDeps();
    const support = await seedStaff(deps, { roles: ["support", "billing", "ops"] });
    const other = await seedStaff(deps, { roles: [] });
    const res = await change(support, deps, { op: "grant", role: "owner", staffEmail: other.email });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "role_required" } });
    expect(await liveRoles(deps, other.staffId)).toEqual([]);
    const [row] = await auditRowsFor(deps, support.staffId);
    expect(row).toMatchObject({ action: "staff.role_grant", outcome: "refused", refusalCode: "role_required" });
  });

  it("refuses a change to one's own roles", async () => {
    const deps = await staffDeps();
    const owner = await seedStaff(deps, { roles: ["owner"] });
    await seedStaff(deps, { roles: ["owner"] });
    const res = await change(owner, deps, { op: "revoke", role: "owner", staffEmail: owner.email });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "self_change_refused" } });
    expect(await liveRoles(deps, owner.staffId)).toEqual(["owner"]);
  });

  it("revokes an owner while another remains; the one left cannot revoke itself", async () => {
    const deps = await staffDeps();
    const a = await seedStaff(deps, { roles: ["owner"] });
    const b = await seedStaff(deps, { roles: ["owner"] });
    expect((await change(a, deps, { op: "revoke", role: "owner", staffEmail: b.email })).status).toBe(200);
    expect(await liveRoles(deps, b.staffId)).toEqual([]);
    // `b` is no owner now and is refused; `a` is the last owner and cannot revoke itself.
    expect((await change(b, later(deps, 1), { op: "grant", role: "owner", staffEmail: b.email })).status).toBe(403);
    expect((await change(a, later(deps, 2), { op: "revoke", role: "owner", staffEmail: a.email })).status).toBe(409);
    expect(await liveRoles(deps, a.staffId)).toEqual(["owner"]);
    const rows = await auditRowsFor(deps, a.staffId);
    expect(rows.map((r) => [r.action, r.outcome, r.refusalCode])).toEqual([
      ["staff.role_revoke", "ok", null], ["staff.role_revoke", "refused", "self_change_refused"],
    ]);
  });

  it("an unknown staff address is a 404, and an unknown role or verb a 400", async () => {
    const deps = await staffDeps();
    const owner = await seedStaff(deps, { roles: ["owner"] });
    const other = await seedStaff(deps, { roles: [] });
    expect((await change(owner, deps, { op: "grant", role: "support", staffEmail: "nobody@example.test" })).status).toBe(404);
    expect((await change(owner, later(deps, 1), { op: "grant", role: "admin", staffEmail: other.email })).status).toBe(400);
    expect((await change(owner, later(deps, 2), { op: "promote", role: "support", staffEmail: other.email })).status).toBe(400);
    expect(await liveRoles(deps, other.staffId)).toEqual([]);
  });
});
