import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * ═══ THE `/mail` ENTRY'S MODULE GRAPH MUST NOT ACQUIRE `nodemailer` ═════════════════════════
 *
 * The desktop engine bundles `@trafficflow/services/mail` (`src/mail.ts`) — that entry point
 * exists precisely so the engine never loads the auth ceremony, billing, or transactional mail.
 * `SmtpMailer` is the one module in this package that imports `nodemailer`, and it is exported
 * from the FULL barrel only. Two ways that boundary erodes, each pinned here and each shown red
 * by its own mutation:
 *
 *  1. **Someone exports it from `src/mail.ts`** (or anything that entry reaches). Pinned by
 *     walking the `/mail` import graph and asserting no file in it names `nodemailer` — and,
 *     one ring further out, that the graph contains neither `mail/smtp-mailer.ts` nor
 *     `mail/index.ts` at all. Mutation: `export { SmtpMailer } from "./mail/smtp-mailer.js"` in
 *     `src/mail.ts` ⇒ red.
 *  2. **Someone exports it from `./mail/index.ts`**, beside `ResendMailer`, where it looks like
 *     it belongs. That barrel is not in the `/mail` graph TODAY, so the walk alone would stay
 *     green — which is why the importer census exists: the ONLY file in `src/` allowed to import
 *     `./smtp-mailer.js` is the full barrel, and the only file allowed to import `nodemailer` is
 *     `smtp-mailer.ts` itself. Mutation: re-export from `./mail/index.ts` ⇒ red.
 *
 * The walk reads SOURCE, resolving the compiled `.js` specifiers back to `.ts` — the same 1:1
 * layout `tsc` emits into `dist/`, which is what the engine bundler actually consumes, so a src
 * fact here is a dist fact there.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** Every `.ts` under src/, recursively (the worker's deps test proved flat reads go stale). */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * Import/re-export specifiers that create RUNTIME edges. `import type` / `export type`
 * statements are erased by the compiler and excluded; a mixed `import { type X, y }` keeps its
 * edge and is counted.
 */
function runtimeSpecifiers(body: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/g;
  for (const m of body.matchAll(re)) {
    if (m[2]) continue; // `import type` / `export type` — no runtime edge
    out.push(m[3]!);
  }
  // Side-effect imports: `import "./x.js"`.
  for (const m of body.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) out.push(m[1]!);
  return out;
}

/** BFS over relative imports from an entry file. Returns src-relative files + bare specifiers. */
function moduleGraph(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    const rel = file.slice(SRC.length + 1);
    if (files.has(rel)) continue;
    files.add(rel);
    for (const spec of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) { bare.add(spec); continue; }
      queue.push(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  }
  return { files, bare };
}

describe("the /mail entry's module graph (what the desktop engine bundles)", () => {
  const graph = moduleGraph(join(SRC, "mail.ts"));

  it("sanity: the walk actually walked — the graph is a real slice of the package", () => {
    expect(graph.files.size).toBeGreaterThan(20);
    expect(graph.files).toContain("mail.ts");
    expect(graph.files).toContain("sync-service.ts");
  });

  it("names NO nodemailer — the engine's transactional-mail boundary, as an import-graph fact", () => {
    expect([...graph.bare].filter((s) => s === "nodemailer" || s.startsWith("nodemailer/"))).toEqual([]);
  });

  it("contains neither the SMTP mailer nor the transactional-mail barrel", () => {
    expect(graph.files.has("mail/smtp-mailer.ts")).toBe(false);
    // Not merely "no nodemailer": the whole transactional barrel stays out, so the census does
    // not have to re-argue this the day that barrel gains another transport.
    expect(graph.files.has("mail/index.ts")).toBe(false);
    expect(graph.files.has("mail/resend-mailer.ts")).toBe(false);
  });
});

describe("the importer census (the ring the graph walk cannot see)", () => {
  const all = tsFiles(SRC).map((f) => ({ rel: f.slice(SRC.length + 1), body: readFileSync(f, "utf8") }));

  it("the ONLY importer of smtp-mailer.js in src/ is the full barrel", () => {
    const importers = all
      .filter(({ body }) => runtimeSpecifiers(body).some((s) => s.includes("smtp-mailer")))
      .map(({ rel }) => rel);
    expect(importers).toEqual(["index.ts"]);
  });

  it("the ONLY file in src/ that imports nodemailer is smtp-mailer.ts itself", () => {
    const importers = all
      .filter(({ body }) => runtimeSpecifiers(body).some((s) => s === "nodemailer" || s.startsWith("nodemailer/")))
      .map(({ rel }) => rel)
      .sort();
    expect(importers).toEqual(["mail/smtp-mailer.ts"]);
  });
});
