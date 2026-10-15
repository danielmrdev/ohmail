/**
 * EVERY VERB SAYS WHAT IT DID — and the saying happens in ONE place. A press from the reader
 * or a swipe on a row dispatches through `state/live.ts`, which raises the sentence and, where
 * the engine can build the wire's reversal, the Undo beside it (`verb-undo-live.test.ts` drives
 * that half on a real wire). What no wire test can see is a verb ADDED later that dispatches and
 * says nothing — the shape a device walk reads as "the press did nothing".
 *
 * So this census reads the syntax tree three ways:
 *
 *  · every action of the facade that reaches `engine.mutate` must reach the announcing door
 *    (`toast` / `said` / `saidAll`), through however many local helpers;
 *  · every verb the READER and the ROW SWIPE actually press — derived from their own source,
 *    never typed here — must raise a SUCCESS sentence, not only a failure one;
 *  · no screen may dispatch a mutation itself: a second door is a second vocabulary, and the
 *    toast, the undo and the refusal words all hang off this one.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { nextToast } from "../src/state/toast-one";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const LIVE = path.join(APP, "src", "state", "live.ts");
/** The reader's verbs and the row's swipe — the two surfaces the finding was measured on. */
const PRESSERS = [
  path.join(APP, "src", "ui", "MessageActions.tsx"),
  path.join(APP, "src", "ui", "MailRow.tsx"),
];

/** The door's three spellings. `said`/`saidAll` turn a verdict into one of three sentences. */
const DOOR = new Set(["toast", "said", "saidAll"]);

/**
 * A verb that dispatches and DELIBERATELY says nothing on success. Each name is a press the
 * person did not make, or one whose sentence belongs to another surface.
 */
const NO_SUCCESS_SENTENCE: Record<string, string> = {
  openMessage:
    "the glance — opening a message marks it read as a side effect of reading it, and a toast "
    + "for every open would be a sentence about something nobody pressed",
  sendReply:
    "the composer's own door: the send's outcome is spoken where it settles (queued, sent, "
    + "scheduled or refused), which is a different sentence from 'dispatched'",
  sendForward:
    "the composer's door, as sendReply — the forward's outcome is spoken where the send settles "
    + "rather than where it is handed over",
};

/**
 * A verb that reaches the wire and the door NEITHER way. One entry, and it is the one the
 * module's own docblock argues for: dismissing a folder refusal that fails to dismiss leaves
 * the refusal standing on the screen, which is a more honest report than a sentence about it.
 */
const NO_SENTENCE_AT_ALL: Record<string, string> = {
  folderDismiss:
    "fire-and-forget: the act removes a refusal from the screen, so a failure is reported by "
    + "the refusal still being there — a toast would be a second, weaker copy of that",
};

const parse = (file: string) =>
  ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** The `liveActions` factory body — every local helper and the facade it returns live in it. */
function liveActionsBody(src: ts.SourceFile): ts.Block {
  let found: ts.Block | null = null;
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === "liveActions" && n.body) found = n.body;
    ts.forEachChild(n, visit);
  };
  visit(src);
  if (found === null) throw new Error("liveActions not found in live.ts — the census read nothing");
  return found;
}

interface Verb { name: string; node: ts.Node }

/** Every `const <name> = …` and `function <name>` declared directly in the factory. */
function localsOf(body: ts.Block): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  for (const st of body.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) out.set(d.name.text, d.initializer);
      }
    } else if (ts.isFunctionDeclaration(st) && st.name) out.set(st.name.text, st);
  }
  return out;
}

/** The facade `liveActions` returns: property name → the local (or inline body) behind it. */
function facadeOf(body: ts.Block): Verb[] {
  const ret = body.statements.find(ts.isReturnStatement);
  const obj = ret?.expression;
  if (!obj || !ts.isObjectLiteralExpression(obj)) throw new Error("liveActions' facade is not an object literal");
  const out: Verb[] = [];
  for (const p of obj.properties) {
    if (ts.isShorthandPropertyAssignment(p)) out.push({ name: p.name.text, node: p });
    else if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name)) out.push({ name: p.name.text, node: p });
    else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) out.push({ name: p.name.text, node: p.initializer });
  }
  return out;
}

/** Every call this subtree makes, as `callee text` → the call nodes. */
function callsIn(n: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (x: ts.Node): void => {
    if (ts.isCallExpression(x)) out.push(x);
    ts.forEachChild(x, visit);
  };
  visit(n);
  return out;
}

const calleeName = (c: ts.CallExpression): string =>
  ts.isIdentifier(c.expression) ? c.expression.text
    : ts.isPropertyAccessExpression(c.expression) ? c.expression.getText() : "";

/**
 * A `toast(…)` whose sentence is a REFUSAL is the failure half of a verb, never its report.
 * The failure keys all end the same way, and the census says which spellings it knows — a key
 * outside them counts as a success sentence, which is the safe direction: a new failure key
 * that reads as success makes a silent verb look announced only until the next key is added,
 * and the reader arm below is what would then be measuring nothing.
 */
const FAILURE_KEY = /(Failed|Refused|Unavailable|Unreachable|Rejected)$/;
function isFailureSentence(arg: ts.Expression | undefined): boolean {
  if (!arg) return true;
  if (ts.isCallExpression(arg) && calleeName(arg) === "refuse") {
    const first = arg.arguments[0];
    return !!first && ts.isStringLiteral(first) && FAILURE_KEY.test(first.text);
  }
  return false;
}

interface Reach { mutates: boolean; door: boolean; success: boolean }

/** What a subtree does, following every local it calls. `seen` breaks the recursion's cycles. */
function reachOf(node: ts.Node, locals: Map<string, ts.Node>, seen = new Set<string>()): Reach {
  const r: Reach = { mutates: false, door: false, success: false };
  for (const c of callsIn(node)) {
    const name = calleeName(c);
    if (name === "engine.mutate" || name === "engine.mutateMany") r.mutates = true;
    if (DOOR.has(name)) {
      r.door = true;
      if (name === "toast" && !isFailureSentence(c.arguments[0])) r.success = true;
      // `said(verdict, done, failed)` / `saidAll(…)`: a `null` done is "the caller already
      // spoke, or this press has nothing to report" — the shape `openMessage` uses.
      if (name !== "toast") {
        const done = c.arguments[1];
        if (done && done.kind !== ts.SyntaxKind.NullKeyword) r.success = true;
      }
    }
    /* AND NOT INTO THE DOOR ITSELF. `said` is a local like any other, and its body calls
       `toast(done, opts)` — so descending into it read EVERY verb that goes through it as
       having raised a success sentence, whatever it actually passed. Measured: with the
       sentence cut out of `triage`, the census stayed green. What a door says is decided at
       the CALL, from its arguments, which is what the branch above reads. */
    const local = DOOR.has(name) ? undefined : locals.get(name);
    if (local && !seen.has(name)) {
      seen.add(name);
      const inner = reachOf(local, locals, seen);
      r.mutates ||= inner.mutates;
      r.door ||= inner.door;
      r.success ||= inner.success;
    }
  }
  return r;
}

/** The verbs the reader's bar, its sheets and the row swipe actually press. */
function pressedVerbs(): Set<string> {
  const out = new Set<string>();
  for (const file of PRESSERS) {
    for (const c of callsIn(parse(file))) {
      const m = /^(?:a|w\.actions|actions)\.([A-Za-z]+)$/.exec(calleeName(c));
      if (m) out.add(m[1]!);
    }
  }
  return out;
}

function facadeReach(): Map<string, Reach> {
  const body = liveActionsBody(parse(LIVE));
  const locals = localsOf(body);
  const out = new Map<string, Reach>();
  for (const v of facadeOf(body)) {
    const impl = ts.isShorthandPropertyAssignment(v.node) ? locals.get(v.name) : v.node;
    out.set(v.name, impl ? reachOf(impl, locals) : { mutates: false, door: false, success: false });
  }
  return out;
}

describe("one door: every dispatching verb is announced", () => {
  it("the census read a real facade — the verbs are there and some of them mutate", () => {
    const reach = facadeReach();
    expect(reach.size).toBeGreaterThanOrEqual(30);
    expect([...reach.values()].filter((r) => r.mutates).length).toBeGreaterThanOrEqual(12);
    for (const known of ["pileToggle", "move", "markSeen", "resurfaceDone", "deleteMessage"]) {
      expect(reach.get(known)?.mutates, `${known}: read as dispatching nothing`).toBe(true);
    }
  });

  it("every verb that reaches engine.mutate reaches toast / said / saidAll", () => {
    const silent = [...facadeReach()]
      .filter(([, r]) => r.mutates && !r.door)
      .filter(([name]) => !(name in NO_SENTENCE_AT_ALL))
      .map(([name]) => `${name}: dispatches a mutation and says nothing — route it through said()`);
    expect(silent).toEqual([]);
  });

  it("every verb the reader or a swipe presses says what it DID, not only what failed", () => {
    const reach = facadeReach();
    const pressed = pressedVerbs();
    expect(pressed.size, "the presser census read no verbs at all").toBeGreaterThanOrEqual(8);
    const mute = [...pressed]
      .filter((v) => reach.get(v)?.mutates === true && reach.get(v)?.success !== true)
      .filter((v) => !(v in NO_SUCCESS_SENTENCE))
      .map((v) => `${v}: pressed from the reader or a swipe, dispatches, and raises no success sentence`);
    expect(mute.sort()).toEqual([]);
  });

  it("the exempted verbs are real, pressed, and their reason is prose", () => {
    const reach = facadeReach();
    for (const [name, why] of [...Object.entries(NO_SUCCESS_SENTENCE), ...Object.entries(NO_SENTENCE_AT_ALL)]) {
      expect(reach.has(name), `${name}: exempted but not a verb of the facade`).toBe(true);
      expect(why.length, `${name}: the reason is a shrug`).toBeGreaterThan(40);
    }
    for (const name of Object.keys(NO_SENTENCE_AT_ALL)) {
      expect(reach.get(name)?.mutates, `${name}: exempted from the door, and it dispatches nothing`).toBe(true);
    }
  });

  it("no screen dispatches its own mutation — the facade is the only door", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        const src = parse(full);
        for (const c of callsIn(src)) {
          if (!/^[A-Za-z.]*engine\.mutate$/.test(calleeName(c))) continue;
          const { line } = src.getLineAndCharacterOfPosition(c.getStart());
          offenders.push(`${path.relative(APP, full)}:${line + 1} dispatches engine.mutate outside state/`);
        }
      }
    };
    // `src/state` is the door itself and `src/engine` is what it dispatches into; the screens
    // are `src/ui` and `app`, which is where a second door would appear.
    walk(path.join(APP, "src", "ui"));
    walk(path.join(APP, "app"));
    expect(offenders).toEqual([]);
  });
});

/**
 * THE LAST WAY A VERB CAN GO SILENT is not in the facade at all: the sentence is raised, handed
 * to the provider, and the provider drops it. A four-deep queue did exactly that — at the cap
 * its writer returned the queue UNCHANGED, so the fifth sentence of a burst was never rendered
 * and nothing recorded that it had been said (owner ruling 2026-09-21: the newest wins, depth
 * one). This arm reads the writer for that shape.
 */
describe("the provider cannot drop a sentence it was handed", () => {
  const WORLD = path.join(APP, "src", "state", "world.tsx");

  /** Does this updater have an arm that yields its own parameter — the "keep, drop the new" shape? */
  const returnsItsInput = (fn: ts.ArrowFunction | ts.FunctionExpression): boolean => {
    const param = fn.parameters[0];
    if (!param || !ts.isIdentifier(param.name)) return false;
    const name = param.name.text;
    let found = false;
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === name && n.parent) {
        const p = n.parent;
        const yielded = ts.isReturnStatement(p)
          || (ts.isConditionalExpression(p) && (p.whenTrue === n || p.whenFalse === n))
          || (ts.isArrowFunction(p) && p.body === n);
        if (yielded) found = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(fn.body);
    return found;
  };

  it("the show door replaces, and has no arm that keeps what stands", () => {
    const src = parse(WORLD);
    const offenders: string[] = [];
    let writers = 0;
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && /^setToast/.test(calleeName(n))) {
        writers += 1;
        const a = n.arguments[0];
        if (a && (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) && returnsItsInput(a)) {
          const { line } = src.getLineAndCharacterOfPosition(n.getStart());
          offenders.push(`src/state/world.tsx:${line + 1} the toast writer can return what already stands — a sentence handed in is dropped`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
    expect(writers, "no toast writer found — the census read nothing").toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });

  it("and the policy it calls never keeps the standing entry", () => {
    // `nextToast` is the door's one decision; driving it is what makes the arm above a reading
    // of a REPLACEMENT rather than of an absence of syntax.
    // Per slot: the incoming entry takes its own slot and the standing one of that slot is gone.
    const standing = { id: 1, say: { say: "toastQueued" } } as never;
    const incoming = { id: 2, say: { say: "toastAside" } } as never;
    expect(nextToast({ action: null, notice: standing }, incoming).notice).toBe(incoming);
  });

  it("the census can see the bounded shape — the positive control", () => {
    const fixture = ts.createSourceFile("fixture.tsx", `
      const f = () => { setToastQueue((q) => (q.length >= 4 ? q : [...q, entry])); };
    `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let seen = false;
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && /^setToast/.test(calleeName(n))) {
        const a = n.arguments[0];
        if (a && ts.isArrowFunction(a) && returnsItsInput(a)) seen = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(fixture);
    expect(seen, "the arm cannot see the very shape it replaced").toBe(true);
  });

  it("and ADMITS a dismiss that keeps a sentence it was not asked about", () => {
    // `afterDismiss(standing, id)` returns `standing` for a STALE id, which is a keep the rule
    // wants: the arm above is about the SHOW door, and reading both the same way would refuse it.
    const fixture = ts.createSourceFile("fixture.tsx", `
      const f = () => { setToastShown((standing) => afterDismiss(standing, id)); };
    `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let seen = false;
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && /^setToast/.test(calleeName(n))) {
        const a = n.arguments[0];
        if (a && ts.isArrowFunction(a) && returnsItsInput(a)) seen = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(fixture);
    expect(seen).toBe(false);
  });
});

describe("the census, watched failing", () => {
  const fixture = (body: string) => {
    const src = ts.createSourceFile("fixture.ts", body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const f = liveActionsBody(src);
    const locals = localsOf(f);
    const out = new Map<string, Reach>();
    for (const v of facadeOf(f)) {
      const impl = ts.isShorthandPropertyAssignment(v.node) ? locals.get(v.name) : v.node;
      out.set(v.name, impl ? reachOf(impl, locals) : { mutates: false, door: false, success: false });
    }
    return out;
  };

  it("catches a verb that dispatches and says nothing", () => {
    const r = fixture(`
      export function liveActions(deps) {
        const park = async (id) => { await engine.mutate({ kind: "triage_set", id }); };
        return { park };
      }`);
    expect(r.get("park")).toEqual({ mutates: true, door: false, success: false });
  });

  it("follows the helper: a verb announcing through two locals is admitted", () => {
    const r = fixture(`
      export function liveActions(deps) {
        const triage = async (m, say) => { toast(say); return said(await engine.mutate(m), null, refuse("liveSaveFailed")); };
        const park = (id) => triage({ kind: "triage_set", id }, refuse("toastAside"));
        return { park };
      }`);
    expect(r.get("park")).toEqual({ mutates: true, door: true, success: true });
  });

  it("a verb that only says what FAILED is not a verb that reported", () => {
    const r = fixture(`
      export function liveActions(deps) {
        const park = async (id) => said(await engine.mutate({ kind: "x" }), null, refuse("liveSaveFailed"));
        return { park };
      }`);
    expect(r.get("park")).toEqual({ mutates: true, door: true, success: false });
    const r2 = fixture(`
      export function liveActions(deps) {
        const park = async (id) => { await engine.mutate({ kind: "x" }); toast(refuse("livePileFailed")); };
        return { park };
      }`);
    expect(r2.get("park")!.success).toBe(false);
  });

  it("ADMITS the ordinary verb — a rule that refused everything would pass the arms above", () => {
    const r = fixture(`
      export function liveActions(deps) {
        const move = async (row, dest) => {
          toast(refuse("toastMoved", dest), undoable(inv));
          return said(await engine.mutate({ kind: "move" }), null, refuse("liveSaveFailed"));
        };
        return { move };
      }`);
    expect(r.get("move")).toEqual({ mutates: true, door: true, success: true });
  });

  it("a read is not a verb: no mutation, no sentence owed", () => {
    const r = fixture(`
      export function liveActions(deps) {
        const hydrate = (id) => { engine.hydrateBody(id); };
        return { hydrate };
      }`);
    expect(r.get("hydrate")).toEqual({ mutates: false, door: false, success: false });
  });
});
