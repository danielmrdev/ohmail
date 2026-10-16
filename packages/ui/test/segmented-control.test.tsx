/** @vitest-environment jsdom */
/**
 * THE SEGMENTED CONTROL — row or stack, never wider than the box it is given.
 *
 * One control, three failures, all of them the same failure:
 *
 *   · In a settings row the control cluster is `flex: 0 0 auto` — never shrunk — so a wide set of
 *     labels ran straight out of the card. Reported from real use on the away responder's rate
 *     control, whose four labels are the longest set this control has.
 *   · Where it IS shrunk (a stretched child of a list column) the capsule stayed put and its
 *     BUTTONS wrapped their labels instead — a two-line pill, which is not a segment.
 *   · Under 480px the stylesheet used to add `flex-wrap: wrap`, so the capsule wrapped: a 99px
 *     radius on a two-row box.
 *
 * The rule is one rule: the row form is as wide as its segments and never wider than its
 * container, and where the row form cannot fit the control changes FORM — a stacked list — rather
 * than SIZE. The switch is MEASURED, because the row form's width depends on the labels, the
 * locale and the face's font: the away responder's rate control is 572px in English on paper and
 * 749px in German on ohmarchy, and no static breakpoint is true for both.
 *
 * jsdom has no layout, so the measurement is driven here through a `ResizeObserver` stub over
 * stubbed geometry — which exercises the component's real decision path — and the PIXELS are
 * checked in a browser by the rendered width sweep.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SegmentedControl } from "@ohmail/ui";
import {
  segAvailableWidth,
  segNaturalWidth,
  shouldStack,
} from "../src/primitives/SegmentedControl.js";

afterEach(cleanup);

const read = (rel: string): string =>
  readFileSync(resolve(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const seg = (): string => read("packages/ui/src/primitives/seg.css");
const settings = (): string => read("packages/ui/src/composites/settings.css");
/** The rule whose selector begins a line — the base rule, never a scoped override. */
const ruleFor = (src: string, selector: string): string => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\n)${esc}\\s*\\{[^}]*\\}`, "m").exec(src)?.[0].trim() ?? "";
};

/* ══ 1. THE TWO FORMS, AS THE STYLESHEET DECLARES THEM ═══════════════════════════════════ */

describe("the stylesheet declares two forms and no third", () => {
  it("the ROW form is as wide as its segments and never wider than its container", async () => {
    const rule = ruleFor(seg(), ".seg");
    expect(rule, "the capsule sizes to something other than its content").toContain("width:max-content");
    expect(rule, "the capsule may exceed its container — the reported defect")
      .toContain("max-width:100%");
    // `border-box`, or the 2px padding puts a full-width capsule 4px past its container.
    expect(rule, "a padded capsule at max-width:100% overflows by its own padding")
      .toContain("box-sizing:border-box");
  });

  it("a segment's label NEVER wraps inside the capsule, and no segment is shrunk", async () => {
    const rule = ruleFor(seg(), ".seg button");
    expect(rule, "a label may wrap inside a capsule — a two-line pill is not a segment")
      .toContain("white-space:nowrap");
    expect(rule, "a segment may be squeezed, which cuts its label").toContain("flex:none");
  });

  /* The overflow form WRAPS: a column of three in the fold bands' list
     read as an open menu, not as tabs. Its geometry is `apps/webapp/test/fold-band-ladder-polish.test.tsx`. */
  it("the STACK form wraps into rows, never a column, and it is a card rather than a pill", async () => {
    const rule = ruleFor(seg(), ".seg[data-stack]");
    expect(rule, "the overflow form does not wrap").toContain("flex-wrap:wrap");
    expect(rule, "the overflow form fell back to one option per line").not.toContain("flex-direction:column");
    /* A 99px radius on a two-line box is a blob, so the wrapped form takes the CARD radius —
       through a ratio of `--r-card`, not a literal, so ohmarchy's square face stays square. */
    expect(rule, "the wrapped form kept the pill radius").not.toContain("var(--r-pill)");
    expect(rule).toContain("var(--r-card)");
    // A label wider than the whole container wraps inside its own segment rather than overflow it.
    const btn = ruleFor(seg(), ".seg[data-stack] button");
    expect(btn).toContain("white-space:normal");
    expect(btn).toContain("max-width:100%");
  });

  it("the settings pane no longer WRAPS the capsule — stacking is the control's own", async () => {
    /**
     * `flex-wrap: wrap` on `.seg` under 480px was the third failure: it wrapped the capsule
     * itself. The control's own stacked form is what a segmented control does when its row would
     * overflow, and it does it at every width rather than below one.
     *
     * Mutation that must go red: put `flex-wrap:wrap` back on `.set-row .seg`.
     */
    const src = settings();
    const rule = /\.set-row \.seg\{[^}]*\}/.exec(src)?.[0] ?? "";
    expect(rule, "the settings rule for .seg is gone — re-derive this test").not.toBe("");
    expect(rule, "the capsule wraps again — a wrapped pill is a blob").not.toContain("flex-wrap");
    // It still stands flush-left where the row has stacked; that is the row grammar, not this.
    expect(rule).toContain("align-self:flex-start");
  });
});

/* ══ 2. THE MEASUREMENT — the pure decision, in isolation ════════════════════════════════ */

describe("the measurement's three pure parts", () => {
  /** A box whose children have real widths and whose parent has a real content box. */
  function rig(childWidths: number[], parentWidth: number, opts: { pad?: string; margin?: string } = {}) {
    const parent = document.createElement("div");
    parent.style.padding = "0px";
    Object.defineProperty(parent, "clientWidth", { value: parentWidth, configurable: true });
    const el = document.createElement("div");
    el.style.padding = opts.pad ?? "2px";
    el.style.margin = opts.margin ?? "0px";
    for (const w of childWidths) {
      const b = document.createElement("button");
      b.getBoundingClientRect = () => ({ width: w, height: 24, top: 0, left: 0, right: w, bottom: 24, x: 0, y: 0, toJSON: () => ({}) });
      el.appendChild(b);
    }
    parent.appendChild(el);
    document.body.appendChild(parent);
    return { parent, el };
  }

  it("the natural width is the SEGMENTS' widths plus the capsule's own padding", () => {
    // Read from the CHILDREN, never from the box: as a stretched flex item the box can be wider
    // than its content, and that over-report would keep a list stacked after the room came back.
    const { el } = rig([100, 120, 90], 1000);
    expect(segNaturalWidth(el)).toBe(100 + 120 + 90 + 4);
  });

  it("the available width is the parent's CONTENT box, net of the control's own margins", () => {
    const { el } = rig([10], 500, { margin: "0px 20px" });
    expect(segAvailableWidth(el)).toBe(500 - 40);
    // A parent's padding comes off too — it is not room the control may use.
    const two = rig([10], 500);
    two.parent.style.padding = "0px 15px";
    expect(segAvailableWidth(two.el)).toBe(500 - 30);
  });

  it("with no parent there is no constraint, rather than a guess of zero", () => {
    const orphan = document.createElement("div");
    expect(segAvailableWidth(orphan)).toBe(Infinity);
  });

  it("stacks only when the row form genuinely does not fit, with rounding tolerance", () => {
    expect(shouldStack(500, 400)).toBe(true);
    expect(shouldStack(400, 500)).toBe(false);
    // Exactly equal fits — and half a pixel of sub-pixel rounding must not flip the form.
    expect(shouldStack(400, 400)).toBe(false);
    expect(shouldStack(400.4, 400)).toBe(false);
    expect(shouldStack(400.6, 400)).toBe(true);
    /* An unreadable measurement is not an answer, and the DIRECTION of the guess matters: `NaN >
       x` is false, which would read as "the row fits" — the overflow direction, and the one this
       control exists to prevent. Stacking is the benign direction, so that is what it does. */
    expect(shouldStack(Number.NaN, 400), "an unreadable row width read as a fitting row").toBe(true);
    expect(shouldStack(400, Number.NaN)).toBe(true);
    expect(shouldStack(Number.POSITIVE_INFINITY, 400)).toBe(true);
  });
});

/* ══ 3. THE MEASUREMENT, THROUGH THE COMPONENT ═══════════════════════════════════════════ */

describe("the control changes form rather than size", () => {
  /**
   * Every LIVE observer the component made, so a test can fire the resize itself.
   *
   * `disconnect` really removes its callback: the component re-observes when its labels change,
   * and a stub that kept the dead observers alive would fire a resize the real browser would
   * not — which is how a test comes to assert behaviour that only exists in the stub.
   */
  let fire: Array<() => void> = [];
  /** Every element the component asked to observe — the subject of the font case below. */
  let observed: Element[] = [];
  const realRO = globalThis.ResizeObserver;

  beforeEach(() => {
    fire = [];
    observed = [];
    class RO {
      private live: () => void;
      constructor(cb: () => void) {
        this.live = cb;
        fire.push(this.live);
      }
      observe(t: Element) { observed.push(t); }
      unobserve() {}
      disconnect() { fire = fire.filter((f) => f !== this.live); }
    }
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  });
  afterEach(() => {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = realRO;
  });

  const OPTIONS = [
    { id: "always" as const, label: "Reply to every message" },
    { id: "per_message" as const, label: "One reply, until I change the text" },
    { id: "per_day" as const, label: "At most once a day" },
    { id: "per_week" as const, label: "At most once a week" },
  ];

  /** Render the control inside a pane of `paneWidth`, with each segment `segWidth` wide. */
  function mount(paneWidth: number, segWidth: number) {
    const utils = render(
      <div className="set-pane">
        <SegmentedControl options={OPTIONS} value="per_day" onChange={() => {}} ariaLabel="Rate" />
      </div>,
    );
    const el = document.querySelector<HTMLElement>(".seg")!;
    const parent = el.parentElement!;
    parent.style.padding = "0px";
    el.style.padding = "2px";
    el.style.margin = "0px";
    Object.defineProperty(parent, "clientWidth", { value: paneWidth, configurable: true });
    stubSegments(el, segWidth);
    return { el, parent, ...utils };
  }
  /** Give every segment a real rendered width — jsdom reports zero for all of them. */
  function stubSegments(el: HTMLElement, segWidth: number): void {
    for (const b of [...el.children]) {
      (b as HTMLElement).getBoundingClientRect = () => ({
        width: segWidth, height: 24, top: 0, left: 0, right: segWidth, bottom: 24, x: 0, y: 0, toJSON: () => ({}),
      });
    }
  }
  /**
   * Fire the observers, INSIDE `act`.
   *
   * A `ResizeObserver` callback is not React's own event, so the `setState` it makes is not
   * flushed by anything a test can see unless the call is act-wrapped — an unwrapped fire leaves
   * the attribute unchanged and every stacking case reads as "the control refused to stack".
   */
  const resize = (): void => { act(() => { for (const f of [...fire]) f(); }); };
  /**
   * Flush the control's own scheduled re-measure.
   *
   * When nothing is remembered and the DOM is still stacked, the control stands in row form for
   * one frame and measures on the NEXT one — it may not wait for an observer, because changing
   * form need not change the box (`max-width: 100%`) and no resize would then fire.
   */
  async function frames(n = 3): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
    }
  }

  it("stands as a ROW where the row fits", () => {
    const { el } = mount(900, 100); // 4 × 100 + 4 = 404 into 900
    resize();
    expect(el.hasAttribute("data-stack"), "a fitting row was stacked anyway").toBe(false);
  });

  it("STACKS where the row would run out of its card — the reported defect", () => {
    const { el } = mount(420, 180); // 4 × 180 + 4 = 724 into 420
    resize();
    expect(el.hasAttribute("data-stack"), "the control stayed a row wider than its card").toBe(true);
    // The same options, still buttons, still reachable — a change of form, not of content.
    expect(el.querySelectorAll("button")).toHaveLength(OPTIONS.length);
    expect([...el.querySelectorAll("button")].map((b) => b.textContent))
      .toEqual(OPTIONS.map((o) => o.label));
  });

  it("comes BACK to a row when the room returns", () => {
    /**
     * The reason `segNaturalWidth` reads the children: a stacked list is narrow, so measuring
     * the BOX would report the stacked width, decide it fits, unstack, re-measure, and stack
     * again — or, remembering the wrong number, stay stacked for ever. The natural width is
     * remembered from the last ROW measurement instead.
     */
    const { el, parent } = mount(420, 180);
    resize();
    expect(el.hasAttribute("data-stack")).toBe(true);
    Object.defineProperty(parent, "clientWidth", { value: 900, configurable: true });
    resize();
    expect(el.hasAttribute("data-stack"), "the room came back and the list stayed stacked")
      .toBe(false);
  });

  it("re-measures when the LABELS change, rather than trusting a remembered width", () => {
    // A locale switch or a changed count is new words; the width remembered for the old ones is
    // no longer about anything. Re-rendering with shorter labels must let the row form back.
    const { el, rerender } = mount(420, 180);
    resize();
    expect(el.hasAttribute("data-stack")).toBe(true);
    const SHORT = OPTIONS.map((o) => ({ ...o, label: o.id }));
    rerender(
      <div className="set-pane">
        <SegmentedControl options={SHORT} value="per_day" onChange={() => {}} ariaLabel="Rate" />
      </div>,
    );
    // The new words are narrow; the remembered width was for the old ones.
    stubSegments(el, 40);
    resize();
    expect(el.hasAttribute("data-stack"), "new words were judged by the old measurement")
      .toBe(false);
  });

  it("WATCHES THE SEGMENTS, so a font change reaches it at all", () => {
    /**
     * The second review caught this file promising something it did not prove: the case below
     * changes the font and then FIRES THE OBSERVER BY HAND, so it showed that a font change is
     * handled once something wakes the control — not that anything would.
     *
     * Nothing would. The capsule is `width: max-content; max-width: 100%`; once that cap is in
     * force, a face switch or a webfont finishing load changes glyph widths without changing
     * either the control's box or its parent's, so no `ResizeObserver` callback fires and the
     * control keeps a decision made in the previous font. The fix is to observe the SEGMENTS,
     * whose boxes do change — and that is what this asserts, because it is the part a stubbed
     * observer over stubbed geometry can actually witness. The pixels are the browser sweep's.
     */
    const { el } = mount(900, 100);
    expect(observed, "the control does not watch its own box").toContain(el);
    expect(observed, "the control does not watch its parent").toContain(el.parentElement);
    const segs = [...el.children];
    expect(segs.length).toBeGreaterThan(1);
    for (const seg of segs) {
      expect(
        observed,
        "the control does not watch its segments — a font change moves them without moving " +
          "either box it does watch, so nothing would wake the measurement",
      ).toContain(seg);
    }
  });

  it("re-measures when the FONT changes, not only when the labels do", async () => {
    /**
     * The remembered row width was invalidated by the labels alone — but the font is a second
     * input to it and changes without them: a face switch (the other face draws in a mono that
     * runs wider), or a webfont finishing load. A control stacked under the wide face kept that
     * width after a switch to the narrow one and stayed a list; worse, one measured under a
     * NARROW font and then drawn in a wide one would unstack into a row it cannot hold.
     *
     * The observer is fired by hand here because jsdom has no font metrics to change. That the
     * control WOULD be woken by such a change is the case above, and the two are only worth
     * anything together.
     */
    const { el } = mount(420, 180);
    resize();
    expect(el.hasAttribute("data-stack")).toBe(true);
    // Same labels, different font — and now they are narrow enough to stand as a row.
    el.style.fontFamily = "monospace";
    stubSegments(el, 40);
    resize();
    await frames();
    expect(el.hasAttribute("data-stack"), "a new font was judged by the old font's measurement")
      .toBe(false);
  });

  it("an UNREADABLE measurement stacks — the component agrees with its own helper", () => {
    /**
     * `shouldStack` maps a non-finite width to the stacked form on purpose: a stacked list cannot
     * overflow. The component returned early instead and left whatever form it had — on a first
     * measurement the ROW, with nowrap flex-none segments painting outside the capsule. So it
     * contradicted the helper it delegates to, in the one direction both are written to avoid,
     * and the existing non-finite case only exercised the helper.
     */
    const { el } = mount(900, 100);
    // An unreadable padding read makes the whole sum non-finite.
    el.style.padding = "";
    Object.defineProperty(el, "children", { value: [], configurable: true });
    stubSegments(el, 100);
    el.style.padding = "NaNpx";
    resize();
    expect(
      el.hasAttribute("data-stack"),
      "an unreadable measurement left the control in row form — the overflow direction",
    ).toBe(true);
  });

  it("re-measures itself after the one-frame row form, rather than waiting for a resize", async () => {
    /**
     * When nothing is remembered and the DOM is still stacked, the row's width cannot be read at
     * all — every segment is a full-width line — so the control stands in row form for ONE frame
     * and measures there. It must then come back on its own: the capsule is
     * `width: max-content; max-width: 100%`, so where the longest label is already as wide as the
     * container, changing form does not change the element's box and no observer callback fires.
     *
     * This case is written so that the one-frame unstack is NOT the answer: the room is still too
     * small, so the correct end state is stacked again. A control that unstacked and then waited
     * for a resize that never came would be left in the overflowing row form — which is the whole
     * defect. Asserting the unstack instead would have passed either way, and did: the first
     * version of this test stayed green against exactly that mutation.
     */
    const { el } = mount(420, 180);
    resize();
    expect(el.hasAttribute("data-stack")).toBe(true);
    // A new font forgets the remembered width; the segments are still far too wide for 420px.
    el.style.fontFamily = "monospace";
    stubSegments(el, 200);
    resize();
    await frames();
    expect(
      el.hasAttribute("data-stack"),
      "the control unstacked to measure and never came back — a row wider than its card",
    ).toBe(true);
  });

  it("WITHOUT a ResizeObserver the row form stands — every older test renders what it did", () => {
    // The server, and any DOM with no layout: there is nothing to measure, and a stacked guess
    // would change what eight call sites render for no reason.
    (globalThis as unknown as { ResizeObserver: undefined }).ResizeObserver = undefined;
    const { el } = mount(200, 400);
    expect(el.hasAttribute("data-stack")).toBe(false);
  });
});
