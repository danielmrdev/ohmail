/**
 * THE PROVIDER'S CLOCK WIRING, DRIVEN. `world-clock.test.ts` drives the edge and the timer; this runs
 * the hook the provider calls (`use-lists-clock.ts`) through a minimal hook runner, and reads the
 * provider for the two lines that make the beat reach the lists: the beat among the projection's
 * dependencies, and a real clock handed to every run. Removing the arm, dropping the beat from the
 * deps or pinning the clock each goes red here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  states: [] as unknown[], idx: 0, effects: [] as Array<{ deps: unknown[]; cleanup?: () => void }>, eidx: 0,
  appState: [] as Array<(s: string) => void>,
}));
vi.mock("react", () => ({
  useState: (init: unknown) => {
    const i = h.idx++;
    if (!(i in h.states)) h.states[i] = typeof init === "function" ? (init as () => unknown)() : init;
    return [h.states[i], (v: unknown) => { h.states[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(h.states[i]) : v; }];
  },
  useEffect: (fn: () => (() => void) | undefined, deps: unknown[]) => {
    const i = h.eidx++;
    const prev = h.effects[i];
    if (prev && deps.every((d, k) => Object.is(d, prev.deps[k]))) return;
    prev?.cleanup?.();
    h.effects[i] = { deps, cleanup: fn() ?? undefined };
  },
}));
vi.mock("react-native", () => ({
  AppState: { addEventListener: (_e: string, cb: (s: string) => void) => { h.appState.push(cb); return { remove() { h.appState = h.appState.filter((x) => x !== cb); } }; } },
}));
vi.mock("../src/state/live", async () => {
  const engine = await import("@ohmail/client-engine");
  return {
    readerZone: () => "Europe/Zurich",
    zonedFields: engine.zonedFields, zonedInstant: engine.zonedInstant,
    HELD_SEND_RECHECK_MS: engine.HELD_SEND_RECHECK_MS, SENDING_STALE_AFTER_MS: engine.SENDING_STALE_AFTER_MS,
  };
});

import { useListsClock } from "../src/state/use-lists-clock";

const engine = { read: () => ({ list: () => [] }) as never };
/* Stable, as the provider's `setZone` is: a fresh callback per render would re-arm on every render. */
const onZone = () => {};
const render = (derivedStamp = 1) => { h.idx = 0; h.eidx = 0; return useListsClock({ engine, zone: "Europe/Zurich", derivedStamp, onZone }); };

afterEach(() => {
  for (const e of h.effects) e?.cleanup?.();
  h.states = []; h.effects = []; h.appState = [];
  vi.useRealTimers();
});

describe("the provider's clock beat", () => {
  it("moves at the next local midnight with nothing else changing, and again the night after", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(Date.UTC(2026, 8, 29, 21, 50)); // 23:50 Zurich
    expect(render()).toBe(0);
    vi.advanceTimersByTime(9 * 60_000);
    expect(render(), "the beat moved before midnight").toBe(0);
    vi.advanceTimersByTime(2 * 60_000);
    expect(render(), "no beat at midnight: the lists keep yesterday's day").toBe(1);
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(render(), "the clock was not armed again after its tick").toBe(2);
  });

  it("a resume past the edge beats at once", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); // timers that never fire, as on a phone asleep
    vi.setSystemTime(Date.UTC(2026, 8, 29, 21, 50));
    render();
    vi.setSystemTime(Date.UTC(2026, 8, 29, 22, 30));
    for (const cb of h.appState) cb("active");
    expect(render()).toBe(1);
  });
});

describe("the provider hands the beat and a real clock to its projection", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/state/world.tsx", import.meta.url)), "utf8");
  const sf = ts.createSourceFile("world.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let memo: ts.CallExpression | null = null;
  const walk = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.name.getText(sf) === "projected" && n.initializer && ts.isCallExpression(n.initializer)) memo = n.initializer;
    ts.forEachChild(n, walk);
  };
  walk(sf);
  it("the projection's dependencies carry the beat", () => {
    expect(memo, "no projected memo in world.tsx").not.toBeNull();
    const deps = (memo as unknown as ts.CallExpression).arguments[1]!;
    expect(ts.isArrayLiteralExpression(deps) && deps.elements.map((e) => e.getText(sf))).toContain("clockBeat");
  });
  it("every run reads the clock at the run, never a pinned instant", () => {
    const body = (memo as unknown as ts.CallExpression).arguments[0]!.getText(sf);
    expect(body).toContain("now: new Date(),");
    expect(src).toContain("const clockBeat = useListsClock({ engine, zone, derivedStamp, onZone: setZone });");
  });
});
