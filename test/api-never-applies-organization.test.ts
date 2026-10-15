import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import * as scan from "../scripts/lib/source-scan.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_SRC = join(ROOT, "packages/api/src");

/**
 * ═══ THE API NEVER OPENS IMAP TO APPLY ORGANIZATION ═══════════════════════════════════════════
 *
 * The project's design notes the "Organize-in-place" invariant: organization lands in real IMAP folders, and the API never
 * opens IMAP to APPLY it — moves defer to the worker through desired state, so a serverless
 * function can never leave a mailbox half-moved. Two exceptions are named in that sentence and
 * nowhere else: the on-demand attachment fetch and the gated send, both of which open a
 * short-lived connection and store no bytes. Both are READS of somebody's own mail, or a write to
 * somebody else's server; neither MUTATES the user's mailbox.
 *
 * The rule was kept by review until it was not: `junk-window.ts`'s rescue applied its Junk→INBOX
 * move inside the API for four releases, and the thing that finally caught it was a person reading
 * the file. This is that reading, executable: the MUTATION VERBS of the mail adapter may not be
 * called under `packages/api/src` at all.
 *
 * PARSED, NOT GREPPED. `scripts/lib/source-scan.mjs` blanks comments, strings, templates and regex
 * literals in ONE left-to-right pass with positions preserved, so a verb named in prose or inside a
 * `sql` template is not a finding and `file:line` stays true. A comment-stripping pair of regexes
 * cannot do this — it reads a block opener quoted inside a line comment as real.
 *
 * THE POSITIVE CONTROL is the shipped defect itself, as a fixture: the exact call the route carried
 * (`await adapter.move({ folder: box.junkFolder!, ref }, "INBOX")`) is fed to the same finder and
 * must be found. Without it this file passes for a scanner that finds nothing.
 */

/**
 * The adapter verbs that CHANGE the user's mailbox. Reads are absent deliberately — `listFolderPage`,
 * `searchFolderPage` and `fetchByUid` are the junk and trash windows, and the exceptions above.
 */
const MUTATION_VERBS = [
  "move", "moveMany", "moveAll", "setFlags", "expunge",
  "createFolder", "renameFolder", "deleteFolder",
] as const;

/** Every `.ts` under a root, recursively. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * Calls of a mutation verb on SOMETHING, with the receiver captured. A bare `move(` is not a
 * finding — `message(deps).move(...)` is the SERVICE's own door, which records desired state and
 * is the whole point — so the receiver decides, and the receiver that matters is an adapter.
 */
function mutationCalls(src: string): Array<{ line: number; receiver: string; verb: string }> {
  const code = scan.withoutCommentsAndLiterals(src);
  const out: Array<{ line: number; receiver: string; verb: string }> = [];
  const re = new RegExp(String.raw`([A-Za-z_$][\w$]*)\s*\.\s*(${MUTATION_VERBS.join("|")})\s*\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    out.push({ line: scan.lineOf(code, m.index), receiver: m[1]!, verb: m[2]! });
  }
  return out;
}

/**
 * Receivers that are NOT a mail adapter. Each is named, because a blanket "ignore unknown
 * receivers" would let the next `adapter.move` in under a new variable name.
 *
 *  · `message`/`folders` — the services' own doors, which write desired state;
 *  · `Array`-shaped receivers (`rows`, `items`, …) have no mutation verb in this list;
 *  · `fs`/`path` do not exist here.
 *
 * A receiver spelt anything else is a finding by construction, which is the intended cost.
 */
const NOT_AN_ADAPTER = new Set(["message", "folderOps", "folders", "svc"]);

describe("the API applies no organization", () => {
  it("reads a real tree: the scan is over the API's own sources", () => {
    // The census half. A finder over an empty file list satisfies every assertion below.
    const files = sources(API_SRC);
    expect(files.length, "packages/api/src has sources").toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith("junk-window.ts"))).toBe(true);
  });

  it("no adapter mutation verb is called anywhere under packages/api/src", () => {
    const findings: string[] = [];
    for (const file of sources(API_SRC)) {
      for (const c of mutationCalls(readFileSync(file, "utf8"))) {
        if (NOT_AN_ADAPTER.has(c.receiver)) continue;
        findings.push(`${relative(ROOT, file)}:${c.line} — ${c.receiver}.${c.verb}(`);
      }
    }
    expect(findings, "the API opens IMAP to apply organization here:\n" + findings.join("\n"))
      .toEqual([]);
  });

  it("THE POSITIVE CONTROL — the shipped defect's own call is found by this finder", () => {
    // Verbatim from `packages/api/src/junk-window.ts` as it stood before 0.19.2, with the comment
    // above it, so the comment-blanking half is exercised by the same fixture.
    const shipped = [
      "// The move itself. Epoch-guarded, so a recreated folder's reused UID can never send a",
      "// STRANGER to the inbox under a stale press — adapter.move is named here in PROSE.",
      'const note = "adapter.expunge( in a string is not a call";',
      'await adapter.move({ folder: box.junkFolder!, ref }, "INBOX");',
    ].join("\n");
    const found = mutationCalls(shipped).filter((c) => !NOT_AN_ADAPTER.has(c.receiver));
    expect(found).toEqual([{ line: 4, receiver: "adapter", verb: "move" }]);
  });

  it("…and the service door it must NOT confuse with one is admitted", () => {
    // `packages/api/src/routes/messages.ts`'s real shape: the SERVICE's move, which records
    // desired state and opens nothing. A census that flagged this would be unlandable, which is
    // how a rule this strict stops being enforced at all.
    const door = 'const result = await message(deps).move(serviceContext(deps, req), params.id!, body, {});';
    const found = mutationCalls(door).filter((c) => !NOT_AN_ADAPTER.has(c.receiver));
    expect(found).toEqual([]);
  });
});
