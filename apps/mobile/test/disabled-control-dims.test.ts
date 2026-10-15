/**
 * A control disabled for a screen reader shows the dim face — one rule, Button's, held by the press
 * primitives. Six controls outside Button (the attachment tile, Unsaved's Try again and Discard, the
 * wake rows, the compose remove) read disabled while busy with a full face. Rendered the way
 * `button-ax-state-clears.test.ts` renders; the census asks every control declaring a disabled
 * state to sit on a primitive that dims.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const shims = vi.hoisted(() => {
  const colour = new Proxy({}, { get: () => "#000000" });
  const number = new Proxy({}, { get: () => 8 });
  const style = new Proxy({}, { get: () => ({}) });
  return { theme: { c: colour, radius: number, type: style, lift: () => null } };
});

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return { ...real, useState: (v: unknown) => [v, () => {}], useCallback: (f: unknown) => f };
});
vi.mock("react-native", () => ({
  Pressable: "Pressable",
  RefreshControl: "RefreshControl",
  ScrollView: "ScrollView",
  Text: "Text",
  View: "View",
  StyleSheet: { hairlineWidth: 1 },
  Platform: { OS: "android" },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("../src/ui/posture", () => ({ usePosture: () => ({}) }));
vi.mock("../src/ui/Icon", () => ({ Icon: "Icon" }));
vi.mock("../src/theme", () => ({ useTheme: () => shims.theme }));

import type { PressableProps } from "react-native";
import { Button, Tap, TapRow } from "../src/ui/base";

type El = { type: unknown; props: Record<string, unknown> };

/** The opacity the Pressable paints for one press state: styles flattened, the last one wins. */
function opacityOf(el: El, pressed = false): number | undefined {
  expect(el.type).toBe("Pressable");
  const raw = el.props.style;
  const style = typeof raw === "function" ? (raw as (s: { pressed: boolean }) => unknown)({ pressed }) : raw;
  let out: number | undefined;
  const walk = (s: unknown): void => {
    if (Array.isArray(s)) s.forEach(walk);
    else if (s && typeof s === "object" && "opacity" in s) out = (s as { opacity: number }).opacity;
  };
  walk(style);
  return out;
}

const tap = (props: PressableProps): El => Tap(props) as unknown as El;
const row = (props: PressableProps): El => TapRow(props) as unknown as El;
const button = (props: Parameters<typeof Button>[0]): El => {
  const el = Button(props) as unknown as El;
  expect(el.type, "Button is built on Tap").toBe(Tap);
  return tap(el.props as PressableProps);
};

describe("a control disabled for a screen reader renders the dim face", () => {
  it("Tap dims through either door — Pressable's own disabled or the state key", () => {
    const base = { flexDirection: "row" as const };
    expect(opacityOf(tap({ disabled: true, style: base }))).toBe(0.45);
    expect(opacityOf(tap({ accessibilityState: { disabled: true }, style: () => base }))).toBe(0.45);
    expect(opacityOf(tap({ accessibilityState: { disabled: true } }))).toBe(0.45);
  });

  it("TapRow dims when disabled", () => {
    expect(opacityOf(row({ disabled: true }))).toBe(0.45);
    expect(opacityOf(row({ accessibilityState: { disabled: true } }))).toBe(0.45);
  });

  it("an enabled control keeps its face, and a caller's own press feedback", () => {
    expect(opacityOf(tap({ style: { opacity: 1 } }))).toBe(1);
    expect(opacityOf(tap({ disabled: false, style: ({ pressed }) => ({ opacity: pressed ? 0.6 : 1 }) }), true)).toBe(0.6);
    expect(opacityOf(tap({ accessibilityState: { disabled: false } }))).toBeUndefined();
    expect(opacityOf(row({ disabled: false }))).toBeUndefined();
  });

  it("Button is the same rule: dim when disabled, pressed and resting faces otherwise", () => {
    expect(opacityOf(button({ label: "Send", disabled: true, onPress: () => {} }))).toBe(0.45);
    expect(opacityOf(button({ label: "Send", disabled: true, onPress: () => {} }), true)).toBe(0.45);
    expect(opacityOf(button({ label: "Send", onPress: () => {} }))).toBe(1);
    expect(opacityOf(button({ label: "Send", onPress: () => {} }), true)).toBe(0.86);
  });
});

/* ── THE CENSUS: every control that declares a disabled state sits on a primitive that dims ── */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/* `Segmented` is admitted because each segment IS a `Tap` handed the same `disabled` — driven in
   `auto-act-panel.test.ts`, which renders a disabled one and reads every segment dim. */
const DIMS = new Set(["Button", "Tap", "TapRow", "Segmented"]);

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : filesUnder(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

/** `disabled=`, or `accessibilityState={{ disabled: … }}`: the element says it cannot be pressed. */
function declaresDisabled(attrs: ts.JsxAttributes): boolean {
  return attrs.properties.some((p) => {
    if (!ts.isJsxAttribute(p)) return false;
    const name = p.name.getText();
    if (name === "disabled") return true;
    if (name !== "accessibilityState" || !p.initializer || !ts.isJsxExpression(p.initializer)) return false;
    const e = p.initializer.expression;
    return e !== undefined && ts.isObjectLiteralExpression(e)
      && e.properties.some((q) => q.name !== undefined && q.name.getText() === "disabled");
  });
}

function controlsIn(source: string, file: string): { at: string; tag: string }[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: { at: string; tag: string }[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && declaresDisabled(node.attributes)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      out.push({ at: `${file}:${line}`, tag: node.tagName.getText(sf) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const CONTROLS = ["src", "app"].flatMap((r) => filesUnder(join(ROOT, r)))
  .flatMap((f) => controlsIn(readFileSync(f, "utf8"), relative(ROOT, f)));

describe("no control declares a disabled state on a primitive that keeps its full face", () => {
  it("the census reads the six controls the full face was found on", () => {
    const files = new Set(CONTROLS.map((c) => c.at.replace(/:\d+$/, "")));
    for (const f of ["src/ui/MessageReader.tsx", "src/ui/UnsavedChanges.tsx", "app/settings.tsx", "src/ui/MessageActions.tsx"]) {
      expect(files, f).toContain(f);
    }
    expect(CONTROLS.length).toBeGreaterThanOrEqual(20);
  });

  it("every one is a Button, a Tap, a TapRow or a Segmented", () => {
    expect(CONTROLS.filter((c) => !DIMS.has(c.tag))).toEqual([]);
  });

  it("the census refuses a raw Pressable and admits the primitives, driven", () => {
    const tags = (src: string) => controlsIn(src, "fixture.tsx").map((c) => c.tag);
    expect(tags("const x = <Pressable disabled={busy} />;")).toEqual(["Pressable"]);
    expect(tags("const x = <Pressable accessibilityState={{ disabled: busy }}>a</Pressable>;")).toEqual(["Pressable"]);
    expect(tags("const x = <Tap accessibilityState={{ selected: on }} />;")).toEqual([]);
    expect(tags("const x = <TapRow disabled={busy} />;")).toEqual(["TapRow"]);
  });
});
