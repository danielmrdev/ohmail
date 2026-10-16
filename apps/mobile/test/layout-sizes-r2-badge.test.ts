/**
 * THE DOCK BADGE IS SIZED FROM THE TEXT SCALE IT DRAWS AT (on iOS and on Android).
 * The pill was a fixed 16 around digits the OS scaled: at Accessibility XL the digits were cut at the
 * top, at font 2.0 they printed below the pill. Read from the element GlassIconButton renders: the
 * pill's height and the digits' size come from one number, and the OS scales nothing on its own.
 *
 * MUTATIONS WATCHED: the pill's `height` back to 16, and `allowFontScaling={false}` dropped — each RED.
 */
import { describe, expect, it, vi } from "vitest";

const rig = vi.hoisted(() => ({ fontScale: 1 }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" }, View: "View", Text: "Text",
  useWindowDimensions: () => ({ width: 411, height: 900, scale: 2.6, fontScale: rig.fontScale }),
}));
vi.mock("../src/theme", () => ({
  useTheme: () => ({
    c: new Proxy({}, { get: () => "#000" }), radius: { pill: 99 }, textCap: 100, textKey: 0.5,
    type: { badge: { fontSize: 11.5, fontWeight: "500" }, button: {} },
  }),
}));
vi.mock("../src/ui/Icon", () => ({ Icon: "Icon" }));
vi.mock("../src/ui/base", () => ({ Tap: "Tap" }));

import { GlassIconButton } from "../src/ui/glass/GlassIconButton";
import { BADGE_SCALE_CAP, badgeAtScale } from "../src/theme/type";

type El = { type: unknown; props: Record<string, unknown> };
function walk(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  if (node && typeof node === "object" && "props" in node) { out.push(node as El); walk((node as El).props.children, out); }
  return out;
}
const flat = (s: unknown): Record<string, unknown> =>
  Array.isArray(s) ? Object.assign({}, ...s.filter(Boolean).map(flat)) : ((s as Record<string, unknown>) ?? {});

function badgeAt(fontScale: number) {
  rig.fontScale = fontScale;
  const tree = walk(GlassIconButton({ icon: "inbox" as never, label: "Ohbox, 43 unread", badge: 43, badgeHot: true }));
  const text = tree.find((e) => e.type === "Text")!;
  const pill = tree.find((e) => e.type === "View" && walk(e.props.children).includes(text))!;
  return { pill: flat(pill.props.style), text: flat(text.props.style), scales: text.props.allowFontScaling };
}

describe("the badge's pill holds its digits at every text size", () => {
  for (const scale of [1, 1.3, 2, 3.571]) {
    it(`font scale ${scale}: the pill is the digits' line plus its ring, and the OS scales nothing on its own`, () => {
      const { pill, text, scales } = badgeAt(scale);
      expect(scales, "the OS would scale the digits again on top of the size given").toBe(false);
      expect(text.fontSize).toBe(badgeAtScale(scale).text.fontSize);
      expect(pill.height as number, "the digits' line does not fit the pill").toBeGreaterThanOrEqual((text.lineHeight as number) + 3);
      expect(pill.minWidth).toBe(pill.height);
    });
  }
  it("the scale is capped, so a count never outgrows the 44pt button it sits on", () => {
    expect(badgeAtScale(3.571).text.fontSize).toBe(Math.round(11.5 * BADGE_SCALE_CAP * 10) / 10);
    expect(badgeAtScale(3.571).height).toBeLessThanOrEqual(26);
    expect(badgeAtScale(1)).toEqual({ text: { fontSize: 11.5, lineHeight: 14 }, height: 17 });
    expect(badgeAtScale(Number.NaN).text.fontSize, "an unreadable scale draws the base size").toBe(11.5);
  });
});
