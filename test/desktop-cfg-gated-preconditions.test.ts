import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A GATED ASSERTION IS HONEST. A GATED PRECONDITION IS A CASE THAT PASSES FOR THE WRONG REASON.
 * `seal()` in `host_tests.rs` was entirely `#[cfg(unix)]`: on Windows it did nothing, the two
 * cases pinning the failed-write sentence failed on their own precondition, and the rc1 Windows
 * job packaged no installer. Ten more blocks of that shape sit in the crate and nothing told the
 * kinds apart. So a `#[cfg(<one platform>)]` block that DOES WORK and has no twin in the same
 * item is named; one that only asserts is admitted. The pin may only fall.
 */
const DIR = "apps/desktop/src-tauri/src";
const GATE = /^(\s*)#\[cfg\((unix|windows|not\(unix\)|not\(windows\)|target_os\s*=\s*"[a-z]+")\)\]\s*$/;
const WORK = /\b(set_permissions|write_[a-z_]*|fs::write|remove_[a-z_]*|create_[a-z_]*|rename|copy|set_mode|set_readonly)\s*\(/;

export interface Site { fn: string; line: number; gate: string; kind: "WORK" | "ASSERT-ONLY"; twin: boolean }

/** The block form only: `#[cfg(x)]` immediately over a `{ … }`, which is where a precondition hides. */
export function scan(src: string): Site[] {
  const L = src.split("\n");
  const out: Site[] = [];
  let fnName = "", fnStart = 0;
  for (let i = 0; i < L.length; i++) {
    const f = /^\s*(?:pub\s+)?fn\s+([a-z0-9_]+)/.exec(L[i]);
    if (f) { fnName = f[1]; fnStart = i; }
    const m = GATE.exec(L[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < L.length && /^\s*(\/\/|$)/.test(L[j])) j++;
    if (!/^\s*\{\s*$/.test(L[j] ?? "")) continue;
    let d = 0, k = j; const body: string[] = [];
    do { for (const c of L[k]) { if (c === "{") d++; else if (c === "}") d--; } body.push(L[k]); k++; } while (d > 0 && k < L.length);
    let e = fnStart, dd = 0, seen = false;
    while (e < L.length) { for (const c of L[e]) { if (c === "{") { dd++; seen = true; } else if (c === "}") dd--; } if (seen && dd <= 0) break; e++; }
    const item = L.slice(fnStart, Math.min(e + 1, L.length)).join("\n");
    const gates = [...item.matchAll(/#\[cfg\(([^\]]+)\)\]/g)].map((x) => x[1]);
    const twin = gates.some((g) => g !== m[2] && g !== "test");
    const work = body.some((l) => WORK.test(l) && !/assert/.test(l));
    out.push({ fn: fnName, line: i + 1, gate: m[2], kind: work ? "WORK" : "ASSERT-ONLY", twin });
  }
  return out;
}

const files = readdirSync(DIR).filter((f) => f.endsWith("_tests.rs"));
const untwinnedWork = files.flatMap((f) =>
  scan(readFileSync(`${DIR}/${f}`, "utf8")).filter((s) => s.kind === "WORK" && !s.twin).map((s) => `${f}::${s.fn}`),
).sort();

/** Measured 2026-09-16 at that change. A ratchet: a new one refuses, a fixed one lowers the pin. */
const PINNED = [
  "config_tests.rs::the_host_setting_round_trips_and_everything_broken_reads_as_disabled",
  "engine_tests.rs::a_key_file_left_readable_by_others_is_tightened_when_it_is_rewritten",
];

describe("desktop test files: a platform-gated block that does work has a twin", () => {
  it("no new untwinned precondition, and the pin may only fall", () => {
    expect(untwinnedWork.filter((s) => !PINNED.includes(s))).toEqual([]);
    expect(untwinnedWork.length).toBeLessThanOrEqual(PINNED.length);
  });

  it("the shape it was written for: the pre-fix seal() is named, the fixed one is not", () => {
    const before = `fn seal(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(dir).expect("stat").permissions();
        perms.set_mode(0o500);
        std::fs::set_permissions(dir, perms).expect("chmod");
    }
}`;
    const after = `${before.slice(0, -1)}
    #[cfg(windows)]
    {
        let mut perms = std::fs::metadata(&path).expect("the setting").permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&path, perms).expect("set readonly");
    }
}`;
    expect(scan(before).map((s) => [s.kind, s.twin])).toEqual([["WORK", false]]);
    expect(scan(after).every((s) => s.twin)).toBe(true);
  });

  it("a gated ASSERTION is not a finding — the distinction is the whole census", () => {
    const assertOnly = `fn a_case() {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&p).expect("stat").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}`;
    expect(scan(assertOnly).map((s) => s.kind)).toEqual(["ASSERT-ONLY"]);
  });

  it("the crate still carries the blocks this reads, so a green is not an empty scan", () => {
    const all = files.flatMap((f) => scan(readFileSync(`${DIR}/${f}`, "utf8")));
    expect(all.length).toBeGreaterThanOrEqual(8);
    expect(all.some((s) => s.twin)).toBe(true);
  });
});
