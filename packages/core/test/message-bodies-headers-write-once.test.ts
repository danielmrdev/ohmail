import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bracketSpan, lineOf, withoutComments, withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";

/**
 * `message_bodies.headers` IS WRITTEN ONCE, BY THE INGEST INSERT (mail 0141's premise). The
 * Screener auto-apply pass marks a held row whose strong-bulk floor read null and never reads it
 * again; the floor is a function of five header values, so a later header rewrite would leave a
 * row skipped that now qualifies. The server-side writers are censused here: every
 * `update(messageBodies).set({…})` carries no `headers` key, every `insert(messageBodies)` ends in
 * `onConflictDoNothing` (never `onConflictDoUpdate`), and no raw `update message_bodies` names it.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const ROOTS = ["packages/core/src", "packages/services/src", "packages/db/src", "apps/worker/src", "apps/server/src"];

interface Finding { at: string; why: string }

function files(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, into);
    else if (extname(name) === ".ts") into.push(p);
  }
  return into;
}

/** The statement a builder chain belongs to: from `at` to the first `;` at bracket depth 0. */
function statementEnd(walk: string, at: number): number {
  let depth = 0;
  for (let j = at; j < walk.length; j++) {
    const c = walk[j];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") { if (depth === 0) return j; depth--; }
    else if (c === ";" && depth === 0) return j;
  }
  return walk.length;
}

/** Every finding in one source text. `name` labels it; the reading is pure so a fixture drives it. */
export function headerWrites(name: string, src: string): { findings: Finding[]; writers: number } {
  const code = withoutComments(src) as string;
  const walk = withoutCommentsAndLiterals(src) as string;
  const findings: Finding[] = [];
  let writers = 0;
  for (const m of walk.matchAll(/\.update\(\s*messageBodies\s*\)/g)) {
    writers++;
    const end = statementEnd(walk, m.index! + m[0].length);
    const set = walk.indexOf(".set(", m.index!);
    if (set < 0 || set > end) { findings.push({ at: `${name}:${lineOf(src, m.index!)}`, why: "an update with no .set( read" }); continue; }
    const body = bracketSpan(walk, set + 4);
    if (!body.closed) { findings.push({ at: `${name}:${lineOf(src, set)}`, why: "a .set( that never closes" }); continue; }
    const keys = code.slice(body.start, body.end);
    if (/(^|[{,\s])headers\s*(:|,|\})/.test(keys)) {
      findings.push({ at: `${name}:${lineOf(src, set)}`, why: "an update sets message_bodies.headers" });
    }
  }
  for (const m of walk.matchAll(/\.insert\(\s*messageBodies\s*\)/g)) {
    writers++;
    const chain = walk.slice(m.index!, statementEnd(walk, m.index! + m[0].length));
    if (/\.onConflictDoUpdate\(/.test(chain) || !/\.onConflictDoNothing\(/.test(chain)) {
      findings.push({ at: `${name}:${lineOf(src, m.index!)}`, why: "an insert of message_bodies that is not do-nothing on conflict" });
    }
  }
  for (const m of code.matchAll(/update\s+("?message_bodies"?|\$\{messageBodies\})\s+set\b[^;`]*?\bheaders\b/gi)) {
    writers++;
    findings.push({ at: `${name}:${lineOf(src, m.index!)}`, why: "raw SQL sets message_bodies.headers" });
  }
  return { findings, writers };
}

describe("message_bodies.headers is written once", () => {
  it("no server-side writer rewrites a stored header map", () => {
    const all: Finding[] = [];
    let writers = 0;
    for (const root of ROOTS) {
      for (const p of files(join(REPO, root))) {
        const r = headerWrites(relative(REPO, p), readFileSync(p, "utf8"));
        all.push(...r.findings);
        writers += r.writers;
      }
    }
    // The census read something: the ingest insert and the seven body updates are its subjects.
    expect(writers, "the census found no message_bodies writer at all").toBeGreaterThanOrEqual(8);
    console.info(`message_bodies writers read: ${writers}; header rewrites: ${all.length}`);
    expect(all).toEqual([]);
  });

  it("refuses each shape it exists for, beside the ordinary writer it admits", () => {
    const update = `await tx.update(messageBodies).set({ text: "", headers: {} }).where(x);`;
    const shorthand = `await tx.update(messageBodies).set({ headers, text }).where(x);`;
    const upsert = `await db.insert(messageBodies).values({ messageId, headers }).onConflictDoUpdate({ target: t, set: { headers } });`;
    const bare = `await db.insert(messageBodies).values({ messageId, headers });`;
    const raw = "await tx.execute(sql`update message_bodies set headers = ${h} where message_id = ${id}`);";
    for (const src of [update, shorthand, upsert, bare, raw]) {
      expect(headerWrites("fixture.ts", src).findings, src).toHaveLength(1);
    }
    const ordinary = `await tx.update(messageBodies).set({ text: "", html: null }).where(x);
      // a comment naming headers: {} creates nothing
      await db.insert(messageBodies).values({ messageId, headers }).onConflictDoNothing({ target: t });`;
    const r = headerWrites("fixture.ts", ordinary);
    expect(r.writers).toBe(2);
    expect(r.findings).toEqual([]);
  });
});
