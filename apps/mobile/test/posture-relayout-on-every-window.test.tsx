/** @vitest-environment jsdom */
/**
 * THE LAYOUT DERIVES FROM THE CURRENT WINDOW, rendered. A size and a density change
 * arriving together left React's root laid out in the old dp at the new density: the second change
 * moved no pixel, so nothing measured again. The provider asks the native module to measure the root
 * again on every window change — size, density or text scale — and this drives it through each.
 * The native half (`OhmailPostureModule.relayoutRoot`, and the fold's dp read per reading) is held
 * by its source below; the device harness is its measurement.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mount } from "./_rendered-dom";

const win = vi.hoisted(() => ({ width: 718, height: 897, scale: 2.4625, fontScale: 1 }));
const native = vi.hoisted(() => ({
  relayouts: 0,
  /* What each root measure was told about the screens' frames. */
  screens: [] as boolean[],
  /* iOS's surface refresh: absent (Android), or a promise the test settles by hand. */
  ios: false,
  refreshes: [] as (() => void)[],
}));
vi.mock("react-native", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return {
    ...rnDom,
    useWindowDimensions: () => ({ ...win }),
    Dimensions: { get: () => ({ width: win.width, height: win.height }) },
  };
});
vi.mock("react-native-safe-area-context", async () => ({ SafeAreaInsetsContext: (await import("react")).createContext(null) }));
vi.mock("../src/engine/engine-log", () => ({ logPostureDerived: () => undefined, logTextScaleRefresh: () => undefined }));
vi.mock("../src/ui/posture/posture-native", () => ({
  nativePosture: () => ({
    getFolds: () => [],
    getHasFold: () => true,
    getLaunchOverride: () => null,
    relayoutRoot: (screens: boolean) => { native.relayouts += 1; native.screens.push(screens); return true; },
    ...(native.ios
      ? { refreshTextScale: () => new Promise((res) => native.refreshes.push(() => res({ category: "x", surfaces: 1 }))) }
      : {}),
  }),
}));

const { PostureProvider, usePosture } = await import("../src/ui/posture");
const { useTextEpoch } = await import("../src/theme/text-epoch");

/* What each render saw: the epoch beside how many root measures had run by then. */
const seen: { epoch: number; relayouts: number }[] = [];
function Probe() {
  const p = usePosture();
  seen.push({ epoch: useTextEpoch(), relayouts: native.relayouts });
  return <div data-testid="panes" data-panes={p.panes} />;
}
const tree = () => <PostureProvider><Probe /></PostureProvider>;

describe("every window change re-measures the root", () => {
  it("a size change, a density change alone, both together, and a text scale each ask once", () => {
    const r = mount(tree());
    const after = (change: Partial<typeof win>) => {
      const before = native.relayouts;
      Object.assign(win, change);
      r.render(tree());
      return native.relayouts - before;
    };
    expect(native.relayouts, "the first layout").toBe(1);
    expect(after({ width: 353, height: 792 }), "a fold: the size").toBe(1);
    expect(after({ scale: 3 }), "a density change alone moves no dp the provider sees in width").toBe(1);
    expect(after({ width: 800, height: 1280, scale: 2 }), "size and density together").toBe(1);
    expect(after({ fontScale: 1.3 })).toBe(1);
    expect(after({}), "nothing changed: no measure").toBe(0);
    /* the screens' frames are asked for after the two density changes only */
    expect(native.screens.slice(-5)).toEqual([false, false, true, true, false]);
    r.unmount();
  });
});

describe("every text is measured again after a density or text-size change", () => {
  it("the epoch moves once per such change, never before that change's root measure, and not for a size alone", () => {
    Object.assign(win, { width: 718, height: 897, scale: 2.4625, fontScale: 1 });
    seen.length = 0;
    const r = mount(tree());
    const epochNow = () => seen[seen.length - 1]!.epoch;
    const at = epochNow();
    const change = (c: Partial<typeof win>) => { Object.assign(win, c); r.render(tree()); };
    change({ width: 353, height: 792 });
    expect(epochNow(), "a fold moves no text").toBe(at);
    const measured = native.relayouts;
    change({ width: 800, height: 1280, scale: 2 });
    expect(epochNow()).toBe(at + 1);
    const first = seen.find((v) => v.epoch === at + 1)!;
    expect(first.relayouts, "the text pass follows the root's density").toBeGreaterThan(measured);
    change({ fontScale: 1.3 });
    expect(epochNow()).toBe(at + 2);
    r.unmount();
  });
});

describe("on iOS the surface re-reads the text size before the text pass", () => {
  it("the epoch waits for the surface's answer, then moves once", async () => {
    Object.assign(win, { width: 440, height: 956, scale: 3, fontScale: 1 });
    native.ios = true; native.refreshes.length = 0; seen.length = 0;
    const r = mount(tree());
    const epochNow = () => seen[seen.length - 1]!.epoch;
    const at = epochNow();
    Object.assign(win, { fontScale: 3.571 });
    r.render(tree());
    expect(native.refreshes.length, "the surface was asked").toBe(1);
    expect(epochNow(), "no text pass before the surface answered").toBe(at);
    const { act } = await import("react");
    await act(async () => { native.refreshes[0]!(); await Promise.resolve(); });
    expect(epochNow()).toBe(at + 1);
    r.unmount();
    native.ios = false;
  });
});

describe("the native half reads the density it lays out in", () => {
  const kt = readFileSync(join(__dirname, "../modules/ohmail-posture/android/src/main/java/app/ohmail/posture/OhmailPostureModule.kt"), "utf8");
  it("relayoutRoot forces a measure of React's root", () => {
    expect(kt).toContain('Function("relayoutRoot")');
    expect(kt).toMatch(/v\.forceLayout\(\)\s*\n\s*v\.requestLayout\(\)/);
  });
  it("the fold's dp is read with the density of each reading, never one read at foreground", () => {
    const collect = kt.slice(kt.indexOf(".collect { info ->"));
    expect(collect.slice(0, collect.indexOf("sendEvent("))).toContain("val density = activity.resources.displayMetrics.density");
  });
});
