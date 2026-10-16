import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BOX_TOKEN_ENV, FREEZE_ENV, PG_TEST_URL, pgTestUrl } from "../src/testing.js";

/*
 * THE URL A PG FILE DIALS GOES THROUGH THE SHARED-BOX REFUSAL. Twenty-four files read the URL raw
 * and ran on the shared box unlocked from a checkout with no lane database. `pgTestUrl` is the one
 * resolver they take it from now; nothing here dials, the refusal is asked before any client exists.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FILE = new URL("../../services/test/search-budget.pg.test.ts", import.meta.url).href;
const BOX = "postgres://tf:tf@localhost:5433/trafficflow_test";
const BOX_LOOPBACK = "postgres://tf:tf@127.0.0.1:5433/trafficflow_test";
/* The shared box's database on a port nothing listens on: the door arm's probe reaches the dial and no box. */
const DEAD_BOX = "postgres://tf:tf@127.0.0.1:1/trafficflow_test";
const LANE = "postgres://tf:tf@localhost:5433/trafficflow_l_0123456789ab";
/* A host that is not the box, interpolated: a whole credentialed URL literal is a credential to the push gate. */
const FOREIGN_HOST = "db.example";
const FOREIGN = `postgres://u:p@${FOREIGN_HOST}:5432/ohmail`;

/* The freeze's environment as box-lock.sh hands it over: the flag beside the token it wrote. The
 * token's file is a fixture, handed in by parameter (TOKEN_AT): the environment cannot name one. */
let BOX_DIR = "";
let TOKEN_AT = "";
/* The token is 32 hex, the shape the box door reads; assembled at run time and asserted below. */
const TOKEN = createHash("sha256").update("pg-test-url-refusal fixture").digest("hex").slice(0, 32);
let FREEZE: NodeJS.ProcessEnv = {};
beforeAll(() => {
  BOX_DIR = mkdtempSync(join(tmpdir(), "pg-url-box-"));
  TOKEN_AT = join(BOX_DIR, "ohmail-pg.token");
  writeFileSync(TOKEN_AT, `${TOKEN}\n`, { mode: 0o600 });
  FREEZE = { [FREEZE_ENV]: "1", [BOX_TOKEN_ENV]: TOKEN, BOX_LOCK_DIR: BOX_DIR };
});
afterAll(() => { rmSync(BOX_DIR, { recursive: true, force: true }); });

function refusalOf(url: string, env: NodeJS.ProcessEnv, tokenAt?: string): string {
  try { pgTestUrl(FILE, url, env, tokenAt); } catch (e) { return e instanceof Error ? e.message : String(e); }
  return "ADMITTED";
}

describe("pgTestUrl, the URL every pg file takes", () => {
  it("is handed a fixture token of the box token's own shape", () => {
    expect(TOKEN).toMatch(/^[0-9a-f]{32}$/);
  });

  it("refuses the shared box without OHMAIL_FREEZE=1, naming the file and the remedy", () => {
    for (const url of [BOX, BOX_LOOPBACK]) {
      const why = refusalOf(url, {});
      expect(why).toContain("[pg] packages/services/test/search-budget.pg.test.ts: ");
      expect(why).toContain("SHARED box database (trafficflow_test)");
      expect(why).toContain(`bash scripts/lane-db.sh ${ROOT} `);
    }
  });

  it("returns a lane database and a foreign URL as they are, freeze or not", () => {
    for (const url of [LANE, FOREIGN]) {
      expect(pgTestUrl(FILE, url, {})).toBe(url);
      expect(pgTestUrl(FILE, url, { [FREEZE_ENV]: "1" })).toBe(url);
      expect(pgTestUrl(FILE, url, FREEZE)).toBe(url);
    }
  });

  it("defaults to this checkout's own resolution", () => {
    const of = (url?: string) => { try { return pgTestUrl(FILE, url, FREEZE, TOKEN_AT); } catch (e) { return e instanceof Error ? e.message : String(e); } };
    expect(of(undefined)).toBe(of(PG_TEST_URL));
  });
});
