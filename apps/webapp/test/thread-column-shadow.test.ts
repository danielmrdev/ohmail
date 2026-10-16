import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE THREAD'S PANELS CAST THE SAME LIGHT THE SINGLE-MESSAGE PANEL CASTS — AND THE SCROLL CLIP
 * IS MOVED OUT OF THEIR WAY SO IT CAN ACTUALLY RENDER.
 *
 * A single message's column IS the panel: `.read-col` carries `--panel` + `--lift-1`, and its
 * shadow is the ELEMENT'S OWN — overflow clips an element's descendants, never its own outer
 * box-shadow — so it falls freely into the 16px canvas gaps beside the column. A thread hands
 * the paper to the per-message panels (`.pm`), and those are DESCENDANTS of the scroller. An
 * element with `overflow-y: auto` cannot keep `overflow-x: visible` (CSS forces the other axis
 * to a non-visible value), so everything a panel paints past the scrollport's padding box is
 * simply gone. With the old `padding: 0 2px`, each panel's `--lift-1` had 2px of sideways room
 * and was then CUT — a hard tone-step running the full height of both sides of every panel,
 * which read as a 2–3px border drawn on the panel edges.
 *
 * THE FIX IS GEOMETRY, in two coupled halves on `.read-col:has(> .conv)`:
 *
 *   · `margin: -16px` — the scroller's box widens by exactly the inter-column gap, so its
 *     clip edge lands on the LIST panel's opaque edge on one side and the viewport edge on the
 *     other: the only shadow it removes is tail that would have died on those surfaces anyway.
 *   · `padding: 16px` — gives that borrowed room back, so the panels stand exactly where the
 *     single-message panel stands (identical width, identical edges) and their side falloff
 *     renders COMPLETE on visible canvas, byte-for-byte the falloff the single column shows.
 *
 *   The two values must stay equal-and-opposite. Padding without the margin insets the panels
 *   16px from every other column's edge; margin without the padding pushes the panels over the
 *   gaps and clips their shadows at full strength. Either half alone is a different defect.
 *
 * THE SAME TWO HALVES RUN VERTICALLY, for the SCROLL rather than for the shadows. The deck
 * frames every view in 16px of canvas (`.deck` padding, app.css), and while the scroller ended
 * at that frame a mid-scroll panel was CUT on the frame line — a hard edge 16px short of the
 * viewport, top and bottom, while the reading stream scrolls clean to both edges (the
 * `.view-reads .stream` reclaim in app.css is the same construction: negative margins over the
 * deck frame, the spacing given back inside the scroller). With the margin on all four sides
 * the clip edge lands on the deck's own edges — at ≥700px, where the reading column exists,
 * the viewport's top and bottom — and the four-side padding makes the spacing SCROLL-INTERNAL:
 * at rest nothing moves (the lede still tops out on the columns' shared line, the content still
 * bottoms out on the panels' shared baseline), and mid-scroll a panel runs to the viewport edge
 * before it is cut. `0 -16px` / `0 16px` back on this rule is the hard-cut defect verbatim.
 *
 * `border-radius: 0` — the 20px arc used to round the cut of a panel scrolled past the edge,
 * back when the panels sat 2px from the clip. With the clip box extended into the gaps the arc
 * can no longer reach a panel; all it clipped was the shadow strip in the corner, where an arc
 * reads as a detached curved fragment mid-scroll. Straight clip, one line, nothing else.
 *
 * NO SHADOW ON THE WRAPPER — the phantom-panel ruling stands: an outer shadow on a box that
 * paints nothing draws the silhouette of a surface that is not there.
 *
 * FLUSH AT BOTH ENDS stands too, carried by the padding now instead of by its absence: the
 * lede tops out on the columns' shared line and the resting content bottoms out on the shared
 * baseline because the reclaimed frame comes back as scroll-internal room, and the pill's flow
 * box (action-bar.test.ts pins it) is still the room the last panel's downward falloff renders
 * into.
 *
 * THE STACK RHYTHM IS 20px, NOT 12. In the 12px gap the upper panel's long `--lift-1` throws
 * (light: `0 14px 32px -10px` peaks INSIDE the gap) pooled with the lower panel's ring into a
 * near-uniform dark band — the "border between panels" the 2px clip did on the sides, done
 * vertically. 20px is the reading stream's stacked-card gap (`.scast`, stream.css), the one
 * stacked-lift-1 rhythm already shipped and accepted; measured on the built page in both
 * themes, the junction reads as canvas with depth, not as a seam.
 *
 * THE LEFT STRIP IS FADED, NOT ONLY RECLAIMED. The reclaim moved the clip onto the list
 * panel's edge, but the panels' `--lift-1` outreaches the 16px it borrowed (light ambient
 * `0 40px 96px -28px`, dark `0 24px 56px -20px`), so the clip amputated the left falloff at
 * visible strength — measured faintly under canvas in light — and printed a straight line down
 * the list/viewer boundary, nakedly on the canvas strips above and below the list panel. The
 * mask ramps the reclaimed strip from nothing at the clip edge to full at the panels' own
 * edge: the falloff completes to zero ON the boundary, and the gap reads as the same lit
 * canvas the rail/list gap is. Left only — the right strip dies on the viewport edge, and a
 * vertical ramp would dissolve mid-scroll panels before the viewport cuts them.
 *
 * MUTATION WATCH (each applied, watched go red, restored):
 *   · `padding: 0 2px` restored on the thread rule → the clipped-sides case.
 *   · `margin: 0 -16px` dropped (margin 0) → the inset/misaligned case.
 *   · `box-shadow: var(--lift-1)` on the thread rule → the phantom case.
 *   · `border-radius: 20px` restored → the corner-fragment case.
 *   · `.pm` margin back to `0 0 12px` → the seam case.
 *   · `overflow-y: auto` dropped from `.read-col` → the scroller case.
 *   · `[data-theme="dark"]` `--lift-1` deleted from tokens.css → the theme case.
 *   · both `mask-image` lines deleted from the thread rule → the printed-boundary case.
 *   · the unprefixed `mask-image` alone deleted → the Chromium-only-fix case.
 *   · the ramp widened to `#000 24px` → the fade-eats-the-panel-edge case.
 */

const bare = (p: string): string =>
  readFileSync(resolve(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const MESSAGE_CSS = bare("packages/ui/src/composites/message.css");
const APP_CSS = bare("apps/webapp/app/app.css");
const TOKENS_CSS = readFileSync(
  resolve(process.cwd(), "packages/tokens/src/tokens.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

const ruleBody = (css: string, sel: string): string | null => {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const selectors = m[1].split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (selectors.includes(sel)) return m[2];
  }
  return null;
};

const decl = (body: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body);
  return m ? m[1].trim() : null;
};

describe("the thread column clips outside the panels' light", () => {
  const col = ruleBody(MESSAGE_CSS, ".read-col");
  const thread = ruleBody(MESSAGE_CSS, ".read-col:has(> .conv)");

  it("both rules are found at all", () => {
    expect(col, "`.read-col` no longer has a base rule in message.css").not.toBeNull();
    expect(thread, "the thread override `.read-col:has(> .conv)` is gone").not.toBeNull();
  });

  it("the column stays the one scroller", () => {
    expect(decl(col!, "overflow-y")).toBe("auto");
  });

  it("the thread column is fully transparent — no paper, and NO phantom shadow", () => {
    expect(decl(thread!, "background"), "the thread column grew paper back — panel-on-panel")
      .toBe("none");
    expect(
      decl(thread!, "box-shadow"),
      "the thread column casts a shadow of its own: an outer shadow on a box that paints " +
        "nothing draws a phantom panel around the pill band and the canvas gaps — the panels' " +
        "own `--lift-1` is the only light this surface shows",
    ).toBe("none");
  });

  it("the clip is widened over the gaps and the room is given back as padding", () => {
    // A scroller cannot keep overflow-x visible, so the panels' side shadows CANNOT escape
    // this box — the box is therefore extended to where dying past the edge is invisible
    // (the list panel's opaque edge; the viewport edge), and the panels are padded back to
    // the exact footprint the single-message panel has. Equal-and-opposite, both halves,
    // on ALL FOUR SIDES: the horizontal pair is the shadows' room, the vertical pair is the
    // scroll's edge (the test below).
    expect(
      decl(thread!, "margin"),
      "without the negative margin the padding insets the panels a full frame from every " +
        "other column's edge — the clip edge must sit ON the neighbouring surfaces",
    ).toBe("calc(-1 * var(--gap-edge))");
    expect(
      decl(thread!, "padding"),
      "without the padding the panels ride over the gaps and their `--lift-1` is cut at " +
        "full strength at the scrollport edge — the clipped-border defect verbatim",
    ).toBe("var(--gap-edge)");
  });

  it("the vertical spacing is scroll-internal — panels scroll to the deck's edge, not to a clip line", () => {
    // `margin: -16px` puts the clip edge on the deck's own top and bottom (the viewport's, at
    // the widths where this column exists), and `padding: 16px` turns the deck's 16px frame
    // into SCROLL-INTERNAL room: the resting geometry is unchanged, and a mid-scroll panel is
    // cut at the viewport edge instead of on a hard line 16px short of it. This is the reading
    // stream's own construction (`.view-reads .stream`, app.css) — a `0 -16px` / `0 16px` pair
    // back on this rule is the hard-cut defect the reclaim exists to remove.
    const margin = decl(thread!, "margin");
    const padding = decl(thread!, "padding");
    expect(
      margin,
      "the thread scroller's clip must reach the deck's top and bottom edges — a margin that " +
        "keeps 0 on the vertical axis parks the clip on the deck frame and hard-cuts every " +
        "mid-scroll panel a full frame short of the viewport",
    ).toBe("calc(-1 * var(--gap-edge))");
    expect(
      padding,
      "the deck frame must come back INSIDE the scroller — without the vertical " +
        "padding the resting thread rides a full frame past the columns' shared top line and " +
        "baseline instead of scrolling past them",
    ).toBe("var(--gap-edge)");
    // The reclaim only reaches the viewport because it equals the deck's frame. If the deck
    // ever re-pads, this rule and the stream's must move with it — in step, or the thread and
    // the stream cut at different lines.
    // THE COUPLING, PINNED AS A RELATIONSHIP now that the frame is a token: the deck's
    // frame, this rule's reclaim/give-back, and the reading stream's reclaim all read
    // `--gap-edge` (paper 16px, ohmarchy 10px — OHMARCHY-TOKENS.md). Any site that re-pads
    // with a literal diverges the moment a face resizes the frame, which is exactly the
    // "moved in step, or cut at different lines" failure this block always defended.
    const deck = ruleBody(APP_CSS, ".deck");
    expect(deck, "`.deck` no longer has a base rule in app.css").not.toBeNull();
    expect(
      decl(deck!, "padding"),
      "the deck's frame is the token the thread scroller reclaims — a deck that pads " +
        "differently strands the thread's clip edge somewhere that is neither the frame " +
        "line nor the viewport",
    ).toBe("var(--gap-edge)");
    // …and the reading stream's reclaim is the same token (the same construction, app.css).
    const streamRe = /\.view-reads \.stream,\s*\n\s*\.view-receipts \.stream \{([^}]*)\}/;
    const stream = streamRe.exec(APP_CSS)?.[1] ?? null;
    expect(stream, "the reading stream's reclaim rule is gone from app.css").not.toBeNull();
    expect(decl(stream!, "margin-top")).toBe("calc(-1 * var(--gap-edge))");
    expect(decl(stream!, "margin-bottom")).toBe("calc(-1 * var(--gap-edge))");
    expect(
      decl(stream!, "padding-top"),
      "the stream's first-card seat is its own 2px plus the deck frame — a literal here " +
        "diverges from the frame the moment a face resizes it",
    ).toBe("calc(2px + var(--gap-edge))");
  });

  it("the reclaimed left strip fades to nothing at the clip edge — no printed boundary line", () => {
    // The panels' --lift-1 outreaches the 16px gap (light ambient `0 40px 96px -28px`, dark
    // `0 24px 56px -20px`), so the bare clip amputates the left falloff while it is still visible —
    // under canvas in light on the built page — and prints a straight line down the
    // list/viewer boundary. The mask ramps the strip so the falloff completes to ZERO on the
    // boundary itself. LEFT ONLY: the right strip dies on the viewport edge (nothing to print
    // a line on), and a vertical ramp would dissolve mid-scroll panels before the viewport
    // cuts them. The ramp width must equal the reclaim — a mask wider than the margin eats
    // into the panels' own edge, a narrower one leaves cut falloff outside the fade.
    const ramp = "linear-gradient(to right,transparent,#000 var(--gap-edge))";
    expect(
      decl(thread!, "mask-image"),
      "the left-strip fade left the thread rule — the clip amputates the panels' left " +
        "falloff at visible strength and prints a line down the list/viewer boundary",
    ).toBe(ramp);
    expect(
      decl(thread!, "-webkit-mask-image"),
      "the prefixed twin is what WKWebView (the desktop shell) actually applies — without " +
        "it the boundary line is fixed in Chromium and shipped on the Mac",
    ).toBe(ramp);
  });

  it("the widened clip is square — the arc has nothing left to round", () => {
    expect(
      decl(thread!, "border-radius"),
      "with the clip box extended into the gaps a 20px arc can no longer reach a panel; it " +
        "only clips the corner of the shadow strip, where a curved fragment floats detached " +
        "over the gap mid-scroll. A scrolled panel is cut on one straight line",
    ).toBe("0");
  });

  it("every panel wears the same skin, at the stream's stacked-card rhythm", () => {
    const pm = ruleBody(APP_CSS, ".pm");
    expect(pm, "`.pm` no longer has a base rule in app.css").not.toBeNull();
    expect(decl(pm!, "box-shadow")).toBe("var(--lift-1)");
    expect(
      decl(pm!, "margin"),
      "at 12px the upper panel's long --lift-1 throws pool with the lower panel's ring into " +
        "a near-uniform dark band — the seam that read as a border between panels. 20px is " +
        "the stream's stacked-lift-1 gap (.scast), the rhythm already shipped and accepted",
    ).toBe("0 0 20px");
    const focus = ruleBody(APP_CSS, ".conv > .conv-focus");
    expect(focus, "the focused panel's margin rule left app.css").not.toBeNull();
    expect(decl(focus!, "margin"), "the focused panel must keep the same 20px rhythm")
      .toBe("0 0 20px");
    const last = ruleBody(APP_CSS, ".conv > article.pm:last-of-type");
    expect(last, "the last panel lost its flush rule").not.toBeNull();
    expect(decl(last!, "margin-bottom")).toBe("0");
    // The ONLY thing the last panel changes is that margin. A :last-of-type rule that touches
    // paint (its shadow, its ground) would make the newest message a different kind of panel.
    expect(decl(last!, "box-shadow")).toBeNull();
    expect(decl(last!, "background")).toBeNull();
  });

  it("the panels' light resolves in every theme scope", () => {
    // The thread rule spells no colors, so the panels' `--lift-1` is the whole paint. It must
    // stay declared for light, for the explicit dark choice, and for the system-dark default.
    // Slice tokens.css at its three scope openers and demand the token inside each slice —
    // coarse on purpose: a moved declaration still passes, a deleted one cannot.
    const darkIdx = TOKENS_CSS.indexOf('[data-theme="dark"]');
    const mediaIdx = TOKENS_CSS.indexOf("@media (prefers-color-scheme: dark)");
    expect(darkIdx, "the [data-theme=dark] scope left tokens.css").toBeGreaterThan(0);
    expect(mediaIdx, "the system-dark scope left tokens.css").toBeGreaterThan(darkIdx);
    const light = TOKENS_CSS.slice(0, darkIdx);
    const dark = TOKENS_CSS.slice(darkIdx, mediaIdx);
    const systemDark = TOKENS_CSS.slice(mediaIdx);
    expect(light, "--lift-1 left the light scope in tokens.css").toContain("--lift-1:");
    expect(dark, "--lift-1 left the [data-theme=dark] scope in tokens.css").toContain("--lift-1:");
    expect(systemDark, "--lift-1 left the system-dark scope in tokens.css").toContain("--lift-1:");
  });
});
