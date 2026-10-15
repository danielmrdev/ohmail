/**
 * A VERB THAT CANNOT BE TAKEN KEEPS ITS FACE, DIMS, AND SAYS SO. `Button` has carried a
 * `disabled` prop for exactly that since callers were caught swapping VARIANTS to disarm one —
 * which made the unavailable state look like a different, perfectly pressable verb. Eight call
 * sites were disarming by dropping `onPress` instead, which is the same mistake in a new
 * spelling and worse in one measured way: on the iPhone Duo, "Sync now" mid-sync came back to
 * the accessibility tree with NO button role at all, beside a "Disconnect" that had one. The
 * census refuses a disarm that drops the handler, and it is driven against a fixture that does.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lineOf, withoutComments } from "../../../scripts/lib/source-scan.mjs";

/* @reads: apps/mobile/src/ui/base.tsx
   Read by a path built at runtime, so no landing pass selects this file when that source
   moves — the shape `reads-list.mjs` exists for. */

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DIRS = [`${ROOT}/src`, `${ROOT}/app`];

/**
 * The one exception, named: `Button` ITSELF implements `disabled` by withholding the handler,
 * and `GlassActionBar` withholds it during the offscreen MEASURING pass, which no person sees.
 */
const ALLOWED = ["src/ui/base.tsx", "src/ui/glass/GlassActionBar.tsx"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "test" || name.startsWith(".")) continue;
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** `onPress={<anything> ? undefined : …}` or `… : undefined}` — a handler withheld by state. */
const DROPPED = /onPress=\{[^}]*\?[^}]*\bundefined\b[^}]*\}/g;

function droppedIn(src: string): { line: number; text: string }[] {
  return [...src.matchAll(DROPPED)].map((m) => ({ line: lineOf(src, m.index ?? 0), text: m[0] }));
}

describe("a disarmed verb is disabled, not handler-less", () => {
  const files = DIRS.flatMap((d) => walk(d));

  it("the census reads both directories", () => {
    expect(files.length).toBeGreaterThan(30);
    for (const d of DIRS) expect(files.some((f) => f.startsWith(d)), d).toBe(true);
  });

  it("no screen disarms a verb by dropping its press handler", () => {
    const found: string[] = [];
    for (const f of files) {
      const rel = f.slice(ROOT.length + 1);
      if (ALLOWED.includes(rel)) continue;
      for (const hit of droppedIn(withoutComments(readFileSync(f, "utf8")))) {
        found.push(`${rel}:${hit.line}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("the two allowed files are real and still hold the shape — the exception is not stale", () => {
    for (const rel of ALLOWED) {
      expect(droppedIn(withoutComments(readFileSync(`${ROOT}/${rel}`, "utf8"))).length, rel)
        .toBeGreaterThan(0);
    }
  });

  it("Button keeps the face and states the disabled case to a screen reader", () => {
    const base = withoutComments(readFileSync(`${ROOT}/src/ui/base.tsx`, "utf8"));
    expect(base).toContain('accessibilityRole="button"');
    expect(base).toContain("accessibilityState={{ disabled: disabled === true }}");
  });

  it("the census catches the shape — driven, not assumed", () => {
    expect(droppedIn("<Button onPress={busy ? undefined : go} />")).toHaveLength(1);
    expect(droppedIn("<Button onPress={ready ? go : undefined} />")).toHaveLength(1);
    expect(droppedIn("<Button disabled={busy} onPress={go} />")).toHaveLength(0);
  });
});
