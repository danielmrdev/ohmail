/**
 * A SYNTHETIC EVENT IS READ IN THE HANDLER, NEVER AFTER IT RETURNS.
 *
 * React Native's Fabric renderer still POOLS `SyntheticEvent`: its `destructor()` sets
 * `nativeEvent` to null when the handler returns and the event goes back to the pool. So a read
 * deferred into a state updater, a timer or a promise runs against null and throws — and RN
 * reports an unhandled JS error as FATAL, so the app dies. Measured on the iPad simulator
 * 2026-09-21 14:35:44: `TypeError: Cannot read property 'layout' of null`, componentStack
 * `at GlassActionBar`, `reportFatal` on the TurboModule queue 0.11 s before the report.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lineOf, withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";

/** The two RN roots. `test/`, `node_modules/` and the generated `ios/`/`android/` carry no app
 *  handlers; `modules/` and `plugins/` are native config, not React. */
const ROOTS = ["src", "app"].map((d) => new URL("../" + d, import.meta.url).pathname);

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

type Read = { at: number; id: string; declared: boolean; deferred: boolean };

/** The `=>` that declares `id` as a parameter, searching back from `at`; -1 when none does. */
function declaringArrow(src: string, at: number, id: string): number {
  const word = new RegExp("(^|[^\\w$])" + id + "([^\\w$]|$)");
  for (let k = src.lastIndexOf("=>", at); k > 0; k = src.lastIndexOf("=>", k - 1)) {
    let j = k - 1;
    while (j >= 0 && /\s/.test(src[j]!)) j--;
    let params: string;
    if (src[j] === ")") {
      let d = 0, i = j;
      for (; i >= 0; i--) {
        if (src[i] === ")") d++;
        else if (src[i] === "(") { d--; if (d === 0) break; }
      }
      if (i < 0) continue;
      params = src.slice(i + 1, j);
    } else {
      let i = j;
      while (i >= 0 && /[\w$]/.test(src[i]!)) i--;
      params = src.slice(i + 1, j + 1);
    }
    if (word.test(params)) return k + 2;
  }
  return -1;
}

/** True when a function opened after `from` is STILL OPEN at `at` — the read is deferred. */
function insideANestedFunction(src: string, from: number, at: number): boolean {
  const stack: { block: boolean; depth: number }[] = [];
  let depth = 0;
  let pending = false;
  for (let k = from; k < at; k++) {
    const c = src[k]!;
    if (pending && !/\s/.test(c)) {
      stack.push({ block: c === "{", depth: c === "{" ? depth + 1 : depth });
      pending = false;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      while (stack.length > 0 && stack[stack.length - 1]!.depth > depth) stack.pop();
    } else if (c === "," || c === ";") {
      while (stack.length > 0 && !stack[stack.length - 1]!.block && stack[stack.length - 1]!.depth >= depth) stack.pop();
    }
    if (c === "=" && src[k + 1] === ">") { pending = true; k++; }
  }
  return stack.length > 0;
}

/** Every `x.nativeEvent` read in one source, classified. */
export function nativeEventReads(source: string): Read[] {
  const src = withoutCommentsAndLiterals(source);
  const out: Read[] = [];
  for (let at = src.indexOf(".nativeEvent"); at >= 0; at = src.indexOf(".nativeEvent", at + 1)) {
    let j = at - 1;
    while (j >= 0 && /[\w$]/.test(src[j]!)) j--;
    const id = src.slice(j + 1, at);
    if (id === "") { out.push({ at, id: "<expression>", declared: false, deferred: false }); continue; }
    const decl = declaringArrow(src, at, id);
    if (decl < 0) { out.push({ at, id, declared: false, deferred: false }); continue; }
    out.push({ at, id, declared: true, deferred: insideANestedFunction(src, decl, at) });
  }
  return out;
}

describe("the detector, on fixtures, before it is believed about the tree", () => {
  const one = (s: string) => nativeEventReads(s);
  it("REFUSES the shape that killed the app — the read inside a state updater", () => {
    const f = "<V onLayout={(e) => setRoom((r) => nextRoom(r, e.nativeEvent.layout.width))} />";
    expect(one(f).filter((r) => r.deferred)).toHaveLength(1);
  });
  it("REFUSES a read inside a timer and inside a promise", () => {
    expect(one("const h = (e) => { setTimeout(() => use(e.nativeEvent.layout)); };").filter((r) => r.deferred)).toHaveLength(1);
    expect(one("const h = (e) => { p.then(() => { use(e.nativeEvent.layout); }); };").filter((r) => r.deferred)).toHaveLength(1);
  });
  it("ADMITS the capture-first shape the fix uses", () => {
    const f = "<V onLayout={(e) => {\n  const w = e.nativeEvent.layout.width;\n  setRoom((r) => nextRoom(r, w));\n}} />";
    expect(one(f).filter((r) => r.deferred)).toHaveLength(0);
    expect(one(f).filter((r) => r.declared)).toHaveLength(1);
  });
  it("ADMITS a plain synchronous read and a curried handler", () => {
    expect(one("<V onLayout={(e) => standing(foot + e.nativeEvent.layout.height)} />").filter((r) => r.deferred)).toHaveLength(0);
    expect(one("const r = (id) => (e) => { w[id] = e.nativeEvent.layout.width; };").filter((r) => r.deferred)).toHaveLength(0);
  });
  it("ADMITS a nested function that CLOSED before the read — the false positive the depth rule avoids", () => {
    expect(one("const h = (e) => { const f = () => 1; use(e.nativeEvent.layout); };").filter((r) => r.deferred)).toHaveLength(0);
    expect(one("const h = (e) => { xs.map((x) => x + 1); use(e.nativeEvent.layout); };").filter((r) => r.deferred)).toHaveLength(0);
  });
  it("reads prose as prose — a commented defect is not a finding, and a real one beside it is", () => {
    const f = "// onLayout={(e) => setRoom((r) => nextRoom(r, e.nativeEvent.layout.width))}\nconst h = (e) => use(e.nativeEvent.layout);";
    const rs = one(f);
    expect(rs.filter((r) => r.deferred)).toHaveLength(0);
    expect(rs).toHaveLength(1);
  });
});

describe("apps/mobile reads every synthetic event in the handler that received it", () => {
  const sources = ROOTS.flatMap((r) => files(r)).map((p) => ({ p, s: readFileSync(p, "utf8") }));
  const all = sources.flatMap(({ p, s }) => nativeEventReads(s).map((r) => ({ ...r, p, s })));

  it("the census read the tree — a zero finding is a reading, not an empty walk", () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(all.length).toBeGreaterThanOrEqual(20);
  });

  it("every read is classified — an unclassified one is named, never skipped", () => {
    const unknown = all.filter((r) => !r.declared).map((r) => r.p + ":" + String(lineOf(r.s, r.at)));
    expect(unknown, "reads whose handler parameter this census could not find").toEqual([]);
  });

  it("no read is deferred past the handler that received the event", () => {
    const bad = all.filter((r) => r.deferred).map((r) => r.p + ":" + String(lineOf(r.s, r.at)) + " (" + r.id + ")");
    expect(bad, "a pooled event read after its handler returned — RN nulls nativeEvent there").toEqual([]);
  });
});
