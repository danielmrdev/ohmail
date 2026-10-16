/**
 * THE STANDALONE DOOR'S FORM ENDS ABOVE THE KEYBOARD (Android and iOS). On a 411 dp
 * phone the focused SMTP port sat half under the keyboard and Connect could not be scrolled above
 * it: the window is drawn edge to edge, so the keyboard resizes nothing. A scroller asked to
 * `avoidKeyboard` is shortened by the keyboard's height on Android (`keyboard-room.tsx`) and insets
 * its content by it on iOS (`automaticallyAdjustKeyboardInsets`, measured in window coordinates,
 * which scrolls the focused field into view). Rendered the way `segment-face-renders.test.ts`
 * renders; the rig's frames are the acceptance on a device.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

const shims = vi.hoisted(() => {
  const colour = new Proxy({}, { get: () => "#000000" });
  const number = new Proxy({}, { get: () => 8 });
  return { os: "android" as string, keyboard: 0, theme: { c: colour, radius: number, space: number, type: {}, lift: () => null } };
});
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return { ...real, useState: (v: unknown) => [shims.keyboard || v, () => {}], useEffect: () => {} };
});
vi.mock("react-native", () => ({
  Pressable: "Pressable", Text: "Text", View: "View", ScrollView: "ScrollView", RefreshControl: "RefreshControl",
  StyleSheet: { hairlineWidth: 1 }, Keyboard: { addListener: () => ({ remove() {} }) },
  Platform: { get OS() { return shims.os; } },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) }));
vi.mock("../src/ui/posture", () => ({ usePosture: () => ({}) }));
vi.mock("../src/ui/bottom-chrome", () => ({ useBottomChromeExtent: () => 0 }));
vi.mock("../src/ui/nav-drawn", () => ({ useNavDrawn: () => true }));
vi.mock("../src/ui/list-insets", () => ({ listInsets: () => ({}) }));
vi.mock("../src/ui/scaffold/plan", async (importOriginal) => ({
  ...(await importOriginal<object>()), scaffoldPlan: () => ({}), listNavClearance: () => 0,
}));
vi.mock("../src/ui/Icon", () => ({ Icon: "Icon" }));
vi.mock("../src/theme", () => ({ useTheme: () => shims.theme }));

import { Scroller } from "../src/ui/base";
import { KeyboardRoom } from "../src/ui/keyboard-room";

type El = { type: unknown; props: Record<string, unknown> };
const flat = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean).map(flat)) : ((style as Record<string, unknown>) ?? {});
const render = (os: string, avoidKeyboard?: boolean) => {
  shims.os = os;
  return Scroller({ children: "form", ...(avoidKeyboard === undefined ? {} : { avoidKeyboard }) }) as unknown as El;
};

describe("a scroller asked to avoid the keyboard", () => {
  it("Android: it stands in the keyboard's room, and the room is shortened by the keyboard's height", () => {
    const el = render("android", true);
    expect(el.type).toBe(KeyboardRoom);
    const inner = el.props.children as El;
    expect(inner.type).toBe("ScrollView");
    expect(inner.props.keyboardShouldPersistTaps).toBe("handled");
    shims.keyboard = 812;
    const room = KeyboardRoom({ children: "x" }) as unknown as El;
    shims.keyboard = 0;
    expect(flat(room.props.style)).toMatchObject({ flex: 1, paddingBottom: 812 });
  });
  it("iOS: the scroll view insets its content by the keyboard itself, and a press lands with it up", () => {
    const el = render("ios", true);
    expect(el.type).toBe("ScrollView");
    expect(el.props.automaticallyAdjustKeyboardInsets).toBe(true);
    expect(el.props.keyboardShouldPersistTaps).toBe("handled");
  });
  it("control: a scroller not asked keeps its frame on both platforms", () => {
    for (const os of ["android", "ios"]) {
      const el = render(os);
      expect(el.type, os).toBe("ScrollView");
      expect(el.props.automaticallyAdjustKeyboardInsets, os).toBeFalsy();
    }
  });
});

const read = (rel: string) => withoutComments(readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8"));
const STANDALONE = read("app/standalone.tsx");
const SETTINGS = read("app/settings.tsx");

describe("the forms that ask for it", () => {
  it("the standalone door's credentials step, and not its limitations step, which has no field", () => {
    const limits = STANDALONE.slice(STANDALONE.indexOf("function Limitations("), STANDALONE.indexOf("function Credentials("));
    const creds = STANDALONE.slice(STANDALONE.indexOf("function Credentials("));
    expect(limits).toContain("<Scroller bounded>");
    expect(creds).toContain("<Scroller bounded avoidKeyboard>");
  });
  it("the settings screen, whose server form carries the same port fields", () => {
    expect(SETTINGS).toContain("<Scroller bounded avoidKeyboard>");
    expect(SETTINGS).toContain('setTyped(f, "smtpPort", v)');
  });
});
