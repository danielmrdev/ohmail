import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { SIGN_IN_RECORD_RETENTION_MS } from "../src/retention.js";

/**
 * THE PRUNE NEVER TAKES A SESSION A READER STILL COUNTS. Two readers look back at revoked sessions:
 * the staff console's account view (sessions revoked within `ACCOUNT_HISTORY_DAYS`) and the
 * device-staleness alert (a session revoked within 14 days still arms it). The horizon must reach
 * past both; equal is coherent today and fragile tomorrow, so the numbers are read, not assumed.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const code = (file: string): string => withoutComments(readFileSync(join(REPO, file), "utf8"));
const DAY = 24 * 60 * 60 * 1000;

function days(file: string, re: RegExp, what: string): number {
  const m = re.exec(code(file));
  if (!m) throw new Error(`${file} no longer states ${what} in the shape this test reads`);
  return Number(m[1]);
}

describe("the sign-in retention horizon reaches past every reader of a revoked session", () => {
  it("the staff console's history window", () => {
    const history = days("packages/services/src/admin-service.ts", /\bconst ACCOUNT_HISTORY_DAYS = (\d+);/, "ACCOUNT_HISTORY_DAYS");
    expect(SIGN_IN_RECORD_RETENTION_MS).toBeGreaterThanOrEqual(history * DAY);
  });

  it("the device-staleness alert's armed window", () => {
    const armed = days("packages/db/src/alerts.ts",
      /const deviceArmCut = new Date\(now\.getTime\(\) - (\d+) \* 24 \* 60 \* 60 \* 1000\);/, "the alert's armed window");
    expect(SIGN_IN_RECORD_RETENTION_MS).toBeGreaterThanOrEqual(armed * DAY);
  });
});
