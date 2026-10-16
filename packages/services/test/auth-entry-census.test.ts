import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * ═══ THE `/auth` ENTRY'S MODULE GRAPH — no barrel, no nodemailer, no stripe, no Cloud half ═══
 *
 * `src/auth.ts` exists so `routes/pair.ts` and the desktop-host modules can reach the session
 * lifecycle and the pairing lifecycle WITHOUT the full barrel (Phase 3 — the barrel-creep
 * obligation), and so the sidecar's service bag can hold the lifecycle in the SHIPPED engine
 * bundle. Each clause of that promise is an import-graph fact, pinned here with the mutation
 * that turns it red:
 *
 *  1. **The barrel stays out** — `src/index.ts` is the one module in this package with an
 *     import-time side effect (the paid-gate registration), so the entry reaching it would make
 *     importing `/auth` silently arm hosted billing defaults. Mutation:
 *     `export * from "./index.js"` in `src/auth.ts` ⇒ red.
 *  2. **No nodemailer, no transactional-mail barrel** — the same boundary
 *     `mail-entry-census.test.ts` pins for `/mail`, owed here separately because this is a
 *     second entry the engine bundles from. Mutation: import `./mail/smtp-mailer.js` ⇒ red.
 *  3. **No stripe-adjacent module** — nothing under `entitlements/`, no `mailbox-allowance.ts`
 *     (the paid gate's implementation reaches billing and the credit ledger through the db).
 *     Mutation: `export { assertMayAddMailbox } from "./mailbox-allowance.js"` ⇒ red.
 *  4. **No Cloud half** — no `@trafficflow/db/cloud`, no `context-cloud.ts`, no `invites.ts`,
 *     no `pairing-invite.ts`, and NOT `auth-service.ts` (the ceremony names the Cloud schema).
 *     This is the load-bearing clause: the sidecar imports this entry, so this graph ships in
 *     the public engine artifact, whose build census refuses any cloud-half input outright —
 *     this test is the failure arriving in the suite instead of at a build somebody has to run.
 *     Mutation: `export { AuthService } from "./auth/index.js"` ⇒ red (auth/index reaches the
 *     ceremony).
 *
 * The walk reads SOURCE, resolving compiled `.js` specifiers back to `.ts` — the same 1:1
 * layout `tsc` emits into `dist/`, which is what the engine bundler consumes, so a src fact
 * here is a dist fact there. `import type` edges are erased by the compiler and excluded.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** Import/re-export specifiers that create RUNTIME edges (mail-entry-census's own walker). */
function runtimeSpecifiers(body: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/g;
  for (const m of body.matchAll(re)) {
    if (m[2]) continue; // `import type` / `export type` — no runtime edge
    out.push(m[3]!);
  }
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

describe("the /auth entry's module graph (what pair.ts and the sidecar's bag pull)", () => {
  const graph = moduleGraph(join(SRC, "auth.ts"));

  it("sanity: the walk actually walked — the lifecycle and the pairing module are in it", () => {
    expect(graph.files).toContain("auth.ts");
    expect(graph.files).toContain("auth/session-lifecycle.ts");
    expect(graph.files).toContain("pairing.ts");
    expect(graph.files.size).toBeGreaterThan(5);
  });

  it("the BARREL stays out — importing /auth must never run the paid-gate registration", () => {
    expect(graph.files.has("index.ts")).toBe(false);
    // …and the registration's two halves stay out independently, so the side effect cannot be
    // re-created inside the graph either: the gate's implementation and the registry's setter.
    expect(graph.files.has("mailbox-allowance.ts")).toBe(false);
  });

  it("names NO nodemailer and carries none of the transactional-mail transports", () => {
    expect([...graph.bare].filter((s) => s === "nodemailer" || s.startsWith("nodemailer/"))).toEqual([]);
    expect(graph.files.has("mail/smtp-mailer.ts")).toBe(false);
    expect(graph.files.has("mail/index.ts")).toBe(false);
    expect(graph.files.has("mail/resend-mailer.ts")).toBe(false);
  });

  it("nothing stripe-adjacent: no entitlements module enters the graph, and no bare 'stripe'", () => {
    expect([...graph.files].filter((f) => f.startsWith("entitlements/"))).toEqual([]);
    expect([...graph.bare].filter((s) => s === "stripe" || s.startsWith("stripe/"))).toEqual([]);
  });

  it("the CLOUD HALF stays out — the clause the engine artifact's census enforces downstream", () => {
    // The db package's cloud entries. `@trafficflow/db` (the root) is the mail half and is fine.
    expect([...graph.bare].filter((s) =>
      s === "@trafficflow/db/cloud" || s === "@trafficflow/db/admin" || s === "@trafficflow/db/journal",
    )).toEqual([]);
    // The service layer's own cloud-half seams and the two invite-bridging modules.
    expect(graph.files.has("context-cloud.ts")).toBe(false);
    expect(graph.files.has("invites.ts")).toBe(false);
    expect(graph.files.has("pairing-invite.ts")).toBe(false);
    // The ceremony itself: its module imports the Cloud schema, so it may never ride this entry
    // — not even through the auth sub-barrel.
    expect(graph.files.has("auth/auth-service.ts")).toBe(false);
    expect(graph.files.has("auth/index.ts")).toBe(false);
  });

  it("positive control: the walker sees a runtime re-export (so 'absent' above means absent)", () => {
    // A rule that has never been seen to reject anything is a rule nobody knows the state of.
    expect(runtimeSpecifiers('export * from "./index.js";')).toEqual(["./index.js"]);
    expect(runtimeSpecifiers('export { SmtpMailer } from "./mail/smtp-mailer.js";'))
      .toEqual(["./mail/smtp-mailer.js"]);
    // …and erases what the compiler erases, so a type-only edge cannot false-positive.
    expect(runtimeSpecifiers('export type { CloudDb } from "./context-cloud.js";')).toEqual([]);
  });
});
