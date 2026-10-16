import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { setupProdDatabase } from "../src/setup-prod.js";
import { runMigrations, MIGRATION_LOCK_KEY } from "../src/migrate.js";
import { ROLE_DEFAULT_TIMEOUTS, API_MAX_DURATION_MS } from "../src/client.js";
import { MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { STALE_ROLE_MS, openAdmin, roleAgeVerdict, roleStamp, sharedRoleGuard, sweepStaleRoles } from "./_setup-role.js";

/**
 * ── THE MECHANISM THAT ACTUALLY REACHES A TRANSACTION-MODE POOLER, PROVEN AGAINST A VIRGIN
 *    CONNECTION WITH NO CLIENT-SIDE OPTIONS AT ALL ──────────────────────────────────────────────
 *
 * `client.ts#ROLE_DEFAULT_TIMEOUTS`'s whole docblock is the "why", corrected TWICE by
 * measurement: `connection: {…}` startup parameters are inert through the pooler (attempt one),
 * and so is a `pg_db_role_setting` row scoped `IN DATABASE …` (attempt two) — every one of
 * the hosted provider's own hardened defaults is ROLE-ONLY, and matching that shape is what finally reached
 * the backend. `ALTER ROLE … SET …` with no `IN DATABASE` applies to EVERY database the role
 * ever opens, so it cannot be tested the way attempt two was (create a probe database, drop it
 * afterward) without leaving a permanent side effect on the SHARED `tf` role every other test in
 * this repository connects as. Every test below runs against a DISPOSABLE, LOGIN-capable role
 * created in `beforeAll` and dropped in `afterAll` — dropping the role removes its
 * `pg_db_role_setting` rows with it, exactly as dropping a database removed the (wrong) scoped
 * ones in the version of this file that tested attempt two.
 *
 * The acceptance criterion this file proves is therefore NOT "the client that requested the
 * timeout got it" — that was the exact claim that failed production, twice. It is: **open a
 * SECOND, completely bare connection, authenticated as the same role, with `connection: {}`
 * unset, and the default is already there.** That is the only shape of proof this mechanism's
 * own justification allows.
 *
 * Skips gracefully when no real Postgres is reachable — the docker compose service on :5433.
 */
const ADMIN_URL = PG_TEST_URL;

const PG_UP = await realPgAvailable(ADMIN_URL);

/**
 * `current_setting()` reports a GUC in whichever unit Postgres finds "nicest" — `55000ms` comes
 * back as `'55s'`, but `10000ms` comes back as `'10s'` too and `500ms` stays `'500ms'`. A literal
 * string comparison is therefore a property of which VALUE was chosen, not of whether the
 * setting took — exactly the kind of test that passes today and breaks the moment somebody
 * tunes a number to a value that formats differently. Parsed to milliseconds instead.
 */
function parseGucMs(value: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|min|h|d)?$/.exec(value.trim());
  if (!m) throw new Error(`unparseable GUC duration: ${JSON.stringify(value)}`);
  const n = Number(m[1]);
  const mult = { ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? "ms"];
  return n * mult;
}

describe.skipIf(!PG_UP)("ROLE_DEFAULT_TIMEOUTS — the values", () => {
  it("every ceiling is a positive integer, and statement_timeout gives up before the platform kill", () => {
    for (const [k, v] of Object.entries(ROLE_DEFAULT_TIMEOUTS)) {
      expect(v, `${k} must be a positive integer`).toBeGreaterThan(0);
    }
    // The whole reason this is 55 s and not WORKER_TIMEOUTS' 60 s verbatim: the database must
    // give up strictly before a serverless function's own kill, never race it.
    expect(ROLE_DEFAULT_TIMEOUTS.statement_timeout).toBeLessThan(API_MAX_DURATION_MS);
    // The same ordering invariant WORKER_TIMEOUTS' own test pins: a lock wait must give up
    // before a statement does, or the statement ceiling masks it and the error names the wrong
    // cause.
    expect(ROLE_DEFAULT_TIMEOUTS.lock_timeout).toBeLessThanOrEqual(ROLE_DEFAULT_TIMEOUTS.statement_timeout);
  });
});

/** This file's roles; a killed run leaves one behind, and the next run sweeps it by its stamp. */
const ROLE_PREFIX = "ohmail_role_deadline_";

describe.skipIf(!PG_UP)("ROLE_DEFAULT_TIMEOUTS — applied by setupProdDatabase, against a real backend", () => {
  const ROLE = `${ROLE_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const PASSWORD = randomUUID();
  const PROBE_DB = `ohmail_role_deadline_probe_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let admin: ReturnType<typeof postgres>;
  /** setupProdDatabase runs as ROLE; the lane role and tf beside it must read as they did, or be put back. */
  const guard = sharedRoleGuard();

  /** The disposable role's own URL against a database IT OWNS. */
  const roleUrl = (): string => {
    const u = new URL(ADMIN_URL);
    u.username = ROLE;
    u.password = PASSWORD;
    u.pathname = `/${PROBE_DB}`;
    return u.toString();
  };

  beforeAll(async () => {
    admin = postgres(ADMIN_URL, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
    await guard.start(admin);
    // LOGIN + password: this role only ever needs to connect and run migrations against a
    // database it OWNS outright — never the shared `trafficflow_test` accumulator, whose
    // existing tables this brand-new role would have no grants on.
    await sweepStaleRoles(admin, ROLE_PREFIX, { log: (l) => process.stderr.write(`${l}\n`) });
    await admin.unsafe(`create role ${ROLE} with login password '${PASSWORD}'`);
    await admin.unsafe(`comment on role ${ROLE} is '${roleStamp(Date.now())}'`);
    await admin.unsafe(`create database "${PROBE_DB}" owner ${ROLE}`);
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => {
    if (admin) {
      // The database first (a role that still owns one cannot be dropped), then the role — DROP
      // ROLE removes its `pg_db_role_setting` rows with it. A role-only default cannot be
      // scoped away by dropping a database the way the (wrong) `IN DATABASE` version could, so
      // the role itself is the disposable unit that matters here.
      await admin.unsafe(`drop database if exists "${PROBE_DB}" with (force)`).catch(() => {});
      await admin.unsafe(`drop role if exists ${ROLE}`).catch(() => {});
      try { await guard.check(admin); } finally { await admin.end({ timeout: 5 }).catch(() => {}); }
    }
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  afterEach(async () => { if (admin) await guard.check(admin); });

  it("setupProdDatabase's report names the role and verifies every GUC", async () => {
    const report = await setupProdDatabase(roleUrl());
    expect(report.roleDefaults, "roleDefaults must not be null against a reachable database").not.toBeNull();
    expect(report.roleDefaults!.role).toBe(ROLE);
    for (const guc of Object.keys(ROLE_DEFAULT_TIMEOUTS)) {
      expect(report.roleDefaults!.verified[guc as keyof typeof ROLE_DEFAULT_TIMEOUTS],
        `${guc} must be verified from pg_db_role_setting, not merely attempted`).toBe(true);
    }
  }, 60_000);

  it("THE ACCEPTANCE: a VIRGIN connection with NO client-side options already carries the default", async () => {
    await setupProdDatabase(roleUrl());

    // No `connection: {…}` at all — this is the shape a pooler-multiplexed backend actually
    // gets handed, and it is the shape `connection: POOLED_TIMEOUTS` failed to reach in
    // production. If this passes only because the CLIENT asked for it, the test is worthless;
    // it must pass because POSTGRES ITSELF applied the default at session start.
    const virgin = postgres(roleUrl(), { max: 1, onnotice: () => {} });
    try {
      const rows = await virgin`select current_setting('statement_timeout') as stmt,
        current_setting('lock_timeout') as lock,
        current_setting('idle_in_transaction_session_timeout') as idle`;
      const r = rows[0]!;
      expect(parseGucMs(r.stmt)).toBe(ROLE_DEFAULT_TIMEOUTS.statement_timeout);
      expect(parseGucMs(r.lock)).toBe(ROLE_DEFAULT_TIMEOUTS.lock_timeout);
      expect(parseGucMs(r.idle)).toBe(ROLE_DEFAULT_TIMEOUTS.idle_in_transaction_session_timeout);
    } finally {
      await virgin.end({ timeout: 5 });
    }
  }, 60_000);

  it("THE REGRESSION: a runaway statement on a bare connection is CANCELLED at the role default", async () => {
    await setupProdDatabase(roleUrl());

    const virgin = postgres(roleUrl(), { max: 1, onnotice: () => {} });
    const started = Date.now();
    try {
      const err = await virgin`select pg_sleep(${(ROLE_DEFAULT_TIMEOUTS.statement_timeout / 1000) + 15})`
        .then(() => null)
        .catch((e: unknown) => e as { code?: string });
      // 57014 = query_canceled — the role default fired with no client cooperation at all.
      expect(err, "the runaway statement must fail, not run to completion").not.toBeNull();
      expect(err?.code).toBe("57014");
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(ROLE_DEFAULT_TIMEOUTS.statement_timeout - 2_000);
      expect(took).toBeLessThan(API_MAX_DURATION_MS);
    } finally {
      await virgin.end({ timeout: 5 });
    }
  }, 90_000);

  it("THE RISK NAMED BY REVIEW: migrate.ts's own 120s lock WAIT survives an active role default", async () => {
    // `migrate.ts#MIGRATION_LOCK_TIMEOUT_MS` (120 s) is the intended ceiling for the migration
    // advisory-lock WAIT — a single `pg_advisory_lock()` call, which is one Postgres STATEMENT
    // from the server's point of view. Once ROLE_DEFAULT_TIMEOUTS exists, a role default's own
    // statement_timeout (55 s) would cancel that wait early — with the wrong error, at the wrong
    // time — unless migrate.ts neutralizes it BEFORE taking the lock. This is the scenario:
    // apply the role default first, THEN hold the lock from elsewhere for LONGER than the role
    // default's ceiling but well inside migrate.ts's own intended wait, and confirm the second
    // caller still gets the lock rather than a canceled statement.
    await setupProdDatabase(roleUrl());

    const holdMs = ROLE_DEFAULT_TIMEOUTS.statement_timeout + 10_000;
    const holder = postgres(roleUrl(), { max: 1, onnotice: () => {} });
    const key = MIGRATION_LOCK_KEY as unknown as number;
    // `pg_advisory_lock` (what migrate.ts itself calls) is SESSION-scoped, not
    // transaction-scoped — it does NOT release at COMMIT, only on an explicit unlock or when the
    // session ends. So the hold is: neutralize this harness connection's own role-default
    // ceilings (the same ones migrate.ts neutralizes — a killed idle-in-transaction wait here
    // would be a test-harness artifact, not a finding about migrate.ts), take the lock, sleep,
    // then let closing the connection below release it.
    await holder.unsafe(`set statement_timeout = 0`);
    await holder.unsafe(`set idle_in_transaction_session_timeout = 0`);
    await holder`select pg_advisory_lock(${key})`;
    const releaseTimer = setTimeout(() => { void holder.end({ timeout: 5 }); }, holdMs);

    try {
      // Let the holder actually take the lock before the second caller asks for it.
      await new Promise((r) => setTimeout(r, 500));
      const started = Date.now();
      // A second `runMigrations` against an already-fully-migrated database applies nothing —
      // the WAIT for the lock is the only thing under test.
      await expect(runMigrations(roleUrl())).resolves.toBeUndefined();
      const took = Date.now() - started;
      expect(took, "the wait must run past the role default's own statement_timeout")
        .toBeGreaterThanOrEqual(ROLE_DEFAULT_TIMEOUTS.statement_timeout);
    } finally {
      clearTimeout(releaseTimer);
      await holder.end({ timeout: 5 }).catch(() => {});
    }
  }, 120_000);

  it("setup-prod.ts's OWN connection shape (max:1, no client-side timeout options) survives its own role default", async () => {
    // `ensureWithheldProvenanceIndex`/`ensureSearchExtensions` build a CONCURRENT index and a
    // GIN trigram index respectively — multi-minute against a real, large `messages` table, and
    // an empty local probe table cannot reproduce that runtime to force the real regression.
    // This proves the actual MECHANISM `setup-prod.ts`'s `pre`/`client` connections rely on —
    // the identical `postgres(url, { max: 1, onnotice })` shape, the identical neutralizing
    // `set statement_timeout = 0` / `set idle_in_transaction_session_timeout = 0` pair, in the
    // position setup-prod.ts places them (immediately after connecting, before any real work) —
    // survives an ALREADY-ACTIVE role default from a prior `setupProdDatabase` run.
    await setupProdDatabase(roleUrl());

    const conn = postgres(roleUrl(), { max: 1, onnotice: () => {} });
    try {
      await conn.unsafe(`set statement_timeout = 0`);
      await conn.unsafe(`set idle_in_transaction_session_timeout = 0`);
      const started = Date.now();
      await conn`select pg_sleep(${(ROLE_DEFAULT_TIMEOUTS.statement_timeout / 1000) + 10})`;
      expect(Date.now() - started).toBeGreaterThanOrEqual(ROLE_DEFAULT_TIMEOUTS.statement_timeout);
    } finally {
      await conn.end({ timeout: 5 });
    }
  }, 90_000);

  it("is idempotent: re-running setupProdDatabase against an already-configured database still verifies", async () => {
    await setupProdDatabase(roleUrl());
    const second = await setupProdDatabase(roleUrl());
    for (const guc of Object.keys(ROLE_DEFAULT_TIMEOUTS)) {
      expect(second.roleDefaults!.verified[guc as keyof typeof ROLE_DEFAULT_TIMEOUTS]).toBe(true);
    }
  }, 60_000);
});

describe("roleAgeVerdict — the orphan sweep's deciding rule", () => {
  const now = 10 * STALE_ROLE_MS;
  it("drops only a stamp older than the bound; an unstamped or foreign comment is never stale", () => {
    expect(roleAgeVerdict(roleStamp(now - STALE_ROLE_MS - 1), now, STALE_ROLE_MS)).toBe("stale");
    expect(roleAgeVerdict(roleStamp(now - STALE_ROLE_MS), now, STALE_ROLE_MS)).toBe("young");
    expect(roleAgeVerdict(roleStamp(now - 2 * STALE_ROLE_MS, "first-seen"), now, STALE_ROLE_MS)).toBe("stale");
    expect(roleAgeVerdict(null, now, STALE_ROLE_MS)).toBe("unstamped");
    expect(roleAgeVerdict("somebody else's note", now, STALE_ROLE_MS)).toBe("unstamped");
  });
});

describe.skipIf(!PG_UP)("the orphan sweep, against planted roles", () => {
  const tag = randomUUID().replace(/-/g, "").slice(0, 10);
  const OLD = `${ROLE_PREFIX}ctl_old_${tag}`;
  const YOUNG = `${ROLE_PREFIX}ctl_young_${tag}`;
  const BARE = `${ROLE_PREFIX}ctl_bare_${tag}`;
  const OLD_DB = `${ROLE_PREFIX}probe_ctl_${tag}`;

  it("drops a planted role stamped two hours ago with the database it owns, and keeps the young and the unstamped", async () => {
    const admin = openAdmin(ADMIN_URL);
    try {
      for (const r of [OLD, YOUNG, BARE]) await admin.unsafe(`create role ${r} nologin`);
      await admin.unsafe(`comment on role ${OLD} is '${roleStamp(Date.now() - 2 * STALE_ROLE_MS)}'`);
      await admin.unsafe(`comment on role ${YOUNG} is '${roleStamp(Date.now() - 60_000)}'`);
      await admin.unsafe(`create database "${OLD_DB}" owner ${OLD}`);

      const lines: string[] = [];
      const swept = await sweepStaleRoles(admin, ROLE_PREFIX, { log: (l) => lines.push(l) });
      expect(swept.dropped).toContain(OLD);
      expect(swept.kept).toContain(YOUNG);
      expect(swept.stamped).toContain(BARE);
      expect(lines.join("\n")).toMatch(/dropped [1-9]\d*, stamped [1-9]\d*, kept [1-9]\d*/);

      const left = await admin<Array<{ rolname: string; comment: string | null }>>`
        select rolname, shobj_description(oid, 'pg_authid') as comment from pg_roles
         where rolname in (${OLD}, ${YOUNG}, ${BARE}) order by rolname`;
      expect(left.map((r) => r.rolname).sort()).toEqual([BARE, YOUNG].sort());
      expect(left.find((r) => r.rolname === BARE)!.comment).toMatch(/^ohmail-test-role first-seen=\d+$/);
      const db = await admin`select 1 from pg_database where datname = ${OLD_DB}`;
      expect(db, "the stale role's database must go with it").toHaveLength(0);
    } finally {
      await admin.unsafe(`drop database if exists "${OLD_DB}" with (force)`).catch(() => {});
      for (const r of [OLD, YOUNG, BARE]) await admin.unsafe(`drop role if exists ${r}`).catch(() => {});
      await admin.end({ timeout: 5 }).catch(() => {});
    }
  }, 60_000);
});
