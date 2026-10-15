import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments, lineOf } from "../../../scripts/lib/source-scan.mjs";

/**
 * THE DIALECT CAST HAS ONE HOME (review 020, BACKEND L4). Services are typed against the pg
 * builder while the handle may be PGlite, hosted Postgres or the phone's sqlite-proxy; that
 * crossing used to be 118 hand-spelled `as unknown as Tx|Db` casts across 39 files, each one a
 * place where the assertion and its reason could drift apart. The crossing is now `bridgeTx` /
 * `bridgeDb` in `context.ts`, and this census pins the raw cast count outside that file at ZERO —
 * `as any as` counted too, because the workaround spelling is the same cast wearing a different
 * word. Scans `packages/services/src` only — its own package.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "src");
const BRIDGE_HOME = "context.ts";
/** The two bridge bodies — the only raw casts the package may carry. */
const BRIDGE_CASTS = 2;

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

/** Raw dialect casts in one file's comment-stripped text, as `file:line` rows. */
function rawCasts(file: string, code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/\bas\s+(?:unknown|any)\s+as\s+(?:Tx|Db)\b/g)) {
    out.push(`${file}:${lineOf(code, m.index)}`);
  }
  return out;
}

describe("dialect bridge census", () => {
  const files = sources(SRC);

  it("zero raw Tx/Db casts outside the bridge, exactly the bridge's own inside it", () => {
    const home = files.find((f) => f.file === BRIDGE_HOME);
    expect(home, "context.ts must exist").toBeTruthy();
    expect(rawCasts(BRIDGE_HOME, home!.code).length, "the bridge's own casts").toBe(BRIDGE_CASTS);

    const outside = files
      .filter((f) => f.file !== BRIDGE_HOME)
      .flatMap((f) => rawCasts(f.file, f.code));
    expect(outside, "raw dialect casts outside the bridge — call bridgeTx/bridgeDb instead").toEqual([]);
  });

  it("the bridge is called, not merely defined", () => {
    // A census over a helper nobody calls pins nothing: the sweep left ~38 calling files, so a
    // floor of 20 survives ordinary refactors while a silent mass-revert to raw casts cannot.
    const callers = files.filter(
      (f) => f.file !== BRIDGE_HOME && /\bbridge(?:Tx|Db)\s*\(/.test(f.code),
    );
    expect(callers.length, "files calling bridgeTx/bridgeDb").toBeGreaterThanOrEqual(20);
  });

  it("refuses raw and workaround casts, admits the bridge call (positive control)", () => {
    const raw = withoutComments("const t = ctx.db as unknown as Tx;") as string;
    expect(rawCasts("synthetic.ts", raw).length).toBe(1);
    const workaround = withoutComments("const d = tx as any as Db;") as string;
    expect(rawCasts("synthetic.ts", workaround).length).toBe(1);
    // A cast to another type is not a dialect crossing — out of this census's class.
    const other = withoutComments("const r = x as unknown as SomethingElse;") as string;
    expect(rawCasts("synthetic.ts", other)).toEqual([]);
    // The bridge call is the admitted shape.
    const bridged = withoutComments("const t = bridgeTx(ctx.db);") as string;
    expect(rawCasts("synthetic.ts", bridged)).toEqual([]);
    // A mention inside a comment is not a cast — the strip is load-bearing.
    const comment = withoutComments("// tx as unknown as Tx\nconst x = 1;") as string;
    expect(rawCasts("synthetic.ts", comment)).toEqual([]);
  });
});
