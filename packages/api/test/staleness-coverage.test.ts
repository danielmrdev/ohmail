/**
 * THE COVERAGE CLAIM, MADE EXPLICIT — every hosted sign-in path lands in a shape SOME
 * staleness alarm watches, and the exceptions are NAMED, not discovered by the next incident.
 *
 * The incident this file answers: a user's desktop was wedged for days and the
 * `device_sync_stale` alarm watched nothing — its install shape (a deviceless browser-door
 * session) was never in the alarm's population, and nothing anywhere said so. The device rule
 * was correct about the rows it read; the CLAIM "every install is watched" was simply never
 * stated, so it could be false silently.
 *
 * Two halves, and they only work together:
 *
 *  1. THE WRITER CENSUS (source-level). Every session row is minted by an enumerable set of
 *     writers. This half pins that set by reading the sources, so a NEW sign-in path fails
 *     this file until a human classifies it below — into a watched shape or a named exception.
 *
 *  2. THE SHAPE COVERAGE (behavioral, PGlite). For each shape those writers can produce, put
 *     it into the wedged state through the REAL `/sync` stamp and assert `evaluateAlerts`
 *     fires — or assert the named exception holds (an enrollment session cannot reach `/sync`
 *     at all; a deviceless session that never once converged is the documented blind spot).
 *
 * THE SHAPES, from the census (see each writer's own doc):
 *   · `SessionLifecycle.establish` — every hosted FULL session:
 *       - deviceless (`device_id IS NULL`; the browser ceremony, and the browser-door desktop)
 *           → watched by `session_sync_stale` once it has stamped a horizon.
 *       - device-backed, kind ≠ 'web' (the native PKCE exchange and the desktop-link claim
 *         auto-mint — legacy 'macos' or the claim's declared desktop kind; a TOTP verify
 *         declaring a desktop kind, which is the cloud-door desktop's password sign-in; a
 *         pairing redeem declaring a native kind, which is how the mobile app arrives)
 *           → watched by `device_sync_stale` (stamped-then-quiet AND never-synced arms).
 *       - device-backed, kind = 'web' (a pairing redeem's default)
 *           → watched by `session_sync_stale` (the device rule excludes kind 'web' on purpose:
 *             a CLOSED browser is not an incident; an OPEN wedged one still requests and fires).
 *   · `AuthService.establishEnrollment` — scope 'enrollment', dies in ~5 minutes, cannot reach
 *     `/sync` (asserted below) → EXCEPTION: not a mail install, nothing to watch.
 *   · `apps/sidecar/src/identity.ts` — the LOCAL desktop-host tier's launch session, minted
 *     into the install's own store, not this database → EXCEPTION: a local install's cloud
 *     pulls ride a hosted session minted by `establish`, which the shapes above already cover.
 *
 * THE NAMED BLIND SPOT (asserted, so the claim cannot silently widen): a DEVICELESS session
 * that never once reached the horizon is indistinguishable from a REST-only caller and fires
 * nothing. It becomes visible the first time it converges; a NAMED device never-synced is
 * covered by the device rule's never-synced arm.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { devices, mailboxes, sessions } from "@trafficflow/db";
import { evaluateAlerts } from "@trafficflow/db/cloud";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, seedSessionFor, seedMailbox, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

const DAY = 24 * 60 * 60 * 1000;
/** Evaluation moment: 4 days after the stamps land — past the 3-day threshold. */
const LATER = new Date(FIXED_NOW.getTime() + 4 * DAY);

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFilesUnder(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("the staleness-coverage census — every session writer is classified", () => {
  it("the set of `insert(sessions)` writers is exactly the classified set", () => {
    // Source-level, deliberately: a new sign-in path is a new writer, and it must fail HERE,
    // in the file that states the coverage claim, until the header classifies it. The scan
    // covers the server packages AND the sidecar (the one non-hosted writer), so a writer
    // moving between tiers is a diff in this list, not a silent reclassification.
    const scanned = [
      join(ROOT, "packages", "services", "src"),
      join(ROOT, "packages", "api", "src"),
      join(ROOT, "packages", "db", "src"),
      join(ROOT, "apps", "sidecar", "src"),
    ].flatMap(tsFilesUnder);
    const writers = scanned
      .filter((p) => readFileSync(p, "utf8").includes("insert(sessions)"))
      .map((p) => p.slice(ROOT.length).replace(/\\/g, "/"))
      .sort();
    expect(writers).toEqual([
      "apps/sidecar/src/identity.ts",                       // local launch session — exception
      "packages/services/src/auth/auth-service.ts",         // establishEnrollment — exception
      "packages/services/src/auth/session-lifecycle.ts",    // establish — the hosted mint
    ]);
  });

  it("the device-kind vocabulary the shapes range over is the closed set", async () => {
    // The shape arguments below split on `kind === 'web'` vs everything else. Pin the
    // vocabulary so a new kind is classified into one of those halves on the day it is added,
    // in the same diff this test forces.
    const { PAIRED_DEVICE_KINDS } = await import("@trafficflow/services/auth");
    expect([...PAIRED_DEVICE_KINDS].sort()).toEqual([
      "desktop-linux", "desktop-macos", "desktop-windows",
      "macos", "mobile-android", "mobile-ios", "web",
    ]);
  });
});

describe("the staleness-coverage shapes — each classified shape is alarm-visible", () => {
  /** Drive the REAL `/sync` empty tail so the production stamp path writes the horizon. */
  async function stampViaSync(deps: ApiDeps, token: string): Promise<void> {
    const first = await H(req("GET", "/sync?since=0", { bearer: token }), deps);
    expect(first.status).toBe(200);
    const { cursor } = await first.json();
    const tail = await H(req("GET", `/sync?since=${encodeURIComponent(cursor)}`, { bearer: token }), deps);
    expect(tail.status).toBe(200);
  }

  /** The account "moved on": a mailbox the worker synced after the stamps. */
  async function accountMovedOn(db: Awaited<ReturnType<typeof makeDeps>>["db"], accountId: string): Promise<void> {
    const id = await seedMailbox(db, { accountId });
    await db.update(mailboxes).set({ lastSyncAt: new Date(LATER.getTime() - 60 * 60 * 1000) })
      .where(eq(mailboxes.id, id));
  }

  /** Rotation is what advances `last_seen_at` in production (`mintRotation`); simulate one. */
  async function stillRequesting(db: Awaited<ReturnType<typeof makeDeps>>["db"], sessionId: string): Promise<void> {
    await db.update(sessions).set({ lastSeenAt: new Date(LATER.getTime() - 60_000) })
      .where(eq(sessions.id, sessionId));
  }

  it("SHAPE: deviceless full session (browser ceremony / browser-door desktop) → session_sync_stale", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await stampViaSync(deps, s.token);
    await accountMovedOn(db, s.accountId);
    await stillRequesting(db, s.sessionId);

    const alerts = await evaluateAlerts(db, { now: LATER });
    expect(alerts.some((a) => a.key === `session_sync_stale:${s.sessionId}`),
      "THE INCIDENT'S SHAPE — a wedged deviceless install must be inside an alarm's population").toBe(true);
  });

  it("SHAPE: device-backed, native kind (PKCE / desktop-link auto-mint) → device_sync_stale", async () => {
    const { db, deps } = await makeDeps();
    const base = await seedSession(db, { now: FIXED_NOW });
    const [dev] = await db.insert(devices).values({
      accountId: base.accountId, userId: base.userId, kind: "macos", label: "ohmail for Mac",
      createdAt: FIXED_NOW,
    }).returning();
    const s = await seedSessionFor(db, {
      accountId: base.accountId, userId: base.userId, now: FIXED_NOW, deviceId: dev!.id,
    });
    await stampViaSync(deps, s.token);
    await accountMovedOn(db, base.accountId);

    const alerts = await evaluateAlerts(db, { now: LATER });
    expect(alerts.some((a) => a.key === `device_sync_stale:${dev!.id}`),
      "a stamped-then-quiet native device pages").toBe(true);
  });

  it("SHAPE: device-backed, native kind, NEVER stamped (wedged since pairing) → device_sync_stale", async () => {
    const { db } = await makeDeps();
    const base = await seedSession(db, { now: FIXED_NOW });
    const [dev] = await db.insert(devices).values({
      accountId: base.accountId, userId: base.userId, kind: "desktop-linux", label: "ohmail for Linux",
      createdAt: FIXED_NOW,
    }).returning();
    const s = await seedSessionFor(db, {
      accountId: base.accountId, userId: base.userId, now: FIXED_NOW, deviceId: dev!.id,
    });
    await accountMovedOn(db, base.accountId);
    // STILL REQUESTING, stated explicitly: the never-synced arm requires the session to be
    // making requests (its sibling's gate — a frozen handshake fires nothing; see the arm's
    // header). Without this line the shape leans on the column's wall-clock default.
    await stillRequesting(db, s.sessionId);

    const alerts = await evaluateAlerts(db, { now: LATER });
    expect(alerts.some((a) => a.key === `device_sync_stale:${dev!.id}`),
      "never-once-current since pairing is the incident, not a non-event").toBe(true);
  });

  it("SHAPE-NEGATIVE: a never-synced device whose session FROZE at its mint fires nothing", async () => {
    // The dead-handshake shape, pinned beside its positive: unrevoked session, never a sync,
    // last seen at its own creation instant, weeks before evaluation. That is pairing debris,
    // not a person at a wedged mailbox — the measured false page ran for fifteen days.
    const { db } = await makeDeps();
    const base = await seedSession(db, { now: FIXED_NOW });
    const [dev] = await db.insert(devices).values({
      accountId: base.accountId, userId: base.userId, kind: "macos", label: "ohmail for Mac",
      createdAt: FIXED_NOW,
    }).returning();
    const s = await seedSessionFor(db, {
      accountId: base.accountId, userId: base.userId, now: FIXED_NOW, deviceId: dev!.id,
    });
    await db.update(sessions).set({ lastSeenAt: FIXED_NOW })
      .where(eq(sessions.id, s.sessionId));
    await accountMovedOn(db, base.accountId);

    const alerts = await evaluateAlerts(db, { now: LATER });
    expect(alerts.some((a) => a.key === `device_sync_stale:${dev!.id}`),
      "a handshake that never made a second request is not an incident").toBe(false);
  });

  it("SHAPE: device-backed, kind 'web' (pairing redeem default) → session_sync_stale", async () => {
    const { db, deps } = await makeDeps();
    const base = await seedSession(db, { now: FIXED_NOW });
    const [dev] = await db.insert(devices).values({
      accountId: base.accountId, userId: base.userId, kind: "web", label: "kitchen iPad",
      createdAt: FIXED_NOW,
    }).returning();
    const s = await seedSessionFor(db, {
      accountId: base.accountId, userId: base.userId, now: FIXED_NOW, deviceId: dev!.id,
    });
    await stampViaSync(deps, s.token);
    await accountMovedOn(db, base.accountId);
    await stillRequesting(db, s.sessionId);

    const alerts = await evaluateAlerts(db, { now: LATER });
    expect(alerts.some((a) => a.key === `session_sync_stale:${s.sessionId}`),
      "an OPEN, wedged paired browser is watched at the session level").toBe(true);
    expect(alerts.some((a) => a.key === `device_sync_stale:${dev!.id}`),
      "…and not double-keyed by the device rule").toBe(false);
  });

  it("EXCEPTION: an enrollment session cannot reach /sync at all", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, scope: "enrollment" });
    const res = await H(req("GET", "/sync?since=0", { bearer: s.token }), deps);
    // Refused before any read: a password-only session is not a mail install and can never
    // become a stale sync client — which is why its writer is a named exception, not a hole.
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(500);
  });

  it("BLIND SPOT, pinned: a deviceless session that NEVER converged fires nothing", async () => {
    // Deliberate and documented: with no stamp it is indistinguishable from a REST-only
    // caller. It enters the watched population at its first horizon. If this test ever starts
    // failing because the rule widened, the header's blind-spot paragraph is what must move.
    const { db } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await accountMovedOn(db, s.accountId);
    await stillRequesting(db, s.sessionId);

    const alerts = await evaluateAlerts(db, { now: LATER });
    expect(alerts.some((a) => a.kind === "session_sync_stale" || a.kind === "device_sync_stale")).toBe(false);
  });
});
