/** @vitest-environment jsdom */
/**
 * ═══ THE COOKIE-WRITER CENSUS IS THE SERVER'S, NOT A LIST SOMEBODY REMEMBERED ═════════════
 *
 * `api()` takes an origin-wide lock around every request that writes or clears session cookies,
 * so two tabs cannot interleave their writes. WHICH requests those are is a fact about the
 * SERVER, and the client's copy of it was written from memory — wrong in both directions in one
 * pass:
 *
 *  · it wrapped `/auth/step-up/totp` and `/auth/step-up/webauthn/verify`, which write no cookie
 *    at all (`packages/api/src/routes/step-up.ts` says so in as many words). Wrapping a
 *    non-writer is not free — both are refresh-recoverable, so under a lock that then recovered
 *    under itself they hung the step-up prompt outright;
 *  · it MISSED `DELETE /account`, which answers with `clearSessionCookies()` and empties the
 *    whole origin jar. An erase issued under one account whose response lands after another has
 *    signed in clears the new session.
 *
 * A hand-written census is a claim about somebody else's code that nothing checks. This derives
 * it from that code: every route the server declares is read, and the set that writes cookies
 * must equal what the client locks. **A cookie-writing route added on the server without a client
 * entry fails here** — which is the property a comment could never have.
 *
 * ── READ FROM SOURCE, AND WHY ─────────────────────────────────────────────────────────────
 *
 * `@trafficflow/api` is not a dependency of this app and its `exports` map does not expose the
 * route modules, so they cannot be imported here — deliberately: the webapp has no business
 * loading the server. The routes are read as text instead. That is a weaker instrument than a
 * loaded router, and the four cases after the first three are where that weakness is PINNED
 * rather than left implied.
 *
 * ── THE FOUR WAYS A TEXT SCAN CAN BE WRONG, AND WHAT EACH ONE COSTS ───────────────────────
 *
 *  1. **An ALIASED or computed call.** `const set = sessionCookies; set(res)` writes the jar and
 *     matches no `sessionCookies(` anywhere. So no writer may be referenced except by calling
 *     it — asserted over the whole routes tree, imports and comments discounted.
 *  2. **A WRAPPER nobody added to the list.** `webSession` and `enrollmentResult` are on it
 *     because somebody noticed them. The next one would not be, and a route calling it would
 *     read as writing nothing. So the wrapper set is DERIVED from the source and compared with
 *     the list, rather than being the list.
 *  3. **A NESTED route directory.** The scan read one directory and did not descend, so a route
 *     table one level down was invisible — no error, no route, no lock. It descends now, and the
 *     case below drives it over a tree that has one.
 *  4. **A LIST NOTHING CONSULTS.** The sharpest of the four: the three cases above can all be
 *     green while `api()` no longer takes the lock at all, because they compare two lists and
 *     never call the function that is supposed to read one of them. The last case makes a real
 *     request and watches the lock.
 *
 * ── AND THE SCAN IS A PARSER, NOT A REGEX, BECAUSE THE FIRST TWO CANNOT BE DONE WITH ONE ──
 *
 * The first version of cases 1 and 2 blanked comments and imports with regular expressions and
 * then searched for names. Review broke both halves of that in one paragraph, and was right:
 *
 *  · blanking imports made a RENAMING import invisible — `import { sessionCookies as set }`
 *    leaves no tracked spelling anywhere, so the alias check had nothing to find and the call
 *    site `set(res)` matched no writer;
 *  · the comment blanking was not lexical, so a `//` inside a string or a regex literal erased
 *    live source to the end of the line — silently, and in the direction that looks safe;
 *  · and the wrapper derivation recognised only `function` declarations, so
 *    `export const webSession2 = (…) => sessionCookies(…)` was not a wrapper as far as it knew.
 *
 * None of those is fixable by a better regular expression: they are one defect, which is that
 * the scan did not know what a string, a comment, an import or a function IS. So it parses now.
 * `typescript` is already a direct dependency of this app and the routes are ordinary
 * TypeScript.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NEXT_PUBLIC_API_BASE = "/api";

/**
 * The functions that emit `Set-Cookie` for a session, and the shared helpers that call them.
 *
 * The last three are WRAPPERS, and they are not here on anybody's memory: the wrapper case below
 * derives the same set from the source and fails if the two disagree.
 */
const WRITER_NAMES = [
  "sessionCookies",
  "enrollmentCookies",
  "clearSessionCookies",
  "webSession",
  "enrollmentSession",
  "enrollmentResult",
] as const;

/** The three that actually emit the header. Everything else reaches the jar through one of them. */
const BASE_WRITERS = ["sessionCookies", "enrollmentCookies", "clearSessionCookies"] as const;

/**
 * The writers that ESTABLISH a session, as opposed to clearing one. `clearSessionCookies` is the
 * only one of the six that empties the jar; every other one puts a session into it.
 */
const ESTABLISHING_WRITERS = [
  "sessionCookies", "enrollmentCookies", "webSession", "enrollmentSession", "enrollmentResult",
] as const;

/** What the server's clear-only set is today. The client's own `CLEARS_ONLY` is held to it. */
const CLEARS_ONLY_EXPECTED = ["/auth/logout", "/auth/refresh/logout", "/account"] as const;

/** The wrappers, as the derivation should find them — the same list, minus the three above. */
const WRAPPERS = ["webSession", "enrollmentSession", "enrollmentResult"] as const;

/**
 * The modules the server writes session cookies FROM, today — pinned so a writer appearing in a
 * new file fails here and a human maps it, rather than the route scan quietly missing it.
 */
const WRITER_MODULES = [
  "packages/api/src/cookies.ts",
  "packages/api/src/routes/account.ts",
  "packages/api/src/routes/session-lifecycle.ts",
  "packages/api/src/routes/shared-cloud.ts",
] as const;

/**
 * `POST /auth/refresh` writes cookies and is deliberately NOT on the client's list.
 *
 * It never goes through `api()`: `session-refresh.ts` owns its own `fetch`, because it is the
 * function `api()` calls to recover and routing it back through would recurse. It takes the SAME
 * origin-wide lock by its own path (`withCrossTabLock`), so the ordering property holds — it is
 * the mechanism that differs, not the guarantee. Named here so the difference is a decision on
 * the record rather than a gap in the list.
 */
const LOCKED_ELSEWHERE = ["/auth/refresh"] as const;

/**
 * The repo root. `process.cwd()` and not `import.meta.url`, because this file runs under jsdom
 * (case 4 needs a lock manager) and Vite rewrites a module's own url to a `/@fs/` specifier
 * there — `new URL("../../../", import.meta.url).pathname` then names a path that does not
 * exist. Vitest is run from the repo root in this repository.
 */
const REPO = `${process.cwd().replace(/\/$/, "")}/`;
const ROUTES_DIR = `${REPO}packages/api/src/routes`;

interface RouteFile { path: string; src: string }

/**
 * Every `.ts` under a route tree, INCLUDING nested directories.
 *
 * The recursion is the whole of case 3. `readdirSync` without it returned the top level only, so
 * a route table one directory down declared cookie-writing routes that this file reported as
 * absent — a green that said the census was complete.
 */
function readRouteFiles(dir: string): RouteFile[] {
  const out: RouteFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...readRouteFiles(full)); continue; }
    if (entry.name.endsWith(".ts")) out.push({ path: full, src: readFileSync(full, "utf8") });
  }
  return out;
}

const parse = (file: RouteFile): ts.SourceFile =>
  ts.createSourceFile(file.path, file.src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const read = (path: string): RouteFile => ({ path, src: readFileSync(path, "utf8") });

/**
 * The name a call names: `f()`, `mod.f()` and `mod["f"]()` all answer `"f"`.
 *
 * The element-access arm is round nine's finding. `cookies["sessionCookies"](res)` contains no
 * identifier node named `sessionCookies` at all — the name is a string literal — so it was
 * invisible to every part of this file at once: the route census, the wrapper derivation, the
 * alias guard, and the fallback grep. A computed key whose value is not a literal cannot be
 * resolved from the syntax at all, and that case is refused rather than followed; see the alias
 * case below.
 */
function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isElementAccessExpression(expr)) {
    const arg = expr.argumentExpression;
    return ts.isStringLiteral(arg) ? arg.text : null;
  }
  return null;
}

/** Every top-level function-ish declaration in a file, by the name a route could call it by. */
function declaredFunctions(sf: ts.SourceFile): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) out.set(st.name.text, st);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) out.set(d.name.text, d.initializer);
      }
    }
  }
  return out;
}

/** Is this identifier the thing being CALLED, rather than a value being passed around? */
function isCallee(node: ts.Identifier): boolean {
  const p = node.parent;
  if (ts.isCallExpression(p) && p.expression === node) return true;
  return ts.isPropertyAccessExpression(p) && p.name === node
    && ts.isCallExpression(p.parent) && p.parent.expression === p;
}

function eachNode(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => eachNode(child, visit));
}

/**
 * Every route in these files whose shape this scan cannot follow.
 *
 * A later review's first finding. The two evasions the earlier review named are followed now; its point is that
 * following two shapes is not the same as covering the space, and it listed three more that are
 * ordinary TypeScript: a handler IMPORTED from another module, a route object built by SPREADING
 * a base, and a computed callee whose key is assembled rather than written.
 *
 * There is no version of this scan that resolves an import without a type checker, so these fail
 * CLOSED. That is the same answer the alias case gives for `const set = sessionCookies`: where the
 * syntax stops being followable, somebody says so by hand rather than the census quietly narrowing.
 * The cost is a red on a legitimate refactor; the alternative is a cookie-writing route that no
 * layer sees, which is the failure the whole file exists to prevent.
 */
function unfollowableRoutes(file: RouteFile): string[] {
  const sf = parse(file);
  const local = declaredFunctions(sf);
  const out: string[] = [];
  eachNode(sf, (n) => {
    if (ts.isObjectLiteralExpression(n)) {
      const pattern = patternOf(n);
      if (pattern === null) return;
      for (const prop of n.properties) {
        if (ts.isSpreadAssignment(prop)) {
          out.push(`${pattern}: built by spreading ${prop.expression.getText(sf)} — the census reads only what the object itself contains`);
          continue;
        }
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
        if (prop.name.text !== "handler") continue;
        if (ts.isIdentifier(prop.initializer) && !local.has(prop.initializer.text)) {
          out.push(`${pattern}: handler ${prop.initializer.text} is declared outside this file — the census cannot follow it`);
        }
      }
      return;
    }
    // A call through a computed key the syntax cannot evaluate: `table[a + b](res)`.
    if (ts.isCallExpression(n) && ts.isElementAccessExpression(n.expression)) {
      const arg = n.expression.argumentExpression;
      if (!ts.isStringLiteral(arg)) {
        out.push(`${file.path.slice(REPO.length)}:${lineOf(sf, n)}: a call through a computed key the census cannot evaluate`);
      }
    }
  });
  return out;
}

/** The `pattern` of a route object literal, or null for any other object. */
function patternOf(node: ts.ObjectLiteralExpression): string | null {
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    if (prop.name.text !== "pattern") continue;
    return ts.isStringLiteral(prop.initializer) ? prop.initializer.text : null;
  }
  return null;
}

/**
 * Every route pattern whose handler reaches the cookie jar.
 *
 * A route is an object literal with a `pattern`, so this asks the question of the OBJECT rather
 * than of a slice of text between one `pattern:` and the next. The text version attributed by
 * proximity and had to be told where to stop; this one cannot attribute a writer to the wrong
 * route, because it never looks outside the route it is asking about.
 */
function cookieWritersIn(files: RouteFile[], names: readonly string[] = WRITER_NAMES): string[] {
  const found = new Set<string>();
  for (const file of files) {
    eachNode(parse(file), (n) => {
      if (!ts.isObjectLiteralExpression(n)) return;
      const pattern = patternOf(n);
      if (pattern === null) return;
      const writes = (node: ts.Node): boolean => {
        let hit = false;
        eachNode(node, (m) => {
          if (!ts.isCallExpression(m)) return;
          const name = calleeName(m.expression);
          if (name !== null && names.includes(name)) hit = true;
        });
        return hit;
      };
      if (writes(n)) { found.add(pattern); return; }
      /*
       * ── A HANDLER DECLARED SOMEWHERE ELSE, round nine's other evasion ──────────────────
       *
       * `{ pattern: "/x", handler: signOut }` is legitimate TypeScript and puts the whole body
       * outside the route object, where descending the object finds nothing. No route table uses
       * that shape today, which is exactly why it would go in unnoticed. One level of resolution
       * within the same file covers the shape; a handler imported from another module would be
       * refused by the alias case instead, because naming it here without calling it is the
       * thing that case forbids.
       */
      for (const prop of n.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
        if (prop.name.text !== "handler" || !ts.isIdentifier(prop.initializer)) continue;
        const decl = declaredFunctions(parse(file)).get(prop.initializer.text);
        if (decl && writes(decl)) found.add(pattern);
      }
    });
  }
  return [...found].sort();
}

const serverCookieWriters = (): string[] => cookieWritersIn(readRouteFiles(ROUTES_DIR));

/**
 * Every mention of a writer in one file that is NOT a call, a declaration of the writer itself, or
 * a plain non-renaming import — i.e. every way a writer could be reached under a name this scan
 * cannot follow.
 *
 * A FUNCTION, and used by both the real-tree case and the fixture case, because the first version
 * of the fixture case re-implemented this inline and therefore asserted its own copy: deleting the
 * production branch left it green. A guard that tests a duplicate of its subject is the same
 * defect as one that cannot fail.
 */
function writerOffences(file: RouteFile): string[] {
  const sf = parse(file);
  const out: string[] = [];
  const where = (n: ts.Node): string => `${file.path.replace(REPO, "")}:${lineOf(sf, n)}`;
  eachNode(sf, (n) => {
    /* A COMPUTED KEY THAT NAMES A WRITER. `cookies["sessionCookies"]()` is a call this scan can
       follow when the key is a literal; anything else — `cookies[k]`, a table indexed by a
       variable — cannot be resolved from syntax at all, so a literal key that is STORED rather
       than called is refused here rather than silently missed. */
    if (ts.isStringLiteral(n) && (WRITER_NAMES as readonly string[]).includes(n.text)
        && ts.isElementAccessExpression(n.parent) && n.parent.argumentExpression === n) {
      const call = n.parent.parent;
      if (!(ts.isCallExpression(call) && call.expression === n.parent)) {
        out.push(`${where(n)} — ${n.text} reached by computed key without being called`);
      }
      return;
    }
    if (!ts.isIdentifier(n) || !(WRITER_NAMES as readonly string[]).includes(n.text)) return;
    const p = n.parent;
    if (isCallee(n)) return;
    if (ts.isFunctionDeclaration(p) && p.name === n) return;
    if (ts.isImportSpecifier(p)) {
      // `import { sessionCookies }` is how a route reaches one. `import { sessionCookies as set }`
      // is the same function under a name no call site spells, which is what this exists for.
      if (p.propertyName === undefined) return;
      out.push(`${where(n)} — renaming import of ${n.text}`);
      return;
    }
    out.push(`${where(n)} — ${n.text} in ${ts.SyntaxKind[p.kind]}`);
  });
  return out;
}

const lineOf = (sf: ts.SourceFile, node: ts.Node): number =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

describe("the client's cookie-writer list is derived from the server's routes", () => {
  it("every route the server writes cookies at is locked by the client", async () => {
    const writers = serverCookieWriters();
    expect(writers.length, "no route appeared to write a cookie — the scan is broken, not the server")
      .toBeGreaterThan(5);

    const { cookieWritingPaths } = await import("../app/api-client.js");
    const client = new Set(cookieWritingPaths());

    for (const pattern of writers) {
      if ((LOCKED_ELSEWHERE as readonly string[]).includes(pattern)) continue;
      expect([...client], `the server writes cookies at ${pattern} and the client does not lock it`)
        .toContain(pattern);
    }
  });

  it("the client locks nothing the server does not write", async () => {
    const writers = new Set(serverCookieWriters());
    const { cookieWritingPaths } = await import("../app/api-client.js");
    for (const path of cookieWritingPaths()) {
      /* Wrapping a non-writer costs something real: one more request serialised across every tab
         on the origin, and — before `api()` stopped recovering under its own lock — two of them
         hung a prompt outright. */
      expect([...writers], `the client locks ${path}, which the server does not write cookies at`)
        .toContain(path);
    }
  });

  it("no cookie write has appeared in a module this scan does not read", () => {
    const out = execFileSync(
      "/usr/bin/grep",
      ["-rlE", "(sessionCookies|enrollmentCookies|clearSessionCookies)\\(", "packages/api/src"],
      { cwd: REPO, encoding: "utf8" },
    );
    expect(out.split("\n").filter(Boolean).sort(),
      "a session cookie is written from a module the route scan does not read — map it, or the census is silently narrower than it claims")
      .toEqual([...WRITER_MODULES].sort());
  });
});

describe("the scan's own blind spots, pinned rather than implied", () => {
  /**
   * CASE 1 — A WRITER MAY ONLY EVER BE CALLED.
   *
   * `const set = sessionCookies; … set(res)` writes the jar under a name this scan has never
   * heard of, and so does `HANDLERS[kind](res)`, and so does `import { sessionCookies as set }`
   * — which is the one the previous version of this case could not see AT ALL, because it
   * blanked imports before it looked.
   *
   * No version of this scan can follow an arbitrary value, so the precondition is asserted
   * instead: across the whole routes tree, every mention of a writer is a call, the declaration
   * of the writer itself, or a plain non-renaming import of it. Comments are not AST nodes, so a
   * `{@link sessionCookies}` in a docblock is not a mention at all and nothing has to discount
   * it — which is what removes the class of error where the discounting takes something real.
   */
  it("no writer is referenced anywhere except by calling it", () => {
    const files = [...readRouteFiles(ROUTES_DIR), read(`${REPO}packages/api/src/cookies.ts`)];
    const offences = files.flatMap(writerOffences);
    expect(offences,
      "a cookie writer is named without being called — an alias, a renaming import or a computed key writes the jar under a name the route scan cannot see. Call it directly, or the census is a claim about code nobody reads.")
      .toEqual([]);
  });

  /**
   * CASE 2 — THE WRAPPER SET IS DERIVED, NOT REMEMBERED.
   *
   * `webSession`, `enrollmentSession` and `enrollmentResult` are on the list because somebody
   * read the source once. A list cannot learn about the fourth one, and a route calling it would
   * scan clean: no writer call in its handler, no entry on the client, no lock.
   *
   * So every call to one of the three functions that emit the header is attributed to the
   * innermost enclosing function a NAME can reach — a `function f()`, or a function bound to a
   * `const`. Arrow functions, object methods and factory-internal closures are all covered,
   * which the `function`-declarations-only version was not.
   *
   * A call with no such enclosing function is a ROUTE HANDLER, and those are the route census's
   * business rather than a helper anybody can call. The second assertion is what makes that
   * distinction safe rather than convenient: every one of them must sit inside a route object
   * whose pattern the census already found. Nothing may reach the jar from a place neither list
   * accounts for.
   */
  it("every function that reaches the cookie jar is one this file names", () => {
    const named = new Set<string>();
    const anonymous: ts.Node[] = [];

    const nameOf = (n: ts.Node): string | null => {
      if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) && n.name) return n.name.text;
      const p = n.parent;
      if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
      return null;
    };

    for (const file of WRITER_MODULES.map((m) => read(`${REPO}${m}`))) {
      const sf = parse(file);
      const stack: Array<string | null> = [];
      const walk = (n: ts.Node): void => {
        const isFn = ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)
          || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
        if (isFn) stack.push(nameOf(n));
        if (ts.isCallExpression(n)) {
          const name = calleeName(n.expression);
          if (name !== null && (BASE_WRITERS as readonly string[]).includes(name)) {
            const enclosing = [...stack].reverse().find((s) => s !== null) ?? null;
            if (enclosing === null) anonymous.push(n);
            // `cookies.ts` DEFINES the three; a call inside one of them is not a wrapper of it.
            else if (!(BASE_WRITERS as readonly string[]).includes(enclosing)) named.add(enclosing);
          }
        }
        ts.forEachChild(n, walk);
        if (isFn) stack.pop();
      };
      walk(sf);
    }

    expect([...named].sort(),
      "a function reaches the cookie jar under a name this file does not know. Add it to WRITER_NAMES so the route scan follows it — a route calling an unmapped wrapper reads as writing nothing.")
      .toEqual([...WRAPPERS].sort());

    /* …and every call belonging to no named function belongs to a route the census found. */
    const census = new Set(serverCookieWriters());
    for (const call of anonymous) {
      let node: ts.Node | undefined = call;
      let pattern: string | null = null;
      while (node !== undefined && pattern === null) {
        if (ts.isObjectLiteralExpression(node)) pattern = patternOf(node);
        node = node.parent;
      }
      expect(pattern,
        "a cookie write sits in no named function and in no route — the census cannot account for it at all")
        .not.toBeNull();
      expect([...census], `the route ${pattern} writes cookies and the census did not find it`)
        .toContain(pattern);
    }
  });

  /**
   * CASE 2b — AND THE ROUTES THAT MAY REWRITE THE MARKER ARE THE ONES THAT ESTABLISH A SESSION.
   *
   * `api()` treats a response header naming another account as the NEW OWNER on the sign-in and
   * token routes, and rewrites the browser's marker from it. That is only safe where the response
   * actually established a session in THIS browser: on a route that answers with native tokens
   * and no cookies, the marker would name an account whose session the browser does not hold, and
   * every ordinary request after it would pass the boundary and go out under the session that IS
   * there.
   *
   * The first version of that list was the set of routes that RESOLVE a credential, and three of
   * them — `/auth/desktop-claim`, `/oauth/token`, `/pair/redeem` — write no cookie at all. So the
   * client derives it from this census instead, minus the two paths that only clear, and this
   * case is what holds the derivation to the server: every route the client would adopt from must
   * be one the SERVER writes session cookies at.
   */
  it("every route the client may adopt an owner from is one the server sets cookies at", async () => {
    const { credentialRoutes } = await import("../app/api-client.js");
    const writers = new Set(serverCookieWriters());
    const adopt = credentialRoutes();
    expect(adopt.length, "the client adopts from nothing — the derivation is broken, not the server")
      .toBeGreaterThan(3);
    for (const path of adopt) {
      expect([...writers],
        `the client would rewrite the browser's account marker from ${path}, which sets no session cookie — the marker would name an account this browser has no session for`)
        .toContain(path);
    }
    /* …and the two that only CLEAR are not on it. A cleared session establishes nothing, so a
       header there names an account on its way out rather than a new owner. */
    for (const path of CLEARS_ONLY_EXPECTED) {
      expect([...adopt], `${path} clears the jar and must never be adopted from`).not.toContain(path);
    }
  });

  /**
   * CASE 2c — THE TWO SHAPES THAT WENT ROUND THE WHOLE FILE AT ONCE.
   *
   * Round nine found both, and what makes them worth their own case is that neither is caught by
   * any single assertion above — each evaded the route census, the wrapper derivation, the alias
   * guard AND the fallback grep together, because none of them contained an identifier node named
   * after a writer or a writer call inside the route object.
   *
   * Driven over fixtures, for case 3's reason: the real tables use neither shape today, so a case
   * that only read them would go green on the day one appears.
   */
  it("finds a writer reached by a computed key, and one behind a handler declared elsewhere", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmail-census-evade-"));
    try {
      writeFileSync(join(dir, "computed.ts"),
        'export const a = [\n' +
        '  { method: "POST", pattern: "/auth/by-computed-key",\n' +
        '    handler: async () => cookies["sessionCookies"](res) },\n' +
        '];\n', "utf8");
      writeFileSync(join(dir, "named.ts"),
        'const signOutHandler = async () => enrollmentResult(res);\n' +
        'export const b = [\n' +
        '  { method: "POST", pattern: "/auth/by-named-handler", handler: signOutHandler },\n' +
        '];\n', "utf8");
      expect(cookieWritersIn(readRouteFiles(dir)).sort(),
        "a route reached the cookie jar by a shape the census cannot see")
        .toEqual(["/auth/by-computed-key", "/auth/by-named-handler"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * …AND A COMPUTED KEY THE SYNTAX CANNOT RESOLVE IS REFUSED RATHER THAN MISSED.
   *
   * `cookies[k](res)` names a writer at runtime and nothing at parse time. Following it is not
   * possible from syntax; the honest answer is to fail and make somebody say what `k` is, which
   * is the same posture the alias case takes for `const set = sessionCookies`.
   */
  it("refuses a writer named by a computed key that is not called", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmail-census-key-"));
    try {
      writeFileSync(join(dir, "table.ts"),
        'const pick = cookies["sessionCookies"];\n' +
        'export const c = [{ method: "POST", pattern: "/auth/x", handler: async () => pick(res) }];\n',
        "utf8");
      /* THE SAME FUNCTION the real-tree case runs, not a copy of it. */
      const offences = readRouteFiles(dir).flatMap(writerOffences);
      expect(offences.join(" | "), "a writer taken by a computed key and stored was not refused")
        .toContain("reached by computed key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * CASE 2d — WHAT THE SCAN CANNOT FOLLOW, IT REFUSES.
   *
   * Round ten: following two shapes is not covering the space. A handler imported from another
   * module, a route object spread from a base, and a call through an assembled key are all
   * ordinary TypeScript and all unresolvable from syntax alone. Each fails CLOSED — the same
   * answer the alias case gives — so a refactor into one of them is a red somebody reads, rather
   * than a cookie-writing route no layer sees.
   *
   * The real tree must be clean of all three, and the fixtures prove each is actually caught: a
   * refusal nobody has watched fire is worth as little as a guard nobody has watched fail.
   */
  it("the real route tables use no shape this scan cannot follow", () => {
    const out = readRouteFiles(ROUTES_DIR).flatMap(unfollowableRoutes);
    expect(out,
      "a route is written in a shape the census cannot resolve — resolve it by hand, or the census is silently narrower than it claims")
      .toEqual([]);
  });

  it("…and each of the three shapes is caught", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmail-census-shapes-"));
    try {
      writeFileSync(join(dir, "imported.ts"),
        'import { finish } from "./finish";\n' +
        'export const a = [{ method: "POST", pattern: "/auth/imported", handler: finish }];\n', "utf8");
      writeFileSync(join(dir, "spread.ts"),
        'export const b = [{ ...base, pattern: "/auth/spread" }];\n', "utf8");
      writeFileSync(join(dir, "computed.ts"),
        'export const c = [{ method: "POST", pattern: "/auth/assembled",\n' +
        '  handler: async () => table[prefix + "Cookies"](res) }];\n', "utf8");
      const out = readRouteFiles(dir).flatMap(unfollowableRoutes).join("\n");
      expect(out, "an imported handler passed as followable").toMatch(/handler finish is declared outside/);
      expect(out, "a spread route object passed as followable").toMatch(/built by spreading/);
      expect(out, "a call through an assembled key passed as followable").toMatch(/computed key the census cannot evaluate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * CASE 2e — ESTABLISHING AND CLEARING ARE DIFFERENT QUESTIONS, ASKED SEPARATELY.
   *
   * Round ten's. `credentialRoutes()` is derived as "writes cookies, minus the two that only
   * clear", and the two are a hand-written list on the client. Add a third clear-only route on the
   * server, update the client census correctly, and it walks straight into the adopt list — after
   * which a successful clear carrying an account header rewrites the browser's marker to name an
   * account whose session was just removed.
   *
   * So both sets are derived from the server, by WHICH writer the route calls, and the client's
   * `CLEARS_ONLY` is held to the difference. A new clear-only route is then a red here until
   * somebody adds it, rather than a silent promotion.
   */
  it("the client's adopt list is the server's ESTABLISHING routes, not merely its writers", async () => {
    const files = readRouteFiles(ROUTES_DIR);
    const establishing = new Set(cookieWritersIn(files, ESTABLISHING_WRITERS));
    const clearing = cookieWritersIn(files, ["clearSessionCookies"]).filter((p) => !establishing.has(p));

    expect([...establishing].length, "no route appeared to establish a session — the scan is broken")
      .toBeGreaterThan(4);
    expect(clearing.sort(), "the client's clear-only list is not the server's")
      .toEqual([...CLEARS_ONLY_EXPECTED].sort());

    const { credentialRoutes } = await import("../app/api-client.js");
    const adopt = new Set(credentialRoutes());
    for (const path of adopt) {
      expect([...establishing], `the client adopts an owner from ${path}, which establishes no session here`)
        .toContain(path);
    }
    for (const path of clearing) {
      expect([...adopt], `${path} only clears the jar and must never be adopted from`).not.toContain(path);
    }
  });

  /**
   * CASE 3 — THE SCAN DESCENDS.
   *
   * Driven over a fixture tree rather than the real one, because the real one is flat today and
   * a test that only asserts today's shape would go green the moment somebody adds a directory —
   * which is the moment it needs to fail. The fixture puts a cookie-writing route one level down
   * and nothing at the top, so a non-recursive read finds NO writers at all.
   */
  it("reads a route table in a nested directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmail-census-"));
    try {
      mkdirSync(join(dir, "cloud"));
      writeFileSync(join(dir, "index.ts"), "export const routes = [];\n", "utf8");
      writeFileSync(
        join(dir, "cloud", "ceremony.ts"),
        "export const ceremonyRoutes = [\n" +
        '  { method: "POST", pattern: "/auth/deep-ceremony",\n' +
        "    handler: async () => sessionCookies(fresh) },\n" +
        "];\n",
        "utf8",
      );
      expect(cookieWritersIn(readRouteFiles(dir)),
        "a cookie-writing route one directory down was invisible to the census")
        .toEqual(["/auth/deep-ceremony"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * CASE 4 — THE LIST IS ACTUALLY CONSULTED, BY THE FUNCTION THAT MAKES THE REQUEST.
 *
 * Everything above compares two lists. Delete the `writesSessionCookies(path)` branch from
 * `api()` and every one of them stays green: the census still matches the server, the client
 * still exports the same paths, and not one request takes a lock. That is the same shape as a
 * guard whose exit code comes from its configuration instead of from reality.
 *
 * So this one makes a real request through the real client and watches the lock manager. jsdom
 * has none — which is why no other test in this file could have seen the branch disappear — so
 * one is installed here, exactly as `session-cookie-lock.test.ts` does.
 */
describe("api() takes the lock for the paths on the census", () => {
  let asked: string[] = [];
  let priorFetch: typeof globalThis.fetch;

  beforeEach(() => {
    asked = [];
    Object.defineProperty(globalThis.navigator, "locks", {
      value: {
        request: async (name: string, _opts: unknown, fn: () => Promise<unknown>) => {
          asked.push(name);
          return fn();
        },
      },
      configurable: true,
    });
    priorFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = priorFetch;
    Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, "locks");
    const { bindApiOwner } = await import("../app/api-client.js");
    bindApiOwner(null);
    vi.restoreAllMocks();
  });

  it("every path on the census locks, and a path that is not on it does not", async () => {
    const { api, bindApiOwner, cookieWritingPaths } = await import("../app/api-client.js");
    bindApiOwner(null);

    for (const path of cookieWritingPaths()) {
      asked.length = 0;
      await api(path, { method: "POST" }).catch(() => undefined);
      expect(asked, `a request to ${path} rewrites the session jar and took no origin-wide lock`)
        .toEqual(["ohmail:session-refresh"]);
    }

    /* The control, and it is not decoration: a version of `api()` that locked EVERYTHING would
       pass the loop above and serialise every read in every tab behind every ceremony. */
    asked.length = 0;
    await api("/messages?limit=1").catch(() => undefined);
    expect(asked, "an ordinary read queued behind the session lock").toEqual([]);
  });
});
