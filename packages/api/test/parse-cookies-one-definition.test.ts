import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * `parseCookies` IS DEFINED ONCE (review 020, BACKEND L4). It existed twice in this package —
 * one private to `middleware.ts`, one exported from `routes/shared.ts`, byte-identical — and a
 * divergence would have split cookie parsing between the CSRF gate and the handlers: the same
 * header read two ways is two sessions. The census pins the definition count at exactly one, in
 * the shared module, and refuses a second wherever it appears.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "src");
const ONE_HOME = "routes/shared.ts";

function sources(dir: string, into: { file: string; code: string }[] = []): { file: string; code: string }[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, into);
    else if (extname(name) === ".ts") {
      into.push({ file: relative(SRC, p), code: withoutComments(readFileSync(p, "utf8")) as string });
    }
  }
  return into;
}

/** Definitions, not mentions: a `function` declaration or a `const … =` binding of the name. */
function definitionsIn(file: string, code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/\bfunction\s+parseCookies\b|\bconst\s+parseCookies\s*=/g)) {
    out.push(`${file}@${m.index}`);
  }
  return out;
}

describe("parseCookies one-definition census", () => {
  const files = sources(SRC);

  it("exactly one definition, in routes/shared.ts", () => {
    const defs = files.flatMap((f) => definitionsIn(f.file, f.code));
    expect(defs.length, `parseCookies definitions found: ${defs.join(", ")}`).toBe(1);
    expect(defs[0].startsWith(ONE_HOME), `the one definition lives in ${ONE_HOME}, found ${defs[0]}`).toBe(true);
    // The consumers still exist — a census over a symbol nobody calls pins nothing.
    const calls = files.filter((f) => !f.file.startsWith(ONE_HOME) && /\bparseCookies\s*\(/.test(f.code));
    expect(calls.length, "files calling parseCookies").toBeGreaterThanOrEqual(2);
  });

  it("refuses a second definition and admits a mention (positive control)", () => {
    const offender = withoutComments(`
      function parseCookies(header: string | null): Record<string, string> { return {}; }
    `) as string;
    expect(definitionsIn("synthetic.ts", offender).length).toBe(1);
    const arrow = withoutComments("const parseCookies = (h: string | null) => ({});") as string;
    expect(definitionsIn("synthetic.ts", arrow).length).toBe(1);
    // A CALL is not a definition — the import-and-use shape stays admitted.
    const mention = withoutComments('const jar = parseCookies(req.headers.get("cookie"));') as string;
    expect(definitionsIn("synthetic.ts", mention)).toEqual([]);
  });
});
