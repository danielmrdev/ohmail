/**
 * A RENDER ERROR IS CAUGHT, NOT FATAL. 23 of 27 crash reports on the build Mac were ONE render
 * error reaching `RCTExceptionsManager.reportFatal`, which aborts a release build. Held here with
 * no React Native renderer: THE LINE (class, scrubbed message, first frame, the engine's shape,
 * never a thrown object's contents, once through the sink); THE CLASS, driven as functions
 * (children under a Fragment keyed on the generation, the fallback with Retry, Retry as the
 * transition that moves the key); THE COPY in both decks with a label for every surface; and THE
 * CENSUS — every route rooted at a `SurfaceBoundary` naming a known surface, the shell root
 * around the navigator, both `renderDetail` slots, the composer sheet, the `__DEV__` door — its
 * helper driven against fixtures that MUST refuse before the tree is believed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { Fragment, isValidElement } from "react";
import { DECKS } from "../src/copy";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import {
  ErrorBoundary,
  MAX_ERROR_TEXT,
  RENDER_ERROR_EVENT,
  RENDER_ERROR_SERVICE,
  SURFACES,
  describeCaught,
  firstFrame,
  noteRenderError,
  renderErrorLine,
  retried,
  scrubErrorText,
  surfaceLabel,
  type FallbackProps,
  type Surface,
} from "../src/ui/error-boundary";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

const REACT18_STACK = "\n    in GlassActionBar (created by MessageActions)\n    in MessageActions (created by MessageReader)";
const REACT19_STACK = "\n    at GlassActionBar (address at index.bundle:1:2)\n    at MessageActions";

/* ── the line ────────────────────────────────────────────────────────────────────────────── */

describe("what the line carries", () => {
  it("names the class, the message and the innermost frame — in both stack spellings", () => {
    const err = new TypeError("Cannot read property 'layout' of null");
    expect(describeCaught(err, REACT18_STACK)).toEqual({
      errorClass: "TypeError",
      errorText: "Cannot read property 'layout' of null",
      frame: "GlassActionBar",
    });
    expect(firstFrame(REACT19_STACK)).toBe("GlassActionBar");
    expect(firstFrame(null)).toBeNull();
    expect(firstFrame("")).toBeNull();
  });

  it("replaces an address and a long digit run, and bounds the text", () => {
    /* Built, not spelled: no address literal lives in this file. */
    const address = ["someone", "example.org"].join("@");
    const scrubbed = scrubErrorText(`mailbox ${address} refused 12345678 times`);
    expect(scrubbed).toBe("mailbox [address] refused [digits] times");
    expect(scrubbed).not.toContain("someone");
    const long = scrubErrorText("x".repeat(MAX_ERROR_TEXT * 3));
    expect(long.length).toBe(MAX_ERROR_TEXT + 1);
    expect(long.endsWith("…")).toBe(true);
  });

  it("describes a thrown non-Error by its type and never prints an object", () => {
    const address = ["props", "example.org"].join("@");
    const props = { subject: "the whole body of a message", to: address };
    const fromObject = describeCaught(props, undefined);
    expect(fromObject).toEqual({ errorClass: "Object", errorText: "[object]", frame: null });
    const line = renderErrorLine("reader", fromObject);
    expect(line).not.toContain("subject");
    expect(line).not.toContain("props");
    expect(describeCaught("a thrown string", undefined).errorClass).toBe("String");
    expect(describeCaught("a thrown string", undefined).errorText).toBe("a thrown string");
    expect(describeCaught(null, undefined)).toEqual({ errorClass: "Null", errorText: "[null]", frame: null });
    expect(describeCaught(42, undefined)).toEqual({ errorClass: "Number", errorText: "42", frame: null });
  });

  it("is the engine's shape: ts, level, service, event, then exactly the payload keys", () => {
    const now = () => new Date("2026-09-22T05:00:00.000Z");
    const line = renderErrorLine("reader", describeCaught(new RangeError("too deep"), REACT18_STACK), now);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["ts", "level", "service", "event", "surface", "errorClass", "errorText", "frame"]);
    expect(parsed).toMatchObject({
      ts: "2026-09-22T05:00:00.000Z",
      level: "error",
      service: RENDER_ERROR_SERVICE,
      event: RENDER_ERROR_EVENT,
      surface: "reader",
      errorClass: "RangeError",
      errorText: "too deep",
      frame: "GlassActionBar",
    });
    const noFrame = JSON.parse(renderErrorLine("shell", describeCaught(new Error("x"), null), now)) as Record<string, unknown>;
    expect("frame" in noFrame).toBe(false);
  });

  it("reaches the sink exactly once", () => {
    const lines: string[] = [];
    noteRenderError("composer", new Error("once"), REACT18_STACK, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ event: RENDER_ERROR_EVENT, surface: "composer", errorClass: "Error" });
  });
});

/* ── the class ───────────────────────────────────────────────────────────────────────────── */

function boundary(sink: (l: string) => void) {
  const fallbacks: FallbackProps[] = [];
  const b = new ErrorBoundary({
    surface: "reader",
    children: "the guarded child",
    renderFallback: (p) => { fallbacks.push(p); return "the fallback"; },
    sink,
    now: () => new Date("2026-09-22T05:00:00.000Z"),
  });
  return { b, fallbacks };
}

describe("the class, driven as functions", () => {
  it("renders the children under a Fragment keyed on the generation", () => {
    const { b } = boundary(() => {});
    const out = b.render();
    expect(isValidElement(out)).toBe(true);
    const el = out as { type: unknown; key: string | null; props: { children: unknown } };
    expect(el.type).toBe(Fragment);
    expect(el.key).toBe("0");
    expect(el.props.children).toBe("the guarded child");
  });

  it("marks the failure from the thrown value and renders the fallback with Retry", () => {
    const { b, fallbacks } = boundary(() => {});
    expect(ErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    b.state = { failed: true, generation: 0 };
    expect(b.render()).toBe("the fallback");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].surface).toBe("reader");
    expect(fallbacks[0].onRetry).toBe(b.retry);
  });

  it("logs once from componentDidCatch, with the frame the renderer handed it", () => {
    const lines: string[] = [];
    const { b } = boundary((l) => lines.push(l));
    b.componentDidCatch(new TypeError("boom"), { componentStack: REACT19_STACK });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ surface: "reader", errorClass: "TypeError", errorText: "boom", frame: "GlassActionBar" });
  });

  it("Retry clears the failure and moves the key — the remount", () => {
    const { b } = boundary(() => {});
    b.state = retried({ failed: true, generation: 3 });
    expect(b.state).toEqual({ failed: false, generation: 4 });
    const el = b.render() as { key: string | null };
    expect(el.key).toBe("4");
  });
});

/* ── the copy ────────────────────────────────────────────────────────────────────────────── */

describe("the copy", () => {
  const KEYS = ["renderErrorTitle", "renderErrorRetry", "renderErrorSurfaceShell", "renderErrorSurfaceReader",
    "renderErrorSurfaceComposer", "renderErrorSurfaceScreen"] as const;

  it("both decks carry the sentence, the verb and the surface names, translated", () => {
    for (const k of KEYS) {
      expect(DECKS.en[k].length, k).toBeGreaterThan(3);
      expect(DECKS.de[k].length, k).toBeGreaterThan(3);
      expect(DECKS.de[k], `${k} left in English`).not.toBe(DECKS.en[k]);
    }
    expect(DECKS.en.renderErrorWhere("Ohbox")).toBe("Ohbox could not be drawn.");
    expect(DECKS.de.renderErrorWhere("Ohbox")).toBe("Ohbox konnte nicht gezeichnet werden.");
  });

  it("every surface has a label in each language, read live", () => {
    try {
      for (const locale of ["en", "de"] as const) {
        setActiveLocale(locale);
        for (const s of SURFACES) {
          const label = surfaceLabel(s);
          expect(typeof label, `${s} under ${locale}`).toBe("string");
          expect(label.length, `${s} under ${locale}`).toBeGreaterThan(1);
        }
      }
      setActiveLocale("de");
      expect(surfaceLabel("reader")).toBe(DECKS.de.renderErrorSurfaceReader);
      setActiveLocale("en");
      expect(surfaceLabel("reader")).toBe(DECKS.en.renderErrorSurfaceReader);
    } finally {
      resetLocaleRegisterForTests();
    }
  });
});

/* ── the census ──────────────────────────────────────────────────────────────────────────── */

const parse = (file: string, text = fs.readFileSync(file, "utf8")): ts.SourceFile =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.TSX);

const tagOf = (n: ts.Node): string | null =>
  ts.isJsxSelfClosingElement(n) ? n.tagName.getText()
    : ts.isJsxElement(n) ? n.openingElement.tagName.getText()
    : null;

/** A JSX attribute's string value, or null when absent or not a plain string. */
function attr(n: ts.Node, name: string): string | null {
  const attrs = ts.isJsxSelfClosingElement(n) ? n.attributes
    : ts.isJsxElement(n) ? n.openingElement.attributes
    : null;
  if (attrs === null) return null;
  for (const p of attrs.properties) {
    if (ts.isJsxAttribute(p) && p.name.getText() === name && p.initializer && ts.isStringLiteral(p.initializer)) {
      return p.initializer.text;
    }
  }
  return null;
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out);
    else if (e.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const routeFiles = (): string[] =>
  walkFiles(path.join(APP, "app")).filter((f) => path.basename(f) !== "_layout.tsx").sort();

/**
 * The route rule: the default export is a function whose returned JSX is rooted at
 * `<SurfaceBoundary surface="<known>">`. Answers the reason it refuses, or null when admitted.
 */
function routeVerdict(sf: ts.SourceFile): string | null {
  let fn: ts.FunctionDeclaration | null = null;
  sf.forEachChild((n) => {
    if (ts.isFunctionDeclaration(n) && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) fn = n;
  });
  if (fn === null) return "no default export function";
  const body = (fn as ts.FunctionDeclaration).body;
  if (!body) return "default export without a body";
  const roots: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isReturnStatement(n) && n.expression) {
      let e: ts.Node = n.expression;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      roots.push(e);
      return;
    }
    // A nested function's returns are not this function's.
    if (ts.isFunctionLike(n)) return;
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  const jsxRoots = roots.filter((r) => tagOf(r) !== null);
  if (jsxRoots.length === 0) return "the default export returns no JSX";
  for (const r of jsxRoots) {
    if (tagOf(r) !== "SurfaceBoundary") return `a return is rooted at <${tagOf(r)}>, not <SurfaceBoundary>`;
    const s = attr(r, "surface");
    if (s === null) return "a SurfaceBoundary names no surface as a string";
    if (!(SURFACES as readonly string[]).includes(s)) return `unknown surface "${s}"`;
  }
  return null;
}

/** Every JSX ancestor of `n` carrying tag `tag`, innermost first. */
function ancestorsTagged(n: ts.Node, tag: string): ts.Node[] {
  const out: ts.Node[] = [];
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (tagOf(p) === tag) out.push(p);
  return out;
}

function findAll(sf: ts.SourceFile, pick: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const walk = (n: ts.Node): void => { if (pick(n)) out.push(n); ts.forEachChild(n, walk); };
  walk(sf);
  return out;
}

describe("the census: every surface stands under a boundary", () => {
  it("the route rule refuses the fixtures it exists for, and admits the shape the tree uses", () => {
    const admit = `import { SurfaceBoundary } from "../src/ui/ErrorBoundary";
export default function AScreen() { useLocale(); return (<SurfaceBoundary surface="away"><Gated><ABody /></Gated></SurfaceBoundary>); }
function ABody() { return <View />; }`;
    expect(routeVerdict(parse("a.tsx", admit))).toBeNull();
    const bare = `export default function AScreen() { return (<Gated><ABody /></Gated>); }`;
    expect(routeVerdict(parse("a.tsx", bare))).toContain("not <SurfaceBoundary>");
    const unknown = `export default function AScreen() { return <SurfaceBoundary surface="kitchen"><A /></SurfaceBoundary>; }`;
    expect(routeVerdict(parse("a.tsx", unknown))).toContain('unknown surface "kitchen"');
    const dynamic = `export default function AScreen() { return <SurfaceBoundary surface={s}><A /></SurfaceBoundary>; }`;
    expect(routeVerdict(parse("a.tsx", dynamic))).toContain("names no surface");
    const twoReturns = `export default function AScreen() { if (x) return <Redirect href="/" />; return <SurfaceBoundary surface="away"><A /></SurfaceBoundary>; }`;
    expect(routeVerdict(parse("a.tsx", twoReturns))).toContain("rooted at <Redirect>");
    const none = `export function AScreen() { return <SurfaceBoundary surface="away"><A /></SurfaceBoundary>; }`;
    expect(routeVerdict(parse("a.tsx", none))).toBe("no default export function");
  });

  it("every route file's default export is rooted at a SurfaceBoundary naming a known surface", () => {
    const files = routeFiles();
    expect(files.length, "the route census parsed nothing").toBeGreaterThanOrEqual(20);
    const offenders: string[] = [];
    for (const f of files) {
      const why = routeVerdict(parse(f));
      if (why !== null) offenders.push(`${path.relative(APP, f)}: ${why}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the shell root wraps the navigator, and the toast stays outside to keep drawing", () => {
    const sf = parse(path.join(APP, "app", "_layout.tsx"));
    const shells = findAll(sf, (n) => tagOf(n) === "SurfaceBoundary" && attr(n, "surface") === "shell");
    expect(shells).toHaveLength(1);
    const stacks = findAll(sf, (n) => tagOf(n) === "Stack");
    expect(stacks.length).toBeGreaterThanOrEqual(1);
    for (const s of stacks) expect(ancestorsTagged(s, "SurfaceBoundary")).toHaveLength(1);
    const toasts = findAll(sf, (n) => tagOf(n) === "Toast");
    expect(toasts).toHaveLength(1);
    expect(ancestorsTagged(toasts[0], "SurfaceBoundary")).toHaveLength(0);
  });

  it("the one renderDetail slot sits under the reader's boundary, keyed on the selection", () => {
    /* One slot on every posture since the pair became one tree (the reader no longer renders in a
       second, full-window branch that a fold swapped it into). */
    const sf = parse(path.join(APP, "src", "ui", "list-detail.tsx"));
    const calls = findAll(sf, (n) => ts.isCallExpression(n) && n.expression.getText() === "renderDetail");
    expect(calls).toHaveLength(1);
    for (const c of calls) {
      const b = ancestorsTagged(c, "SurfaceBoundary");
      expect(b.length, c.getText()).toBeGreaterThanOrEqual(1);
      expect(attr(b[0], "surface")).toBe("reader");
      const hasKey = (ts.isJsxElement(b[0]) ? b[0].openingElement.attributes : (b[0] as ts.JsxSelfClosingElement).attributes)
        .properties.some((p) => ts.isJsxAttribute(p) && p.name.getText() === "key");
      expect(hasKey, "the reader boundary is keyed on the open selection").toBe(true);
    }
  });

  it("the composer sheet sits under the composer's boundary, in the sheet frame", () => {
    const sf = parse(path.join(APP, "src", "ui", "MessageActions.tsx"));
    const sheets = findAll(sf, (n) => tagOf(n) === "ComposeSheet");
    expect(sheets).toHaveLength(1);
    const b = ancestorsTagged(sheets[0], "SurfaceBoundary");
    expect(b).toHaveLength(1);
    expect(attr(b[0], "surface")).toBe("composer");
    expect(attr(b[0], "frame")).toBe("sheet");
  });

  it("the development trigger is reached only through the __DEV__ door", () => {
    const door = path.join(APP, "src", "dev", "render-error-trigger-door.ts");
    const sf = parse(door);
    const requires = findAll(sf, (n) => ts.isCallExpression(n) && n.expression.getText() === "require");
    expect(requires).toHaveLength(1);
    let guard: ts.IfStatement | null = null;
    for (let p: ts.Node | undefined = requires[0].parent; p; p = p.parent) if (ts.isIfStatement(p)) { guard = p; break; }
    expect(guard, "the require stands in no if statement").not.toBeNull();
    const cond = (guard as ts.IfStatement).expression;
    const bare = findAll(cond as unknown as ts.SourceFile, (n) => ts.isIdentifier(n) && n.text === "__DEV__"
      && !(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n));
    expect(bare.length, "the guard reads the bare __DEV__ identifier Metro inlines").toBeGreaterThanOrEqual(1);
    // Nobody else imports the trigger module: the reader route imports the DOOR.
    const all = [...walkFiles(path.join(APP, "src")), ...walkFiles(path.join(APP, "app")),
      ...fs.readdirSync(path.join(APP, "src", "dev")).map((f) => path.join(APP, "src", "dev", f))]
      .filter((f) => /\.tsx?$/.test(f));
    const importers: string[] = [];
    for (const f of new Set(all)) {
      const text = fs.readFileSync(f, "utf8");
      if (/render-error-trigger"/.test(text) && path.resolve(f) !== path.resolve(door)) importers.push(path.relative(APP, f));
    }
    expect(importers).toEqual([]);
    const reader = fs.readFileSync(path.join(APP, "app", "message", "[id].tsx"), "utf8");
    expect(reader).toContain('from "../../src/dev/render-error-trigger-door"');
  });

  it("the closed set of surfaces is what the routes use", () => {
    const used = new Set<string>();
    for (const f of routeFiles()) {
      for (const n of findAll(parse(f), (n) => tagOf(n) === "SurfaceBoundary")) {
        const s = attr(n, "surface");
        if (s !== null) used.add(s);
      }
    }
    for (const s of used) expect(SURFACES as readonly string[]).toContain(s);
    const unused = (SURFACES as readonly Surface[]).filter((s) => !used.has(s) && !["shell", "composer"].includes(s));
    expect(unused, "a surface named in the set but wrapped nowhere").toEqual([]);
  });
});
