/**
 * ═══ NEW MAIL IS TITLED ONCE ════════════════════════════════════════════════════════════════════
 *
 * The compose route drew "New mail" in its bar and the sheet over it said "New mail" again (and a
 * draft's "Drafts" bar sat above a sheet headed "New mail"). The sheet's own head is the one title:
 * the route renders the composer alone, as a transparent modal over the screen it was opened from,
 * so on an open foldable the list and the rail stand under the sheet over the detail pane.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

const src = (rel: string) => withoutComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

describe("the composer's head is the only title on screen (DUPLICATE_TITLE)", () => {
  const route = src("../app/compose.tsx");
  const sheets = [...route.matchAll(/<ComposeSheet\b/g)].map((m) => m.index!);

  it("every composer the route opens renders alone: no Screen, no bar around it", () => {
    expect(sheets.length, "the route's composers moved; this reads nothing").toBe(2);
    for (const at of sheets) {
      const before = route.slice(route.lastIndexOf("return", at), at);
      expect(before, "a bar or a page drawn under the sheet").not.toMatch(/<DetailBar|<Screen/);
    }
  });

  it("the sheet says New mail itself, once", () => {
    const sheet = src("../src/ui/MessageActions.tsx");
    expect(sheet).toContain("? Copy.composeNewHead");
  });

  it("the route is a transparent modal, so the screen it was opened from stands under the sheet", () => {
    const layout = src("../app/_layout.tsx");
    const at = layout.indexOf('name="compose"');
    expect(at, "the compose route takes the stack's card presentation").toBeGreaterThan(-1);
    const opts = layout.slice(at, layout.indexOf("/>", at));
    expect(opts).toContain('presentation: "transparentModal"');
    expect(opts).toContain('contentStyle: { backgroundColor: "transparent" }');
  });

  it("the routes that cannot open a composer still draw their own titled page", () => {
    expect(route).toContain("<DetailBar title={Copy.composeNew} />\n        <Empty title={Copy.composeNoMailbox}");
  });
});
