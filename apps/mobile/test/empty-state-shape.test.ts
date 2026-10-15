/**
 * An empty state is its sentence — title and hint, no glyph. The approved design's empty states
 * (the foldable prototype's `.empty`) carry no picture, and the emoji this app once put above the
 * title rendered as a boxed "?" on an iOS runtime without the emoji font (the iPad, 2026-09-21).
 * Two readings: `Empty` takes no `glyph`, and no screen passes one; and no emoji pictograph is
 * left as a literal in a screen or a shared UI file, so the vocabulary cannot creep back one
 * surface at a time.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/* @reads: apps/mobile/src/ui/base.tsx
   Read by a path built at runtime, so no landing pass selects this file when that source
   moves — the shape `reads-list.mjs` exists for. */

const APP = path.resolve(__dirname, "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}
const files = [...walk(path.join(APP, "app")), ...walk(path.join(APP, "src", "ui"))];
const PICTO = /\p{Extended_Pictographic}/u;
/** The typographic marks a control legitimately draws: the rail's ⋯ is punctuation, not a picture. */
const NOT_A_PICTURE = /[⋯…·•–—×✓✗→←↑↓]/u;

describe("empty-state-shape — title and hint, no glyph, no emoji literal", () => {
  it("Empty takes title and hint, and a press — never a glyph", () => {
    const base = fs.readFileSync(path.join(APP, "src/ui/base.tsx"), "utf8");
    /* The one press an empty state may carry (the Screener's "not organizing yet") joined the props; a
       picture did not. The whole signature, props type included, is read for one. */
    const sig = /export function Empty\(([\s\S]*?)\) \{\n/.exec(base)?.[1] ?? "";
    expect(sig).toContain("{ title, hint, action }");
    expect(sig).not.toMatch(/glyph/);
    expect(base).not.toMatch(/Empty\(\{[^}]*glyph/);
  });
  it("no screen passes a glyph to Empty", () => {
    const offenders = files.filter((f) => /<Empty[\s\S]{0,120}?glyph=/.test(fs.readFileSync(f, "utf8")) || /glyph:\s*"[^"]*",\s*title:/.test(fs.readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(APP, f))).toEqual([]);
  });
  it("no emoji pictograph literal survives in the screens or the shared UI", () => {
    const hits: string[] = [];
    for (const f of files) {
      fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        for (const ch of line) if (PICTO.test(ch) && !NOT_A_PICTURE.test(ch)) { hits.push(`${path.relative(APP, f)}:${i + 1} ${ch}`); break; }
      });
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });
  it("the census reads a real tree", () => {
    expect(files.length).toBeGreaterThan(40);
  });
});
