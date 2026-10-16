import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * SETTINGS AND COMPOSE STAY OUT OF THE FIRST-PAINT BUNDLE. The /mailbox first
 * load measured 563 kB with both panes compiled in; they are `React.lazy` now, behind their
 * existing `effectiveView` seams. A byte pin shifts under every unrelated change, so the guard
 * is structural: on the STATIC import graph walked from `AppShell.tsx`, neither view module is
 * reachable — a dynamic `import()` is deliberately not an edge (it IS the seam), and type-only
 * imports are erased. The walker is proved on a subject that HAS the property: the statically
 * mounted `ScreenerView` must be REACHED, or the refusals below pass by blindness.
 * Mutation watch: turn either lazy factory back into a static import and this reds.
 */

const APP = resolve(__dirname, "../app");
const ROOT = resolve(APP, "shell/AppShell.tsx");

/** Static value edges of one module: `import … from`, `import "x"`, `export … from`. */
function staticEdges(file: string): string[] {
  const src = withoutComments(readFileSync(file, "utf8"));
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(import|export)\s+([\s\S]*?)\bfrom\s*["']([^"']+)["']/g)) {
    if (/^type\s/.test(m[2]!.trim())) continue; // `import type` / `export type` — erased
    out.push(m[3]!);
  }
  for (const m of src.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) out.push(m[1]!);
  return out;
}

/** A relative specifier's file under apps/webapp/app, or null for anything the walk does not follow. */
function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null; // packages cannot loop back
  if (/\.(css|json|svg|png)$/.test(spec)) return null;
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ""));
  if (!base.startsWith(APP)) return null;
  for (const c of [`${base}.ts`, `${base}.tsx`, base, `${base}/index.ts`]) {
    if (existsSync(c) && !c.endsWith("/")) {
      // A directory is not a module file; the explicit candidates above cover the real shapes.
      try { if (readFileSync(c, "utf8") !== null) return c; } catch { /* a directory — next */ }
    }
  }
  return null;
}

function reachable(): Set<string> {
  const seen = new Set<string>([ROOT]);
  const queue = [ROOT];
  while (queue.length > 0) {
    const file = queue.pop()!;
    for (const spec of staticEdges(file)) {
      const next = resolveSpec(file, spec);
      if (next !== null && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

describe("the first-paint bundle defers the Settings and Compose panes and the editor", () => {
  const graph = reachable();

  it("walks: the statically mounted ScreenerView is reached (the walker's positive control)", () => {
    expect(graph.has(resolve(APP, "views/ScreenerView.tsx"))).toBe(true);
    // A one-file graph would pass the two refusals below by blindness.
    expect(graph.size).toBeGreaterThan(50);
  });

  it("neither lazy pane is statically reachable from the shell", () => {
    expect(graph.has(resolve(APP, "views/SettingsView.tsx"))).toBe(false);
    expect(graph.has(resolve(APP, "views/ComposeView.tsx"))).toBe(false);
  });

  /* The editor is the third deferral, and the cheap reader of it. `RichEditorLazy.tsx` is the
     one door: five surfaces import the name from there, so the editor's own module — and with
     it TipTap and ProseMirror — is reached by a dynamic import or not at all. The manifest
     reader in `first-load-defers-editor.test.ts` is the one that measures the built chunks. */
  it("the editor is behind its door, not statically reachable from the shell", () => {
    expect(graph.has(resolve(APP, "shell/RichEditorLazy.tsx"))).toBe(true);
    expect(graph.has(resolve(APP, "shell/RichEditor.tsx"))).toBe(false);
    expect(graph.has(resolve(APP, "shell/LinkPopover.tsx"))).toBe(false);
  });
});
