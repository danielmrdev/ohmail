import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_DEFAULT_TIMEOUTS } from "../src/client.js";
import { MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import {
  SETUP_ROLE_PREFIX, openAdmin, restoreRoleSettings, roleSettings, setupRole, sharedRoleGuard, sweepStaleRoles,
  type AdminSql,
} from "./_setup-role.js";

/**
 * THE GUARD PUTS A ROLE BACK. `setupProdDatabase` writes three deadlines
 * role-wide on the role it connects as (setup-prod.ts, `alter role … set`); a file that let it run
 * as the lane role used to fail its guard and leave the deadlines there for every later file. The
 * subject here is a throwaway role, so the lane role is never the one written: the guard is pointed
 * at it with `roles`, and a refusal is read as a one-word verdict rather than a `.rejects`.
 */
const PG_UP = await realPgAvailable(PG_TEST_URL);

describe.skipIf(!PG_UP)("the shared-role guard", () => {
  const SUBJECT = setupRole();
  const roles = async (): Promise<string[]> => [SUBJECT.name];
  let admin: AdminSql;

  const verdictOf = async (p: Promise<void>): Promise<string> => {
    try { await p; return "PASSED"; } catch (e) { return `REFUSED ${(e as Error).message}`; }
  };
  /** Exactly the statements setup-prod.ts runs on `current_user`, aimed at the subject. */
  const writeDeadlines = async (): Promise<void> => {
    for (const [guc, ms] of Object.entries(ROLE_DEFAULT_TIMEOUTS)) {
      await admin.unsafe(`alter role "${SUBJECT.name}" set ${guc} = '${ms}ms'`);
    }
  };

  beforeAll(async () => {
    admin = openAdmin(PG_TEST_URL);
    await sweepStaleRoles(admin, SETUP_ROLE_PREFIX, { log: (l) => process.stderr.write(`${l}\n`) });
    await SUBJECT.create(admin);
    await admin.unsafe(`alter role "${SUBJECT.name}" set work_mem = '4MB'`);
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => {
    if (!admin) return;
    try { await SUBJECT.drop(admin); } finally { await admin.end({ timeout: 5 }).catch(() => {}); }
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  it("admits a file that changes nothing, and the role reads as it did", async () => {
    const guard = sharedRoleGuard({ roles });
    await guard.start(admin);
    const before = (await roleSettings(admin, SUBJECT.name)).settings;
    expect(await verdictOf(guard.check(admin))).toBe("PASSED");
    expect((await roleSettings(admin, SUBJECT.name)).settings).toBe(before);
  });

  it("refuses a file that leaves the three deadlines and a changed setting behind, and puts the role back", async () => {
    const guard = sharedRoleGuard({ roles });
    await guard.start(admin);
    const before = (await roleSettings(admin, SUBJECT.name)).settings;
    await writeDeadlines();
    await admin.unsafe(`alter role "${SUBJECT.name}" set work_mem = '8MB'`);
    expect((await roleSettings(admin, SUBJECT.name)).settings).not.toBe(before);

    const v = await verdictOf(guard.check(admin));
    expect(v.startsWith("REFUSED"), v).toBe(true);
    expect(v).toContain("put back, read back equal");
    for (const guc of Object.keys(ROLE_DEFAULT_TIMEOUTS)) expect(v).toContain(`${guc} reset on ${SUBJECT.name}`);
    expect(v).toContain(`work_mem put back to 4MB on ${SUBJECT.name}`);
    expect((await roleSettings(admin, SUBJECT.name)).settings).toBe(before);
    // The next file meets the role clean, so its own start does not refuse for this one's leftover.
    expect(await verdictOf(sharedRoleGuard({ roles }).start(admin))).toBe("PASSED");
  });

  it("puts back a setting scoped to one database apart from the role-wide one", async () => {
    const before = (await roleSettings(admin, SUBJECT.name)).settings;
    const db = (await admin<Array<{ d: string }>>`select current_database() as d`)[0]!.d;
    await admin.unsafe(`alter role "${SUBJECT.name}" in database "${db}" set lock_timeout = '1234ms'`);
    const did = await restoreRoleSettings(admin, SUBJECT.name, before);
    expect(did).toEqual([`lock_timeout reset on ${SUBJECT.name}`]);
    expect((await roleSettings(admin, SUBJECT.name)).settings).toBe(before);
  });
});
