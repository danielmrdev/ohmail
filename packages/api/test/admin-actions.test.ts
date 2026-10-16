import { describe, it, expect } from "vitest";
import { managedAddress } from "../../../test/support/fixture-credentials.js";
import { createApp, apiRoutes, type AdminConfig, type ApiDeps } from "@trafficflow/api";
import { staffUsers, staffSessions, staffRoleGrants } from "@trafficflow/db/cloud";
import { accounts, auditLog, mailboxes } from "@trafficflow/db";
import { scryptHasher, generateToken, hashToken } from "@trafficflow/services";
import { eq } from "drizzle-orm";
import { makeDeps, FIXED_NOW } from "./helpers.js";

/**
 * `POST /admin/mailboxes/resync` — THE ONE ADMIN WRITE.
 *
 * The property this file exists for, above all the others: **the shared secret ALONE authorises
 * no write.** The reads and the sign-in routes are secret-gated; a write additionally needs a
 * live `staff_sessions` row, so the audit_log row it leaves names a PERSON. The test that pins it
 * is "secret present, no session ⇒ 401 staff_session_required", and it is MUTATION-WATCHED: drop
 * the `resolveStaffSession` guard in `routes/admin-actions.ts` and it goes green-should-be-red.
 */

const app = createApp(apiRoutes);
const SECRET = "admin-actions-console-fixture-token";
const ADMIN: AdminConfig = { secret: SECRET, environment: "test" };

const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

function post(path: string, body: unknown, opts: { bearer?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  return new Request(`https://api.test${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

const EMAIL = managedAddress("fixture.ops");

/** A seeded world: one account, one staff user, one live staff session token. */
async function seed(deps: ApiDeps): Promise<{ accountId: string; staffId: string; token: string }> {
  const [account] = await deps.db.insert(accounts).values({ name: "Acme Ltd" }).returning();
  const [staff] = await deps.db.insert(staffUsers).values({
    email: EMAIL,
    passwordHash: await scryptHasher.hash("correct horse battery staple 4x"),
  }).returning();
  // Cloud 0047: roles are read live; this fixture is an owner, as every existing staff member was.
  await deps.db.insert(staffRoleGrants).values({ staffUserId: (staff as { id: string }).id, role: "owner" });
  const token = generateToken(32);
  await deps.db.insert(staffSessions).values({
    staffUserId: (staff as { id: string }).id,
    tokenHash: hashToken(token),
    // Cloud 0036: a second factor proved just now, so this fixture's subject stays what it was.
    lastTwofaAt: FIXED_NOW,
    expiresAt: new Date(FIXED_NOW.getTime() + 3_600_000),
  });
  return { accountId: (account as { id: string }).id, staffId: (staff as { id: string }).id, token };
}

async function deps0(): Promise<ApiDeps> {
  const { deps } = await makeDeps();
  return { ...deps, admin: ADMIN } as ApiDeps;
}

const auditOf = (deps: ApiDeps, accountId: string) =>
  deps.db.select().from(auditLog).where(eq(auditLog.accountId, accountId));

/**
 * `POST /admin/mailboxes/resync` — RELEASING A QUARANTINED MAILBOX (mail 0039).
 *
 * ── THE GAP ────────────────────────────────────────────────────────────────────────────────
 *
 * A quarantined mailbox could not be released by anyone, from anywhere, without restarting the
 * sync worker: the backoff lived in that process's memory and no database write could reach it.
 * That made a redeploy the release mechanism — a heavy hammer, and one nobody without deploy
 * rights has at all. Mail 0039 made the instant durable; this route is the write that clears it.
 *
 * ── WHAT THESE PIN, BEYOND "IT WORKS" ──────────────────────────────────────────────────────
 *
 * The route is a handler of its own rather than a reuse of a shared staff-write wrapper, because
 * it validates a MAILBOX id. That is the risk: a duplicated wrapper is where an authorisation
 * check quietly fails to get copied. So the two-credential property is asserted against THIS
 * path rather than assumed from the wrapper — same mutation, same expectation.
 */
describe("admin write — releasing a quarantined mailbox (mail 0039)", () => {
  const RESYNC_NOTE = "provider outage cleared, release the backoff";

  async function seedParked(deps: ApiDeps, accountId: string): Promise<string> {
    const [mb] = await deps.db.insert(mailboxes).values({
      accountId, provider: "imap", address: "parked@example.test",
      status: "error", errorCode: "auth", retryCount: 4,
      retryAfter: new Date(FIXED_NOW.getTime() + 900_000),
    }).returning();
    return (mb as { id: string }).id;
  }

  it("404s on a host with no admin secret — the surface does not advertise itself", async () => {
    const { deps } = await makeDeps();
    const armed = { ...deps, admin: ADMIN } as ApiDeps;
    const { accountId, token } = await seed(armed);
    const mailboxId = await seedParked(armed, accountId);
    const res = await H(post("/admin/mailboxes/resync", { mailboxId, note: RESYNC_NOTE, sessionToken: token }), deps);
    expect(res.status).toBe(404);
  });

  it("THE SECRET ALONE AUTHORISES NOTHING — no staff session is 401, and nothing is written", async () => {
    // The mutation-watched guard, re-asserted on this path: drop `resolveStaffSession` from
    // `staffMailboxWriteRoute` and this goes green-should-be-red. A duplicated wrapper is exactly
    // where an authorisation check fails to get copied.
    const deps = await deps0();
    const { accountId } = await seed(deps);
    const mailboxId = await seedParked(deps, accountId);
    const res = await H(post("/admin/mailboxes/resync", { mailboxId, note: RESYNC_NOTE }, { bearer: SECRET }), deps);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("staff_session_required");
    const [row] = await deps.db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect((row as { retryAfter: Date | null }).retryAfter, "a refused write changed nothing").not.toBeNull();
    expect(await auditOf(deps, accountId)).toHaveLength(0);
  });

  it("clears the backoff, records the operator, and reports what it cleared", async () => {
    const deps = await deps0();
    const { accountId, staffId, token } = await seed(deps);
    const mailboxId = await seedParked(deps, accountId);

    const res = await H(
      post("/admin/mailboxes/resync", { mailboxId, note: RESYNC_NOTE, sessionToken: token }, { bearer: SECRET }),
      deps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, action: "admin.mailbox.resync", mailboxId, accountId, changed: true });
    expect(body.actor).toBe(EMAIL);
    expect(body.clearedRetryAfter, "the backoff that WAS in force, not the null that replaced it").not.toBeNull();

    const [row] = await deps.db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect((row as { retryAfter: Date | null }).retryAfter).toBeNull();
    // The outage record stands. The console does not get to claim a sync it has not observed.
    expect((row as { status: string }).status).toBe("error");
    expect((row as { retryCount: number }).retryCount).toBe(4);

    const audits = await auditOf(deps, accountId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("admin.mailbox.resync");
    expect(audits[0]!.payload).toMatchObject({ mailbox_id: mailboxId, actor: staffId, note: RESYNC_NOTE });

    // THE ROW'S IDENTITY IS ON THE WIRE, and it is the identity of the row that exists. The
    // console renders the entry it is handed; before this it composed one from the request and
    // could therefore name a row for a write that appended none.
    const audit = body.audit as { id: string; at: string } | null;
    expect(audit, "a write that wrote a row names it").not.toBeNull();
    expect(audit!.id).toBe(audits[0]!.id);
    expect(audit!.at).toBe(audits[0]!.createdAt.toISOString());
  });

  it("a wrong id is a 404, and a mailbox that was not parked is a 200 that says so", async () => {
    // Two different answers to the operator, and collapsing them is the small lie that costs
    // trust: "there was nothing to release" about a mailbox you did not name is not information.
    const deps = await deps0();
    const { accountId, token } = await seed(deps);

    const missing = await H(
      post("/admin/mailboxes/resync",
        { mailboxId: "00000000-0000-4000-8000-000000000000", note: RESYNC_NOTE, sessionToken: token },
        { bearer: SECRET }),
      deps,
    );
    expect(missing.status).toBe(404);

    const [clean] = await deps.db.insert(mailboxes).values({
      accountId, provider: "imap", address: "healthy@example.test",
    }).returning();
    const noop = await H(
      post("/admin/mailboxes/resync",
        { mailboxId: (clean as { id: string }).id, note: RESYNC_NOTE, sessionToken: token },
        { bearer: SECRET }),
      deps,
    );
    expect(noop.status).toBe(200);
    const noopBody = (await noop.json()) as Record<string, unknown>;
    expect(noopBody).toMatchObject({ ok: true, changed: false });
    // No row, no id. A null here is what lets the console say "nothing to do" instead of "done".
    expect(noopBody.audit, "a write that wrote no row names none").toBeNull();
    expect(await auditOf(deps, accountId), "a no-op writes no audit row").toHaveLength(0);
  });

  it("refuses a missing id and a too-short note before touching the database", async () => {
    const deps = await deps0();
    const { accountId, token } = await seed(deps);
    const mailboxId = await seedParked(deps, accountId);

    const noId = await H(post("/admin/mailboxes/resync", { note: RESYNC_NOTE, sessionToken: token }, { bearer: SECRET }), deps);
    expect(noId.status).toBe(400);
    expect(((await noId.json()) as { error: { code: string } }).error.code).toBe("mailbox_id_required");

    const shortNote = await H(post("/admin/mailboxes/resync", { mailboxId, note: "oops", sessionToken: token }, { bearer: SECRET }), deps);
    expect(shortNote.status).toBe(400);
    expect(((await shortNote.json()) as { error: { code: string } }).error.code).toBe("note_required");

    const [row] = await deps.db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect((row as { retryAfter: Date | null }).retryAfter).not.toBeNull();
  });
});
