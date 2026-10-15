import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { withoutComments } from "../scripts/lib/source-scan.mjs";

/**
 * THE GATE'S AUTHENTICATION QUESTION HAS ONE DEFINITION: core's `SCREENING_AUTH_VERDICTS` through
 * `authScreens`, and the db's pinned copy through `storedAuthScreens`/`authScreensSql`. A comparison
 * of a verdict with the literal "fail" outside them is a second spelling that would not follow the
 * list. The files below compare it on purpose: they name the verdict itself (a reason code, a
 * sentence), not the gate's question, and each says why. Code only; comments may name it.
 */
const CODE = /\.(?:ts|tsx|mts)$/;
const ROOTS = /^(?:packages\/[^/]+\/src\/|apps\/[^/]+\/src\/|apps\/webapp\/app\/)/;
const NEEDLES = [
  /(?:authVerdict|\bauth)\??\s*(?:===|!==|==|!=)\s*["']fail["']/g,
  /["']fail["']\s*(?:===|!==|==|!=)\s*[\w.?]*(?:authVerdict|auth)\b/g,
  /(?:authVerdict\}|auth_verdict)\s*(?:<>|!=|=)\s*'fail'/g,
];
const NAMES_THE_VERDICT: Record<string, string> = {
  "packages/core/src/sender-check.ts": "the `auth_fail` reason code names the verdict",
  "packages/db/src/why-stayed.ts": "the failed-checks sentence names the verdict",
  "packages/services/src/screener-service.ts": "the reason code's correspondent arm, sender-check's twin",
  "packages/services/src/unsubscribe-service.ts": "never unsubscribes on behalf of a sender its provider says is forged",
};

function hitsIn(src: string): number {
  const code = withoutComments(src);
  return NEEDLES.reduce((n, re) => n + [...code.matchAll(re)].length, 0);
}

describe("the gate's authentication question is spelled once", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0").filter((f) => f !== "" && CODE.test(f) && ROOTS.test(f) && !/\/test\//.test(f));

  it("reads the source roots, not nothing", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain("packages/core/src/pipeline.ts");
    expect(files).toContain("packages/db/src/own-mail.ts");
  });

  it("no comparison with the literal outside the files that name the verdict itself", () => {
    const found = files.filter((f) => hitsIn(readFileSync(f, "utf8")) > 0 && !(f in NAMES_THE_VERDICT));
    expect(found).toEqual([]);
  });

  it("every allowed file still compares it (a stale entry is refused)", () => {
    for (const f of Object.keys(NAMES_THE_VERDICT)) expect([f, hitsIn(readFileSync(f, "utf8")) > 0]).toEqual([f, true]);
  });

  it("each spelling, planted, is caught; the same words in a comment are not", () => {
    expect(hitsIn('if (m.authVerdict === "fail") return;\n')).toBe(1);
    expect(hitsIn("const ok = auth !== 'fail';\n")).toBe(1);
    expect(hitsIn("sql`(${m.authVerdict} <> 'fail')`;\n")).toBe(1);
    expect(hitsIn("// authVerdict === \"fail\" demotes\n/* auth_verdict <> 'fail' */\n")).toBe(0);
  });
});
