/**
 * A PRESSABLE CONTROL ADVERTISES A ROLE iOS ACTUALLY CARRIES. React Native maps `tab` to no iOS
 * trait — `accessibilityPropsConversions.h` lists button, togglebutton, link, switch, summary,
 * tabbar and progressbar, everything else falls to `None` — so on the iPhone Duo the five rail
 * destinations, the Screener's three shelves and the sender sheet's two scope segments each came
 * back `GenericElement` beside a `Button` search pill: nothing told a person driving VoiceOver
 * they could be pressed. Android keeps `tab`, which Material announces.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { a11yRole } from "../src/ui/a11y-role";

const source = (rel: string): string =>
  withoutComments(readFileSync(new URL(rel, import.meta.url).pathname, "utf8"));

describe("a pressable control advertises a role iOS carries", () => {
  it("tab becomes a button on iOS — RN maps `tab` to no trait at all", () => {
    expect(a11yRole("tab", "ios")).toBe("button");
  });

  it("Android keeps tab, which Material announces", () => {
    expect(a11yRole("tab", "android")).toBe("tab");
  });

  it("a button is a button on both", () => {
    expect(a11yRole("button", "ios")).toBe("button");
    expect(a11yRole("button", "android")).toBe("button");
  });

  /**
   * THE CENSUS, both ways. A file may not spell a raw `tab` role (the shape that read
   * `GenericElement` on the device), and the two components that carry one must route it
   * through the mapper — a rule that admitted zero files would pass for nothing.
   */
  const CARRIERS = ["../src/ui/glass/GlassIconButton.tsx", "../src/ui/Segmented.tsx"];

  it("every tab-role carrier routes its role through a11yRole", () => {
    for (const rel of CARRIERS) {
      const src = source(rel);
      expect(src, rel).toContain("a11yRole(");
      expect(src, rel).not.toContain('accessibilityRole="tab"');
    }
    expect(CARRIERS.length).toBe(2);
  });

  it("no other mobile component spells a raw tab role", () => {
    const files = [
      "../src/ui/nav-rail.tsx", "../src/ui/glass/GlassDock.tsx", "../src/ui/scaffold/AppScaffold.tsx",
      "../src/ui/list-detail.tsx",
    ];
    for (const rel of files) expect(source(rel), rel).not.toContain('accessibilityRole="tab"');
  });
});
