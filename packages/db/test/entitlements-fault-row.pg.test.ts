import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { entitlementsFaultRow } from "../src/api-faults.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * ── THE ROW HAS TO SURVIVE THE DATABASE, AND THAT IS NOT A PARAPHRASE ────────────────────────
 *
 * `api_faults` carries three CHECKs (cloud 0033) and this lane was written against a brief that
 * believed `arm` was a plain text column. It is not: `arm IN ('api','worker')` refuses
 * `entitlements` with 23514, which is why the row is written with a SYNTHETIC route under an
 * admitted arm instead. A mapping tested only against itself would have shipped that belief.
 *
 * So the constraints come out of the MIGRATION FILE, verbatim, applied to a probe schema — not
 * retyped here, where they could drift from the statements production actually ran.
 *
 * Skips gracefully when no real Postgres is reachable.
 */
const SQL_PATH = new URL("../drizzle-cloud/0033_api_faults.sql", import.meta.url);
const PG_UP = await realPgAvailable(PG_TEST_URL);
const SCHEMA = `zz_faultrow_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

/** 0033's statements, split on its own breakpoints. The table and its CHECKs, nothing retyped. */
const statements = readFileSync(SQL_PATH, "utf8")
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

let sql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  if (!PG_UP) return;
  sql = postgres(PG_TEST_URL, { max: 1, onnotice: () => { /* quiet */ } });
  await sql.unsafe(`CREATE SCHEMA "${SCHEMA}"`);
  // `search_path` puts 0033's unqualified "api_faults" in the probe schema; `public` stays on it
  // so `gen_random_uuid()` still resolves.
  await sql.unsafe(`SET search_path TO "${SCHEMA}", public`);
  for (const s of statements) await sql.unsafe(s);
});

afterAll(async () => {
  if (!sql) return;
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await sql.end();
});

/** Insert one row, and say which constraint refused it rather than throwing the whole suite. */
const insert = async (row: ReturnType<typeof entitlementsFaultRow>): Promise<string> => {
  try {
    await sql!.unsafe(
      `INSERT INTO "${SCHEMA}"."api_faults" (at, route, method, status, error_class, request_id, arm)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.at, row.route, row.method, row.status, row.errorClass, row.requestId, row.arm],
    );
    return "ACCEPTED";
  } catch (e) {
    const err = e as { code?: string; constraint_name?: string };
    return `REFUSED ${err.code ?? "?"} ${err.constraint_name ?? ""}`.trim();
  }
};

describe.skipIf(!PG_UP)("every row the mapper can produce is accepted by cloud 0033 itself", () => {
  it("a timeout and a refusal, on every path the client dials", async () => {
    const paths = [
      "/v1/access", "/v1/spend", "/v1/spend/release", "/v1/manage-link", "/v1/account/release",
    ];
    for (const path of paths) {
      for (const status of [null, 500, 502, 503, 599, 400, 401, 404, 429]) {
        for (const arm of ["api", "worker"] as const) {
          for (const outlivedRequest of [false, true]) {
            const verdict = await insert(
              entitlementsFaultRow({ path, status, outlivedRequest }, arm, new Date()));
            expect(verdict, `${path} status=${String(status)} arm=${arm} outlived=${String(outlivedRequest)}`)
              .toBe("ACCEPTED");
          }
        }
      }
    }
  });

  it("and the rows are readable back as their own series, not the route's", async () => {
    const rows = await sql!.unsafe(
      `SELECT DISTINCT route FROM "${SCHEMA}"."api_faults" ORDER BY route`);
    const routes = rows.map((r) => (r as unknown as { route: string }).route);
    expect(routes).toEqual([
      "entitlements:/v1/access", "entitlements:/v1/account/release", "entitlements:/v1/manage-link",
      "entitlements:/v1/spend", "entitlements:/v1/spend/release",
    ]);
  });

  /**
   * THE NEGATIVE CONTROLS — without them every case above passes for a table with no constraints
   * at all, and this file's whole reason for existing is that one of these refusals was a
   * surprise.
   */
  it("arm 'entitlements' is REFUSED — the measurement this lane's design turns on", async () => {
    const row = { ...entitlementsFaultRow({ path: "/v1/spend", status: null }, "api", new Date()) };
    const verdict = await insert({ ...row, arm: "entitlements" as unknown as "api" });
    expect(verdict).toContain("REFUSED 23514");
    expect(verdict).toContain("api_faults_arm_check");
  });

  it("a 4xx status is REFUSED, which is why the mapper never writes one", async () => {
    const row = entitlementsFaultRow({ path: "/v1/access", status: 404 }, "api", new Date());
    // The mapper already turned it into 502; putting the raw status back is what the column
    // refuses, and that refusal is what would have taken the diagnosis with it.
    const verdict = await insert({ ...row, status: 404 });
    expect(verdict).toContain("REFUSED 23514");
    expect(verdict).toContain("api_faults_status_check");
  });
});
