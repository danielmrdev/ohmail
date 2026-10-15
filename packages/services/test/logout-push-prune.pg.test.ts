import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { devices, sessions, users } from "@trafficflow/db";
import { schema, pushSubscriptions } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  makeAuthService, makeTestAuthDeps, makePushService, type ServiceContext,
} from "@trafficflow/services";
import { seedFullAccount } from "./helpers/erasure-fixture.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  SIGNING OUT TAKES THE WAKE REGISTRATION WITH IT — the server half of "forget this server"
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────────────────────
 *
 * `push_subscriptions` rows are stamped with the registering session's `device_id`, and
 * `push-service.ts` says in its own words that the stamp is "what lets `DELETE /devices/:id`
 * take the wake registration down with the credential". Only `revokeDevice` ever used it, and
 * `revokeDevice` is reachable only from a server's Devices pane. `logout` revoked the session
 * family and nothing else.
 *
 * So a phone that pressed "Forget this server" — which logs out — kept a live row, and the
 * worker kept POSTing "something changed" to a device that could no longer open the account.
 * Nothing unregisters the distributor either, so the endpoint keeps answering 2xx and the
 * worker's prune-on-404/410 never fires: the row and the outbound traffic are permanent. Not a
 * breach (the payload is content-free), but a continuing mail-ARRIVAL-TIMING channel to a
 * device after an explicit take-back.
 *
 * ── WHY THIS IS A `pg` TEST ───────────────────────────────────────────────────────────────
 *
 * The assertion is an ABSENCE OF ROWS after a transaction, on the driver production runs. This
 * repository's own rule: PGlite green means nothing for transactional code.
 *
 * ── THE MUTATION THAT MAKES IT EVIDENCE ───────────────────────────────────────────────────
 *
 * Delete the `logout` override in `auth-service.ts` and the first two cases go red with the
 * row still present — which is the defect verbatim. The isolation case goes red if the prune
 * widens its predicate past the one device (and the deviceless case pins the browser residue
 * this deliberately does NOT guess at).
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ctxFor = (accountId: string, userId: string, sessionId: string | null): ServiceContext => ({
  db, accountId, userId, sessionId: sessionId ?? undefined,
  now: () => new Date(), requestId: "logout-push-pg",
} as unknown as ServiceContext);

/** One wake registration, stamped with the device the session belongs to. */
async function registerWakeRow(accountId: string, deviceId: string | null): Promise<string> {
  const [row] = await db.insert(pushSubscriptions).values({
    accountId, transport: "unifiedpush", endpoint: `https://ntfy.test/${randomUUID()}`, deviceId,
  }).returning({ id: pushSubscriptions.id });
  return row!.id;
}

/**
 * A SESSION THE WAY A BROWSER SIGN-IN LEAVES ONE: no device.
 *
 * `seedFullAccount` hands its session a device id, which is right for the phone and desktop cases
 * in this file and WRONG for every browser one — `auth/session-lifecycle.ts` auto-mints a device
 * row for the four desktop kinds only. Using the seeded session for a web registration is what
 * made the browser case here green while asserting the opposite of the truth, so the browser
 * cases mint their own.
 */
async function devicelessSession(seeded: { accountId: string; userId: string }): Promise<string> {
  const [row] = await db.insert(sessions).values({
    accountId: seeded.accountId, userId: seeded.userId, familyId: randomUUID(),
    accessExpiresAt: new Date(Date.now() + 3_600_000),
    refreshExpiresAt: new Date(Date.now() + 3_600_000),
  }).returning({ id: sessions.id });
  return row!.id;
}

const rowsFor = async (accountId: string) =>
  db.select({ id: pushSubscriptions.id, deviceId: pushSubscriptions.deviceId })
    .from(pushSubscriptions).where(eq(pushSubscriptions.accountId, accountId));

describe.skipIf(!PG_UP)("logout takes this device's wake registration down", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 5 });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 60_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("a phone's own sign-out leaves ZERO rows for its device", async () => {
    const seeded = await seedFullAccount(db);
    // The fixture's own row is deviceless; this is the phone's, stamped as `push-service.ts`
    // stamps it. Both are in the account, so a prune that deleted everything would show here.
    const phoneRow = await registerWakeRow(seeded.accountId, seeded.deviceId);

    const svc = makeAuthService(makeTestAuthDeps());
    await svc.logout(ctxFor(seeded.accountId, seeded.userId, seeded.sessionId), {});

    const after = await rowsFor(seeded.accountId);
    expect(after.map((r) => r.id)).not.toContain(phoneRow);
    expect(after.filter((r) => r.deviceId === seeded.deviceId)).toEqual([]);
    // The session really was revoked too — the take-back is the whole act, not just the prune.
    const s = (await db.select({ revokedAt: sessions.revokedAt }).from(sessions)
      .where(eq(sessions.id, seeded.sessionId)))[0];
    expect(s?.revokedAt).toBeInstanceOf(Date);
  });

  it("ONLY that device: a second phone on the same account keeps its registration", async () => {
    const seeded = await seedFullAccount(db);
    const [other] = await db.insert(devices)
      .values({ accountId: seeded.accountId, userId: seeded.userId, kind: "mobile-android" })
      .returning({ id: devices.id });
    const otherDeviceId = other!.id;
    const mine = await registerWakeRow(seeded.accountId, seeded.deviceId);
    const theirs = await registerWakeRow(seeded.accountId, otherDeviceId);

    const svc = makeAuthService(makeTestAuthDeps());
    await svc.logout(ctxFor(seeded.accountId, seeded.userId, seeded.sessionId), {});

    const ids = (await rowsFor(seeded.accountId)).map((r) => r.id);
    expect(ids).not.toContain(mine);
    // The load-bearing half. Signing one phone out must not silently end another's wakes —
    // which is exactly what a prune keyed on the ACCOUNT rather than the device would do.
    expect(ids).toContain(theirs);
  });

  it("`allDevices` takes every row of THIS USER's devices — and not another user's", async () => {
    // It is device revocation in effect, so it takes every device row this user has. What it
    // may NOT take is somebody else's: an account can hold several users, `super.logout`'s mass
    // arm revokes sessions for `ctx.userId` alone, and pruning by ACCOUNT reached past the thing
    // being taken back — silently ending a second user's wakes while they stayed signed in.
    const seeded = await seedFullAccount(db);
    const [second] = await db.insert(users).values({
      accountId: seeded.accountId,
      email: `second-${randomUUID()}@lichtgrat.example`,
      displayName: "Second",
    }).returning({ id: users.id });
    const [mineB] = await db.insert(devices)
      .values({ accountId: seeded.accountId, userId: seeded.userId, kind: "mobile-ios" })
      .returning({ id: devices.id });
    const [theirs] = await db.insert(devices)
      .values({ accountId: seeded.accountId, userId: second!.id, kind: "mobile-android" })
      .returning({ id: devices.id });

    const mine1 = await registerWakeRow(seeded.accountId, seeded.deviceId);
    const mine2 = await registerWakeRow(seeded.accountId, mineB!.id);
    const notMine = await registerWakeRow(seeded.accountId, theirs!.id);
    const deviceless = await registerWakeRow(seeded.accountId, null);

    // `allDevices` needs the step-up the base class gates it with; the fixture's session
    // carries no `last_twofa_at`, so stamp it — the gate itself is `logout`'s own test, and
    // what is under test here is what a PERMITTED mass logout removes.
    await db.update(sessions).set({ lastTwofaAt: new Date() }).where(eq(sessions.id, seeded.sessionId));
    const svc = makeAuthService(makeTestAuthDeps());
    await svc.logout(ctxFor(seeded.accountId, seeded.userId, seeded.sessionId), { allDevices: true });

    const ids = (await rowsFor(seeded.accountId)).map((r) => r.id);
    expect(ids).not.toContain(mine1);
    expect(ids).not.toContain(mine2);
    // The load-bearing half.
    expect(ids, "another user's wakes must not end because this one signed out").toContain(notMine);
    // And the deviceless row survives, because nothing on it names a user — the same named
    // residue the case below pins, not a gap this may guess at.
    expect(ids).toContain(deviceless);
  });

  /**
   * ── THIS CASE WAS GREEN FOR THE WRONG REASON, AND SAID SO IN ITS OWN MESSAGE ─────────────
   *
   * It used to be called "a BROWSER registration is stamped with its device, so the prune reaches
   * it too", and it passed — because it registered through `seedFullAccount`'s session, which
   * HAS a device id. No browser sign-in produces such a session:
   * `auth/session-lifecycle.ts`'s `AUTO_MINT_DEVICE_LABELS` auto-mints a device row for the four
   * DESKTOP kinds only, and `auth-service.test.ts` asserts through the real ceremony that an
   * exchanged web session's `device_id` is null. So the fixture was the thing being tested, and
   * its own failure message — "a browser registration carries no device, so no sign-out can ever
   * reach it" — stated the opposite of the assertion it was attached to.
   *
   * Seeding a genuinely DEVICELESS session below is what makes these a browser at all. The claim
   * then comes out the other way, and the pair below is the truth: the server's device-scoped
   * prune CANNOT reach a browser's row, and the browser's own delete is what does.
   */
  it("a BROWSER registration is DEVICELESS — the server's prune cannot reach it", async () => {
    /*
     * Through the REAL service, because what is under test is the stamping decision: inserting a
     * row with a device id already on it would assert nothing about who put it there. Here the
     * decision is a no-op — `if (s?.deviceId)` never fires for a web session — and that no-op is
     * the fact the sign-out design has to be built around.
     */
    const seeded = await seedFullAccount(db);
    const web = await devicelessSession(seeded);
    const push = makePushService();
    const { id } = await push.subscribe(
      ctxFor(seeded.accountId, seeded.userId, web),
      {
        transport: "webpush",
        endpoint: `https://push.test/${randomUUID()}`,
        p256dh: "p", auth: "a",
      },
    );

    const [stored] = await db.select({ deviceId: pushSubscriptions.deviceId })
      .from(pushSubscriptions).where(eq(pushSubscriptions.id, id));
    expect(
      stored!.deviceId,
      "a web session named a device — then the stamp, not the client, would close this case",
    ).toBeNull();

    const svc = makeAuthService(makeTestAuthDeps());
    await svc.logout(ctxFor(seeded.accountId, seeded.userId, web), {});
    expect(
      (await rowsFor(seeded.accountId)).map((r) => r.id),
      "the device-scoped prune deleted a row it cannot name — which would mean it is deleting "
      + "every deviceless registration on the account, ending another browser's notifications",
    ).toContain(id);
  });

  it("…and the CLIENT's own delete is what closes it, account-scoped, by the id it kept", async () => {
    /*
     * The other half, and the reason the row above is allowed to survive a `logout`. This browser
     * is the only party that knows WHICH deviceless row is its own — it kept the id this endpoint
     * handed back. So the sign-out ceremony issues `DELETE /push/subscriptions/:id` BEFORE
     * `auth.logout()` revokes the session that authorizes it; the order is asserted on the client
     * in `apps/webapp/test/sign-out-clears-durable-stores.test.ts`, and what is asserted here is
     * that the route it calls actually removes the row a browser can reach.
     *
     * Not vacuous: a second account's row is present, and account scoping is what stops this
     * being a delete-by-id anyone could aim anywhere.
     */
    const seeded = await seedFullAccount(db);
    const other = await seedFullAccount(db);
    const web = await devicelessSession(seeded);
    const push = makePushService();
    const { id } = await push.subscribe(
      ctxFor(seeded.accountId, seeded.userId, web),
      {
        transport: "webpush",
        endpoint: `https://push.test/${randomUUID()}`,
        p256dh: "p", auth: "a",
      },
    );

    // The account that does NOT own it cannot delete it — 404, and the row stands.
    await expect(
      push.unsubscribe(ctxFor(other.accountId, other.userId, other.sessionId), id),
    ).rejects.toThrow();
    expect((await rowsFor(seeded.accountId)).map((r) => r.id)).toContain(id);

    // The browser's own session can, and that is the whole of the take-back.
    await push.unsubscribe(ctxFor(seeded.accountId, seeded.userId, web), id);
    expect(
      (await rowsFor(seeded.accountId)).map((r) => r.id),
      "the client's delete left the row live — nothing else can reach it",
    ).not.toContain(id);
  });

  it("the revoke and the prune are ONE transaction, so a failed prune cannot strand the row", async () => {
    // `super.logout` revokes the session family, and that family is the only credential that
    // could ever ask for this again: the middleware refuses a revoked session before this method
    // is reached. So two autocommitted statements meant a crash between them left the push row
    // live AND the caller unable to retry, while the endpoint kept answering 2xx so the worker's
    // prune-on-404/410 never fired either. Proven by making the transaction body fail after the
    // base logout has run inside it: the revoke must roll back with it.
    const seeded = await seedFullAccount(db);
    const phoneRow = await registerWakeRow(seeded.accountId, seeded.deviceId);

    const svc = makeAuthService(makeTestAuthDeps());
    const ctx = ctxFor(seeded.accountId, seeded.userId, seeded.sessionId);
    const exploding = {
      ...ctx,
      db: new Proxy(db as object, {
        get(target, prop, recv) {
          if (prop !== "transaction") return Reflect.get(target, prop, recv);
          const real = (target as { transaction: (f: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).transaction;
          return (fn: (tx: unknown) => Promise<unknown>) =>
            real.call(target, async (tx: unknown) => {
              await fn(tx);
              throw new Error("the connection died between the revoke and the prune");
            });
        },
      }),
    } as unknown as ServiceContext;

    await expect(svc.logout(exploding, {})).rejects.toThrow(/died between/);

    // NOTHING happened: the row is still there AND the session is still live, so the client's
    // own retry has a credential to retry with. That pairing is the property.
    expect((await rowsFor(seeded.accountId)).map((r) => r.id)).toContain(phoneRow);
    const still = (await db.select({ revokedAt: sessions.revokedAt }).from(sessions)
      .where(eq(sessions.id, seeded.sessionId)))[0];
    expect(still?.revokedAt ?? null, "the revoke must roll back with the prune").toBeNull();

    // And the retry lands both halves.
    await svc.logout(ctx, {});
    expect((await rowsFor(seeded.accountId)).map((r) => r.id)).not.toContain(phoneRow);
  });

  it("a DEVICELESS session prunes nothing — the browser residue is named, not guessed at", async () => {
    // A browser ceremony mints no device row, and web-push rows carry `device_id = NULL`. There
    // is no predicate that names THIS browser rather than every deviceless registration on the
    // account, so deleting them would silently end another browser's notifications. Recorded as
    // a test rather than a comment, because "we chose not to" and "we forgot" look identical in
    // a diff. The fix is to stamp the browser's own registration; that is a separate row.
    const seeded = await seedFullAccount(db);
    const [deviceless] = await db.insert(sessions).values({
      accountId: seeded.accountId, userId: seeded.userId, familyId: randomUUID(),
      accessExpiresAt: new Date(Date.now() + 3_600_000),
      refreshExpiresAt: new Date(Date.now() + 3_600_000),
    }).returning({ id: sessions.id });
    const webRow = await registerWakeRow(seeded.accountId, null);
    // A PHONE ROW HAS TO EXIST for the isolation half to mean anything. Without it the query
    // below returned `[]` because nothing had ever been inserted — the assertion was true for
    // the wrong reason, and a widening of this prune could have turned every phone in the
    // account off with the test that guards it still green.
    const phoneRow = await registerWakeRow(seeded.accountId, seeded.deviceId);

    const svc = makeAuthService(makeTestAuthDeps());
    await svc.logout(ctxFor(seeded.accountId, seeded.userId, deviceless!.id), {});

    const ids = (await rowsFor(seeded.accountId)).map((r) => r.id);
    expect(ids).toContain(webRow);
    // …and the phone's row is untouched by a browser sign-out, which is the other direction of
    // the same rule.
    expect(ids, "a browser sign-out must not take a phone's registration down").toContain(phoneRow);
  });
});
