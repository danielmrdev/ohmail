import ts from "typescript";

/**
 * WHERE A FILE'S SQL IS, AND WHICH OF IT A DEVICE EVER RUNS — from the AST, not from a pattern.
 *
 * A pattern over source answers "does the word appear", which is a census satisfied by a symbol
 * APPEARING. Four readings it gets wrong and this one cannot: `store.sql`…`` is not drizzle's tag,
 * a backtick inside a STRING opens no template, `sql.raw("…")` is raw SQL the pattern never saw,
 * and a `pgOnly(` marker exempts a statement wherever it is written rather than only inside the
 * branch that keeps the device store away from it.
 */

/** One run of SQL text a file emits, with the source offset of every character it kept. */
export interface SqlSpan {
  /** The statement, interpolations dropped — each leaves one space, so no token fuses across one. */
  readonly text: string;
  /** Source offset per character of {@link text}, so a hit cites the line it is really on. */
  readonly offsets: number[];
  /** Inside a declared branch's server arm, so no device store ever reaches it. */
  readonly declared: boolean;
}

/** A half-open source range. */
export interface Range { readonly start: number; readonly end: number }

const scriptKind = (fileName: string): ts.ScriptKind =>
  fileName.endsWith(".tsx") ? ts.ScriptKind.TSX
    : fileName.endsWith(".jsx") ? ts.ScriptKind.JSX
      : /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;

/**
 * Parse one file's text. Syntactic only — no program and no checker.
 *
 * The question here is SHAPE (is this drizzle's tag, is this call inside that branch), and a
 * checker would put a 300-second program between the census and every file it reads. The arm that
 * needs a TYPE is `_dialect-bindings.ts`, which builds one.
 */
export function parseSource(text: string, fileName = "census.ts"): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
}

/** Drizzle's statement tag: the identifier `sql`, or `sql.raw`. A member of something else is not. */
function isSqlTag(tag: ts.Expression): boolean {
  if (ts.isIdentifier(tag)) return tag.text === "sql";
  return ts.isPropertyAccessExpression(tag)
    && ts.isIdentifier(tag.expression) && tag.expression.text === "sql"
    && tag.name.text === "raw";
}

/** The characters BETWEEN a template token's delimiters — head and middle end in `${`, tail in a backtick. */
function literalRange(node: ts.Node, sf: ts.SourceFile): Range {
  const start = node.getStart(sf) + 1;
  const closes = ts.isTemplateHead(node) || ts.isTemplateMiddle(node) ? 2 : 1;
  return { start, end: node.getEnd() - closes };
}

const isStringish = (n: ts.Node): boolean =>
  ts.isStringLiteralLike(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n);

/**
 * A raw SQL STRING the dialect layer hands the driver — `sql.raw("…")`, `db.execute("…")`.
 *
 * Not a tagged template, so no template reader could ever see it: the text goes through as an
 * argument. `sql.raw` is the seam's own escape from the tag, and drizzle's `execute` takes a
 * string as readily as an `SQL`.
 */
function rawSqlArgument(node: ts.CallExpression): ts.Expression | null {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const isSqlRaw = ts.isIdentifier(callee.expression) && callee.expression.text === "sql"
    && callee.name.text === "raw";
  const isExecute = ts.isIdentifier(callee.expression)
    && (callee.expression.text === "db" || callee.expression.text === "tx")
    && callee.name.text === "execute";
  if (!isSqlRaw && !isExecute) return null;
  const arg = node.arguments[0];
  return arg && isStringish(arg) ? arg : null;
}

/* ── THE DECLARED BRANCH ──────────────────────────────────────────────────────────────────── */

type Pred = "device" | "server";

const flip = (p: Pred | null): Pred | null =>
  p === null ? null : p === "device" ? "server" : "device";

/**
 * `d.name`, `this.d.name`, `dialectOf(db)` — an expression whose value is the dialect's NAME.
 *
 * `dialect(db)` is NOT one: it answers the seam OBJECT, so `dialect(db) === "sqlite"` is always
 * false. Admitting it would read a guard that never fires as a branch, and hand the code after it
 * an exemption every store reaches — the exact inversion of what this function is for.
 */
function readsDialectName(e: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(e)) return e.name.text === "name";
  return ts.isCallExpression(e) && ts.isIdentifier(e.expression)
    && e.expression.text === "dialectOf";
}

const nameLiteral = (e: ts.Expression): string | null =>
  ts.isStringLiteralLike(e) ? e.text : null;

/**
 * Is this condition true exactly on one store?
 *
 * The two spellings the tree uses are a name comparison (`…name === "sqlite"`,
 * `dialect(db).name !== "pg"`) and a boolean member (`…isPostgres`). `vars` carries the local
 * booleans a function assigns from one of those, which is how the health route branches.
 */
function predicateOf(e: ts.Expression, vars: ReadonlyMap<string, Pred>): Pred | null {
  if (ts.isParenthesizedExpression(e)) return predicateOf(e.expression, vars);
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    return flip(predicateOf(e.operand, vars));
  }
  if (ts.isIdentifier(e)) return vars.get(e.text) ?? null;
  if (ts.isPropertyAccessExpression(e)) {
    if (e.name.text === "isPostgres") return "server";
    if (e.name.text === "isSqlite") return "device";
    return null;
  }
  if (!ts.isBinaryExpression(e)) return null;
  const op = e.operatorToken.kind;
  const eq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
  const ne = op === ts.SyntaxKind.ExclamationEqualsEqualsToken
    || op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!eq && !ne) return null;
  const right = nameLiteral(e.right);
  const literal = right ?? nameLiteral(e.left);
  const other = right !== null ? e.left : e.right;
  if (literal === null || !readsDialectName(other)) return null;
  if (literal === "sqlite") return eq ? "device" : "server";
  if (literal === "pg") return eq ? "server" : "device";
  return null;
}

const isBooleanLiteral = (e: ts.Expression): boolean =>
  e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword;

/**
 * Local booleans that MEAN a dialect, by name — the health route's `deviceStore` shape.
 *
 * A name is kept only when every value it is ever given is either that one predicate or a boolean
 * literal. Two different predicates under one name, or any other value, DROPS it: a file that
 * reuses a name loses the exemption rather than widening it.
 */
function dialectVars(sf: ts.SourceFile): Map<string, Pred> {
  const seen = new Map<string, Pred | "mixed">();
  const record = (name: string, value: ts.Expression | undefined) => {
    if (!value || isBooleanLiteral(value)) return;
    const p = predicateOf(value, new Map());
    const was = seen.get(name);
    if (p === null) seen.set(name, "mixed");
    else if (was === undefined) seen.set(name, p);
    else if (was !== p) seen.set(name, "mixed");
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      record(node.name.text, node.initializer);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)) {
      record(node.left.text, node.right);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const out = new Map<string, Pred>();
  for (const [name, p] of seen) if (p !== "mixed") out.set(name, p);
  return out;
}

/** Does every path through this statement leave? A guard that does not is not a guard. */
function terminates(s: ts.Statement | undefined): boolean {
  if (!s) return false;
  if (ts.isReturnStatement(s) || ts.isThrowStatement(s)) return true;
  if (ts.isBlock(s)) return terminates(s.statements.at(-1));
  if (ts.isIfStatement(s)) return terminates(s.thenStatement) && terminates(s.elseStatement);
  if (ts.isTryStatement(s)) {
    if (s.finallyBlock && terminates(s.finallyBlock)) return true;
    return terminates(s.tryBlock) && (!s.catchClause || terminates(s.catchClause.block));
  }
  return false;
}

/** Everything after `stmt` in the block that holds it — an early guard's far side. */
function restOfBlock(stmt: ts.Statement): Range | null {
  const parent = stmt.parent;
  if (!parent || !(ts.isBlock(parent) || ts.isSourceFile(parent))) return null;
  const end = parent.getEnd();
  const start = stmt.getEnd();
  return end > start ? { start, end } : null;
}

/**
 * THE REGIONS A DEVICE STORE NEVER REACHES — the arms a branch declares by branching.
 *
 * Three shapes, all of them in the tree: the then-block of an `if` on the server, the far side of
 * an early `if (device) return …`, and a ternary's server side. It is the ARM and never the file:
 * a range that stopped at a statement boundary is the difference between exempting one statement
 * and exempting everything after it.
 */
export function serverArms(sf: ts.SourceFile): Range[] {
  const vars = dialectVars(sf);
  const arms: Range[] = [];
  const push = (n: ts.Node | undefined) => {
    if (n) arms.push({ start: n.getStart(sf), end: n.getEnd() });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      const p = predicateOf(node.expression, vars);
      if (p === "server") push(node.thenStatement);
      if (p === "device" && node.elseStatement) push(node.elseStatement);
      if (p === "device" && !node.elseStatement && terminates(node.thenStatement)) {
        const rest = restOfBlock(node);
        if (rest) arms.push(rest);
      }
    }
    if (ts.isConditionalExpression(node)) {
      const p = predicateOf(node.condition, vars);
      if (p === "server") push(node.whenTrue);
      if (p === "device") push(node.whenFalse);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return arms;
}

const within = (arms: readonly Range[], offset: number): boolean =>
  arms.some((a) => offset >= a.start && offset < a.end);

/* ── THE READINGS THE CENSUS ASKS FOR ─────────────────────────────────────────────────────── */

/**
 * Every run of SQL text `source` emits, in source order.
 *
 * Interpolations leave a space rather than closing up, so `${a}now()` cannot read as one token and
 * a construct split across an interpolation cannot be assembled out of two halves.
 */
export function sqlSpans(source: string, fileName = "census.ts"): SqlSpan[] {
  const sf = parseSource(source, fileName);
  const arms = serverArms(sf);
  const spans: SqlSpan[] = [];
  const emit = (ranges: Range[], at: ts.Node) => {
    const declared = within(arms, at.getStart(sf));
    let text = "";
    const offsets: number[] = [];
    for (const [i, r] of ranges.entries()) {
      if (i > 0) { text += " "; offsets.push(r.start); }
      for (let k = r.start; k < r.end; k++) { text += source[k] as string; offsets.push(k); }
    }
    spans.push({ text, offsets, declared });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && isSqlTag(node.tag)) {
      const t = node.template;
      emit(ts.isNoSubstitutionTemplateLiteral(t)
        ? [literalRange(t, sf)]
        : [literalRange(t.head, sf), ...t.templateSpans.map((s) => literalRange(s.literal, sf))], node);
    }
    if (ts.isCallExpression(node)) {
      const arg = rawSqlArgument(node);
      if (arg) {
        emit(ts.isTemplateExpression(arg)
          ? [literalRange(arg.head, sf), ...arg.templateSpans.map((s) => literalRange(s.literal, sf))]
          : [{ start: arg.getStart(sf) + 1, end: arg.getEnd() - 1 }], node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return spans;
}

/** The SQL a device store could reach — every span but the declared arms. */
export function censusableSpans(source: string, fileName?: string): SqlSpan[] {
  return sqlSpans(source, fileName).filter((s) => !s.declared);
}

/** Every `pgOnly(` CALL, and whether it sits inside a branch that keeps the device store out. */
export function pgOnlyCalls(
  source: string, fileName = "census.ts",
): { line: number; declared: boolean }[] {
  const sf = parseSource(source, fileName);
  const arms = serverArms(sf);
  const out: { line: number; declared: boolean }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === "pgOnly") {
      const at = node.getStart(sf);
      out.push({
        line: sf.getLineAndCharacterOfPosition(at).line + 1,
        declared: within(arms, at),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The regions a device store never reaches, for a caller scanning the file rather than its SQL. */
export function serverArmRanges(source: string, fileName = "census.ts"): Range[] {
  return serverArms(parseSource(source, fileName));
}

/** Is this offset inside one of them? */
export function inServerArm(arms: readonly Range[], offset: number): boolean {
  return within(arms, offset);
}

/** 1-based line of every offset, for a citation. */
export function lineOf(source: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let lo = 0; let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if ((starts[mid] as number) <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}
