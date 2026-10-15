import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * ═══ CONSENT STAMPS THE SCREENING BASELINE, AND ONE FUNCTION WRITES IT ════════════════════
 *
 * `screening_baseline_at` is the instant a window is measured back from. NULL is not "no answer",
 * it is the answer "no cutoff": the cutline becomes `now() - dormancy_days` and slides forward for
 * ever, so every unruled sender's whole history is held at the gate. A door that records a consent
 * and leaves the column NULL therefore ships a mailbox that reorganises itself against an answer
 * nobody gave — measured on managed accounts, each consented through a door that
 * asked no window.
 *
 * Two claims, both parsed rather than grepped, because a symbol APPEARING is not a call and a
 * SELECT projection is not a write:
 *
 *  1. EVERY DOOR GOES THROUGH A STAMPER. A function that writes `organize_consented_at` to
 *     anything but `null` also calls one of the named baseline writers. `null` is excluded by
 *     construction: that is a consent-LESS reader being created, the opposite of a consent.
 *  2. THE WRITERS ARE PINNED. The complete set of `(file, function)` pairs that write
 *     `screening_baseline_at` is the list below. A new writer anywhere — a second door, a fixture
 *     path, an ops helper — is red until somebody adds it here, which is the point: the column has
 *     exactly as many writers as the argument above has been made for.
 *
 * WHAT THIS DOES NOT CHECK, stated so nobody reads it as covered: whether the stamp is
 * UNCONDITIONAL inside the door. Routing is structural and belongs here; conditionality is
 * behaviour and is measured by `apps/sidecar/test/local-consent-baseline.test.ts`, which watches a
 * restored `if (input.screening)` go red.
 *
 * SCANNED ROOTS, not touched packages: this reads `packages/&ast;/src` and `apps/&ast;/src`, so
 * selection by changed package never reaches it — run it by name.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The complete set of writers of `account_settings.screening_baseline_at`. */
const BASELINE_WRITERS: ReadonlyArray<readonly [string, string]> = [
  // The hosted door: the unconditional stamp, and the answer's own upsert beside it. Two, and the
  // separation is load-bearing — the `already_organizing` branch may write dials and must not
  // stamp, so the stamp cannot live inside the answer.
  ["packages/services/src/mailbox-service.ts", "stampScreeningBaseline"],
  ["packages/services/src/mailbox-service.ts", "writeScreeningAnswer"],
  // The standalone door: one writer for both of its arms and for the re-run.
  ["apps/sidecar/src/organize-here.ts", "writeConsentScreening"],
  // The first decide establishes a baseline for an account that reached the queue another way.
  ["packages/db/src/screener-apply.ts", "applyScreenerDecision"],
  // "Start over" puts it back to NULL, which is the one legitimate way to unset it.
  ["packages/services/src/consent-reset.ts", "resetScreeningState"],
  // A consent over an account with NO settings record, which asked no window: the baseline alone,
  // no dials, because the person answered no second question. Its `coalesce` keeps a racing
  // consent to one baseline, like every other writer here.
  ["packages/services/src/mailbox-service.ts", "writeConsentBaseline"],
];

const STAMPER_NAMES = new Set(BASELINE_WRITERS.map(([, fn]) => fn));

function sourceFiles(): string[] {
  const roots: string[] = [];
  for (const group of ["packages", "apps"]) {
    const dir = path.join(REPO, group);
    for (const pkg of readdirSync(dir)) {
      const src = path.join(dir, pkg, "src");
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch { /* a package with no `src` is not a scanned root */ }
    }
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  for (const r of roots) walk(r);
  return out;
}

/** The nearest enclosing NAMED function or method — the door, never the transaction callback. */
function enclosingName(node: ts.Node): string | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) {
      return n.name && ts.isIdentifier(n.name) ? n.name.text : null;
    }
  }
  return null;
}

/**
 * Is this property assignment a WRITE? Only inside the object a drizzle write door is handed:
 * `.set({…})`, `.values({…})`, or the `set:` of an `onConflictDoUpdate({…})`. Everything else
 * carrying the same key is a SELECT projection or a DTO mapping, and a census that counted those
 * would be measuring reads.
 */
function isWriteSite(prop: ts.PropertyAssignment): boolean {
  const obj = prop.parent;
  if (!ts.isObjectLiteralExpression(obj)) return false;
  const owner = obj.parent;
  if (ts.isCallExpression(owner) && owner.arguments.includes(obj)) {
    const callee = owner.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      return callee.name.text === "set" || callee.name.text === "values";
    }
    return false;
  }
  // `onConflictDoUpdate({ target, set: { … } })` — the object is the value of a `set:` property.
  if (ts.isPropertyAssignment(owner) && ts.isIdentifier(owner.name) && owner.name.text === "set") {
    return true;
  }
  return false;
}

/** Every `CallExpression` callee name inside a node — `f()` and `this.f()` both. */
function callNames(root: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      if (ts.isIdentifier(c)) out.add(c.text);
      else if (ts.isPropertyAccessExpression(c)) out.add(c.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

interface Site { file: string; fn: string | null; nullish: boolean; calls: Set<string> }

function scan(key: string): Site[] {
  const found: Site[] = [];
  for (const file of sourceFiles()) {
    const text = readFileSync(file, "utf8");
    // A cheap pre-filter on the IDENTIFIER, so thousands of files are not parsed to find four. A file
    // that does not contain the word cannot contain a write of it.
    if (!text.includes(key)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === key
          && isWriteSite(n)) {
        const fn = enclosingName(n);
        let owner: ts.Node | undefined = n.parent;
        for (; owner; owner = owner.parent) {
          if (ts.isFunctionDeclaration(owner) || ts.isMethodDeclaration(owner)) break;
        }
        found.push({
          file: path.relative(REPO, file),
          fn,
          nullish: n.initializer.kind === ts.SyntaxKind.NullKeyword,
          calls: owner ? callNames(owner) : new Set<string>(),
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return found;
}

describe("consent stamps the screening baseline", () => {
  it("finds the consent doors at all — the scan is not looking at an empty tree", () => {
    const consents = scan("organizeConsentedAt").filter((s) => !s.nullish);
    expect(consents.length).toBeGreaterThanOrEqual(3);
    expect(new Set(consents.map((s) => s.file))).toEqual(new Set([
      "packages/services/src/mailbox-service.ts",
      "apps/sidecar/src/organize-here.ts",
    ]));
  });

  it("EVERY DOOR THAT RECORDS A CONSENT ALSO STAMPS THE BASELINE", () => {
    const unstamped = scan("organizeConsentedAt")
      .filter((s) => !s.nullish)
      .filter((s) => ![...s.calls].some((c) => STAMPER_NAMES.has(c)))
      .map((s) => `${s.file}#${s.fn ?? "<anonymous>"}`);
    expect(unstamped, "consent written with no baseline stamp in the same function").toEqual([]);
  });

  it("a consent-LESS reader is not a door — `organizeConsentedAt: null` is excluded", () => {
    // The positive control for the exclusion: `create`/`connectOAuth` write the column to null and
    // must not be asked for a stamp. Without this the previous case would be satisfiable by
    // stamping a baseline for an account that has consented to nothing.
    const nulls = scan("organizeConsentedAt").filter((s) => s.nullish);
    expect(nulls.length).toBeGreaterThanOrEqual(2);
    expect(nulls.every((s) => s.file === "packages/services/src/mailbox-service.ts")).toBe(true);
  });

  it("THE BASELINE HAS EXACTLY THE WRITERS THIS FILE NAMES", () => {
    const seen = scan("screeningBaselineAt")
      .map((s) => `${s.file}#${s.fn ?? "<anonymous>"}`)
      .sort();
    const want = BASELINE_WRITERS.map(([f, fn]) => `${f}#${fn}`).sort();
    expect([...new Set(seen)], "a writer of screening_baseline_at this census has not been told about")
      .toEqual([...new Set(want)]);
  });
});
