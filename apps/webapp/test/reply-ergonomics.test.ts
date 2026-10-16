/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * THE REPLY IS THE MESSAGE, SO GIVE IT ROOM AND GIVE ITS TOOLBAR REAL HANDS (slice R9-4).
 *
 * Two ergonomics that CSS owns and `tsc` cannot see: the reply editor was a 128px letterbox under a
 * full-height reader, and the formatting toolbar it shares with compose and the Reply Run drew
 * 26px/12px buttons that read as an afterthought. This injects the real `app.css` into a jsdom
 * document and reads `getComputedStyle`, the same technique `compose-from-select.test.ts` uses — so
 * a stylesheet that reverted the sizes through any selector, not just these literals, goes red.
 *
 * ── RE-SPECCED WITH THE DOCKED-PANEL REDESIGN — deliberately, not weakened ────────────────
 * This file used to pin `min-height: 240px; max-height: 50vh` on the SURFACE, because the
 * surface was the only element that had a height opinion. The panel owns the room now: `.reply`
 * is a viewport-bounded flex column (`min-height: clamp(…)`, `max-height: calc(100dvh - …)`),
 * the editor is its one flexible child, and the surface must be SHRINKABLE (`min-height: 0`) or
 * the chrome — toolbar, attachments, Send — gets pushed out of the panel, which is the defect
 * the redesign removed. The intent guarded here is unchanged: a reply is never a letterbox, and
 * a tall reply scrolls inside itself instead of pushing Send off-screen. The named consumer of
 * the new shape is `reply-panel.test.tsx`, which holds the whole panel contract; this file keeps
 * the editor-side halves so a cascade quirk cannot revert them in isolation.
 *
 * ONE HONEST LIMIT: jsdom does no LAYOUT, so this proves the declared minimum/clamp/target sizes the
 * cascade resolves, not a measured pixel height. That is exactly the regression at issue — the
 * numbers in the sheet — and the source-text block is a second, cascade-independent guard on the
 * same values.
 */

const CSS_PATH = "apps/webapp/app/app.css";
const appCss = readFileSync(resolve(process.cwd(), CSS_PATH), "utf8");
const bare = appCss.replace(/\/\*[\s\S]*?\*\//g, "");

/** Body of the first top-level rule whose selector list starts with `sel` (no nested braces). */
const ruleBody = (css: string, sel: string): string | null => {
  const re = new RegExp(`(?:^|[};])\\s*${sel}\\s*\\{([^{}]*)\\}`, "m");
  const m = re.exec(css);
  return m ? m[1] : null;
};

/**
 * The reply editor's frame, in the shape `InlineReply` renders it — the `.reply-editor` wrapper
 * that IS the `.rte`, its toolbar with one mark button, and the editable surface inside it.
 */
const MARKUP = `
<div class="reply-editor rte">
  <div class="rte-bar" role="toolbar">
    <button class="rte-b" data-mark="bold">B</button>
  </div>
  <div class="rte-surface"></div>
</div>`;

const surface = (): HTMLElement => document.querySelector(".reply-editor .rte-surface")!;
const button = (): HTMLElement => document.querySelector(".rte-b")!;

beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.appendChild(style);
  document.body.innerHTML = MARKUP;
  // If jsdom failed to parse the sheet it drops it silently and every computed value below is "",
  // which would read as "no regression". Fail loudly instead.
  expect(
    window.getComputedStyle(button()).height,
    "app.css did not reach the document — every computed size here would be empty",
  ).not.toBe("");
});

describe("the reply editor fills a bounded panel, and only it scrolls", () => {
  it("the surface is the scroll region, and it may shrink under the panel's chrome", () => {
    const cs = window.getComputedStyle(surface());
    expect(cs.overflowY, "a tall reply has no scroll of its own").toBe("auto");
    // `0`, not the old 240px floor: a surface that cannot shrink pushes the toolbar and the
    // Send row out of the height-bounded panel. The room lives on the panel now (below).
    expect(cs.minHeight, "the surface floor came back — chrome can be pushed off the panel")
      .toMatch(/^0(px)?$/);
  });

  it("the source: the panel carries the room and the bound, the editor takes the slack", () => {
    const surfaceRule = ruleBody(bare, "\\.reply-editor \\.rte-surface");
    expect(surfaceRule, "no `.reply-editor .rte-surface` rule in app.css").not.toBeNull();
    expect(surfaceRule!).toMatch(/min-height:\s*0/);
    expect(surfaceRule!).toMatch(/overflow-y:\s*auto/);
    // The letterbox guard, where the height opinion lives now: the panel's resting posture is
    // a real clamp (roomy on a desk, backing off on a short window), bounded by the viewport.
    const reply = ruleBody(bare, "\\.reply");
    expect(reply, "no `.reply` rule in app.css").not.toBeNull();
    expect(reply!, "the panel lost its resting room — the letterbox returns").toMatch(/min-height:\s*clamp\(/);
    expect(reply!, "the panel lost its viewport bound — Send can leave the screen").toMatch(/max-height:\s*calc\(100dvh/);
    // …and the editor is the child the slack goes to, with a floor so a sliver of body
    // always stays visible under tall chrome.
    const editor = ruleBody(bare, "\\.reply\\s*>\\s*\\.reply-editor");
    expect(editor, "no `.reply > .reply-editor` rule").not.toBeNull();
    expect(editor!).toMatch(/flex:\s*1 1 auto/);
    expect(editor!).toMatch(/min-height:\s*\d+px/);
  });
});

describe("the shared formatting toolbar has a real hit area (compose, reply, Reply Run alike)", () => {
  it("the buttons are 34px targets with a 16px glyph, not the old 26/12", () => {
    const cs = window.getComputedStyle(button());
    expect(cs.height, "the toolbar buttons shrank back to the afterthought height").toBe("34px");
    expect(cs.fontSize, "the mark glyph shrank back").toBe("16px");
    expect(cs.minWidth, "the target is no longer square").toBe("34px");
  });

  it("the source names the same, since one `.rte-b` block styles all three surfaces", () => {
    const body = ruleBody(bare, "\\.rte-b");
    expect(body, "no `.rte-b` rule in app.css").not.toBeNull();
    expect(body!).toMatch(/height:\s*34px/);
    expect(body!).toMatch(/font-size:\s*16px/);
    expect(body!).toMatch(/min-width:\s*34px/);
  });
});
