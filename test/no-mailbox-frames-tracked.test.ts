import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * NO FRAME OF A REAL MAILBOX IS EVER TRACKED. The layout cells shoot signed-in panes at the freeze, and
 * a signed frame carries addresses as pixels. Every frame web-sweep.mjs writes has a sidecar
 * `<frame>.cell.json` naming its `mode`; a tracked PNG whose sidecar (or its directory's `cell.json`)
 * says `signed` is refused here, and so is a tracked signed sidecar on its own. The zero over this
 * repository stands beside a planted signed frame in a fixture repository, which must be refused.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function signedSidecar(repo: string, rel: string): string | null {
  for (const side of [rel.replace(/\.png$/i, ".cell.json"), join(dirname(rel), "cell.json")]) {
    const p = join(repo, side);
    if (!existsSync(p)) continue;
    try { if ((JSON.parse(readFileSync(p, "utf8")) as { mode?: string }).mode === "signed") return side; } catch { return `${side} (unreadable — refused, never skipped)`; }
  }
  return null;
}

/** A sidecar's mode; an unreadable one answers "unreadable", which is refused like a signed one. */
function modeOf(p: string): string {
  try { const m = (JSON.parse(readFileSync(p, "utf8")) as { mode?: string }).mode ?? ""; return m === "signed" ? "signed" : "demo"; } catch { return "unreadable"; }
}

/** Every tracked PNG whose sidecar says signed, and every tracked signed sidecar. */
function signedFramesTracked(repo: string): string[] {
  const tracked = execFileSync("git", ["-C", repo, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\0").filter(Boolean);
  const out: string[] = [];
  for (const rel of tracked) {
    if (/\.png$/i.test(rel)) { const s = signedSidecar(repo, rel); if (s) out.push(`${rel} (sidecar ${s})`); }
    else if (/(^|\/)(cell|[^/]+\.cell)\.json$/.test(rel) && modeOf(join(repo, rel)) !== "demo") out.push(rel);
  }
  return out;
}

const W = mkdtempSync(join(tmpdir(), "frames-tracked-"));
afterAll(() => rmSync(W, { recursive: true, force: true }));
function fixture(name: string, mode: string): string {
  const repo = join(W, name);
  mkdirSync(join(repo, "frames/phone-390"), { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-q"]);
  writeFileSync(join(repo, "frames/phone-390/reader.png"), Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(repo, "frames/phone-390/reader.cell.json"), JSON.stringify({ mode, config: "phone-390", screen: "reader" }));
  execFileSync("git", ["-C", repo, "add", "."]);
  return repo;
}

describe("no signed-in frame is tracked", () => {
  it("a planted signed frame in a fixture repository is refused, PNG and sidecar both named", () => {
    const hits = signedFramesTracked(fixture("signed", "signed"));
    expect(hits.sort()).toEqual(["frames/phone-390/reader.cell.json", "frames/phone-390/reader.png (sidecar frames/phone-390/reader.cell.json)"]);
  });
  it("the same frame shot on the demo is admitted — the refusal is about the mode, not the PNG", () => {
    expect(signedFramesTracked(fixture("demo", "demo-local"))).toEqual([]);
  });
  it("this repository tracks no signed frame", () => {
    const pngs = execFileSync("git", ["-C", ROOT, "ls-files", "*.png"], { encoding: "utf8" }).split("\n").filter(Boolean).length;
    expect(pngs, "the census read this repository's PNGs (a zero here is a reading only beside them)").toBeGreaterThan(0);
    expect(signedFramesTracked(ROOT)).toEqual([]);
  });
});
