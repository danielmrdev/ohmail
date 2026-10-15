import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { apiRoutes, createApp, PAGING_QUERY_BOUNDS, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, seedContact, req, FIXED_NOW } from "./helpers.js";

/**
 * ═══ THE PAGING QUERY SEAM ═══════════════════════════════════════════════════════════════
 *
 * and the row's own sentence is what this file measures: the
 * input-edge fixes each closed the route they were reported on and left the siblings open.
 *
 * WHAT WAS ACTUALLY OPEN, measured route by route before the fix. `?limit=abc` did NOT reach
 * PostgreSQL on any of the twenty-one paging routes — `clampPageLimit` sends every non-finite
 * value to the service's default, and all sixteen services that take a caller-chosen limit call
 * it. The hole was the OPPOSITE shape: `?limit=`, `?limit=%20`, `?limit=0` and `?limit=-5` each
 * answered 200 with exactly ONE ROW, because `Number("")` is 0 and every clamp raises 0 to 1.
 * `?limit=` is what a client emits for `?limit=${state ?? ""}`, so the answer to a paging bug was
 * a one-item page with a cursor — a mailbox that looks almost empty and reports itself healthy.
 * Three routes (`devices.ts`, `sync.ts` twice) carried a hand-written `!== ""` guard against
 * exactly that; eighteen did not, which is the row in one line.
 *
 * The seam refuses the SHAPE once, at dispatch, beside the path parameters' own refusal. The BAND
 * is untouched and stays with the service that owns it, so no product number moves.
 */

const ROUTES_DIR = resolve(__dirname, "../src/routes");
const BOUND_NAMES = new Set(PAGING_QUERY_BOUNDS.map((b) => b.name));

const sourceOf = (path: string): ts.SourceFile =>
  ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);

const routeFiles = (): string[] =>
  readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts")).map((f) => join(ROUTES_DIR, f));

/**
 * Every `<anything>.get("<name>")` CALL in a file, with the one fact this census is about:
 * whether the read is the ARGUMENT of a `pagingNumber(...)` call. The read itself stays where it
 * is on purpose — `input-bounds-census.test.ts` finds a query parameter by that very call, and a
 * refactor that moved the name into the seam would have removed its needle and left it passing on
 * an absence. So this census asks about the WRAPPING, not the absence.
 */
function paramGetCalls(src: ts.SourceFile): { name: string; line: number; wrapped: boolean }[] {
  const out: { name: string; line: number; wrapped: boolean }[] = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "get"
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0]!)
    ) {
      const parent = node.parent;
      out.push({
        name: (node.arguments[0] as ts.StringLiteral).text,
        line: src.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        wrapped: ts.isCallExpression(parent)
          && ts.isIdentifier(parent.expression)
          && parent.expression.text === "pagingNumber"
          && parent.arguments.includes(node as ts.Expression),
      });
    }
    ts.forEachChild(node, walk);
  };
  walk(src);
  return out;
}

/** Files that CALL `pagingNumber(...)` — the call, never the import. */
function callsPagingNumber(src: ts.SourceFile): boolean {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "pagingNumber") {
      found = true;
    }
    ts.forEachChild(node, walk);
  };
  walk(src);
  return found;
}

/**
 * The routes that read a paging number, pinned by NAME rather than by count: a count anchor
 * shifts under an insertion, and this set is what the census is about.
 */
const PAGING_ROUTE_FILES = [
  "admin.ts", "approvals.ts", "attachments.ts", "contacts.ts", "devices.ts", "kb.ts",
  "messages.ts", "notify.ts", "privacy.ts", "screener.ts", "search.ts", "snippets.ts",
  "sync.ts", "triage.ts", "workflows.ts",
];

describe("the paging query seam — the census", () => {
  it("no route reads a paging parameter raw; every read is wrapped by the seam's reader", () => {
    const unwrapped: string[] = [];
    let wrapped = 0;
    for (const path of routeFiles()) {
      const src = sourceOf(path);
      for (const call of paramGetCalls(src)) {
        if (!BOUND_NAMES.has(call.name)) continue;
        if (call.wrapped) wrapped += 1;
        else unwrapped.push(`${path.split("/").pop()}:${call.line} get("${call.name}")`);
      }
    }
    expect(unwrapped).toEqual([]);
    // Not vacuous: the census found the reads it is about. A `0` here would mean the needle
    // stopped matching, which is the failure this whole file is written against.
    expect(wrapped).toBeGreaterThanOrEqual(20);
  });

  it("the pinned paging routes call pagingNumber, and nobody else does", () => {
    const calling = routeFiles()
      .filter((p) => callsPagingNumber(sourceOf(p)))
      .map((p) => p.split("/").pop()!)
      .sort();
    expect(calling).toEqual([...PAGING_ROUTE_FILES].sort());
  });

  it("the refusal runs at dispatch, before any handler", () => {
    const app = sourceOf(resolve(__dirname, "../src/app.ts"));
    let called = false;
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === "firstMisshapenQuery"
      ) called = true;
      ts.forEachChild(node, walk);
    };
    walk(app);
    expect(called).toBe(true);
  });
});

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/**
 * The five routes the row names. `drafts.ts` is one of them and reads NO paging query at all —
 * measured, and said here rather than left as a gap in the list.
 */
const NAMED = [
  ["/messages", "?view=imbox"],
  ["/devices", ""],
  ["/search", "?q=hi"],
  ["/contacts", ""],
] as const;

describe("the paging query seam — driven through the real routes", () => {
  it("a limit that is not a page is refused 400, naming the field", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    for (const [path, base] of NAMED) {
      for (const bad of ["abc", "0", "-5", "1.5", "1e999"]) {
        const res = await H(req("GET", `${path}${base}${base ? "&" : "?"}limit=${bad}`, { bearer: s.token }), deps);
        const body = await res.json() as { error?: { message?: string } };
        expect(`${path} limit=${bad} → ${res.status}`).toBe(`${path} limit=${bad} → 400`);
        expect(body.error?.message).toBe("limit must be a whole number of at least 1");
      }
    }
  });

  it("a blank limit is NOT an ask — the default page, never a page of one", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    for (const a of ["a@example.com", "b@example.com", "c@example.com"]) {
      await seedContact(db, { accountId: s.accountId, address: a });
    }
    const count = async (q: string): Promise<number> => {
      const res = await H(req("GET", `/contacts${q}`, { bearer: s.token }), deps);
      expect(res.status).toBe(200);
      return ((await res.json()) as { items: unknown[] }).items.length;
    };
    expect(await count("")).toBe(3);
    expect(await count("?limit=")).toBe(3);
    expect(await count("?limit=%20")).toBe(3);
    // The band is untouched: a real number still pages, and one over the service's ceiling is
    // still clamped by the service rather than refused here.
    expect(await count("?limit=2")).toBe(2);
    expect(await count("?limit=999999")).toBe(3);
  });

  it("a position parameter's floor is 0, not 1 — the admin roster's first page", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const ok = await H(req("GET", "/messages?view=imbox&limit=5", { bearer: s.token }), deps);
    expect(ok.status).toBe(200);
    // `page=0` is the first page and must pass the seam; `page=-1` is not a page.
    const zero = await H(req("GET", "/messages?view=imbox&page=0", { bearer: s.token }), deps);
    expect(zero.status).toBe(200);
    const negative = await H(req("GET", "/messages?view=imbox&page=-1", { bearer: s.token }), deps);
    expect(negative.status).toBe(400);
    expect(((await negative.json()) as { error: { message: string } }).error.message)
      .toBe("page must be a whole number of at least 0");
  });
});
