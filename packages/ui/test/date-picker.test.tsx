/** @vitest-environment jsdom */
/**
 * THE DATE PICKER — the month grid that replaced a native `<input type="date">`.
 *
 * What the native input cost, and what these cases hold instead:
 *
 *   · The operating system drew the calendar in ITS look, not the product's. Nothing here can
 *     assert taste, so what is asserted is the structure that taste is applied to: six rows
 *     always, weekday headers from `Intl`, one tab stop, day cells that are buttons.
 *   · It opened DOWNWARD and ran off the bottom of the display, from a control standing at the
 *     foot of the reading column. `placeDatePicker` is a pure function over three rectangles, so
 *     the flip is tested with real numbers rather than by hoping a headless layout reproduces
 *     the case — and every one of these cases has a "the card is inside the viewport" assertion,
 *     which is the promise, not "it opened above".
 *   · It was the OS's keyboard, not ours. The grid roves here, and each key is pinned.
 *
 * Dates are CALENDAR DAYS. Every computation runs through `Date.UTC`, so these cases would catch
 * a zone shifting a day — the failure that makes a "tomorrow" floor let yesterday through.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DatePicker,
  DP_EDGE,
  DP_GAP,
  addDays,
  addMonths,
  compareDays,
  dayKey,
  isoWeekday,
  localeWeekStart,
  monthGrid,
  parseDay,
  placeDatePicker,
} from "../src/primitives/DatePicker.js";

afterEach(cleanup);

const LABELS = {
  dialog: "Pick a date",
  prevMonth: "Previous month",
  nextMonth: "Next month",
  today: "today",
};

/** Tuesday 2026-08-04, with the floor one day later — the shell's own shape for a resurface. */
const TODAY = "2026-08-04";
const TOMORROW = "2026-08-05";

function open(over: Partial<React.ComponentProps<typeof DatePicker>> = {}) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  const anchor = document.createElement("button");
  document.body.appendChild(anchor);
  const utils = render(
    <DatePicker
      locale="en"
      today={TODAY}
      min={TOMORROW}
      anchor={anchor}
      labels={LABELS}
      onPick={onPick}
      onClose={onClose}
      {...over}
    />,
  );
  const card = document.querySelector<HTMLElement>(".dp")!;
  const cell = (key: string) => card.querySelector<HTMLButtonElement>(`[data-day="${key}"]`);
  const cells = () => [...card.querySelectorAll<HTMLButtonElement>("[data-day]")];
  return { onPick, onClose, anchor, card, cell, cells, ...utils };
}

/* ══ 1. CALENDAR ARITHMETIC — days, never instants ═══════════════════════════════════════ */

describe("the calendar arithmetic is UTC and therefore zone-proof", () => {
  it("parses and re-emits a day without moving it", () => {
    expect(dayKey(parseDay("2026-08-04")!)).toBe("2026-08-04");
    expect(parseDay("not-a-day")).toBeNull();
    expect(parseDay("2026-8-4"), "a loose form must be refused, not guessed at").toBeNull();
  });

  it("crosses month and year ends", () => {
    expect(dayKey(addDays(parseDay("2026-08-31")!, 1))).toBe("2026-09-01");
    expect(dayKey(addDays(parseDay("2026-12-31")!, 1))).toBe("2027-01-01");
    expect(dayKey(addDays(parseDay("2026-03-01")!, -1))).toBe("2026-02-28");
  });

  it("CLAMPS a month step to the target month's length", () => {
    // "The same day a month earlier" from the 31st has no answer in a 30-day month; spilling
    // into the next one would move the cursor two months and show a month the reader did not ask
    // for. Both directions, and a leap year.
    expect(dayKey(addMonths(parseDay("2026-03-31")!, -1))).toBe("2026-02-28");
    expect(dayKey(addMonths(parseDay("2026-05-31")!, 1))).toBe("2026-06-30");
    expect(dayKey(addMonths(parseDay("2028-03-31")!, -1))).toBe("2028-02-29");
  });

  it("orders days, and calls the same day equal", () => {
    expect(compareDays(parseDay("2026-08-04")!, parseDay("2026-08-05")!)).toBeLessThan(0);
    expect(compareDays(parseDay("2026-08-05")!, parseDay("2026-08-04")!)).toBeGreaterThan(0);
    expect(compareDays(parseDay("2026-08-04")!, parseDay("2026-08-04")!)).toBe(0);
  });

  it("reads ISO weekdays with Sunday as 7, not as 0", () => {
    // 2026-08-03 is a Monday. Sunday coming out as 0 would put the lead-in row one column wrong
    // for every Sunday-first locale.
    expect(isoWeekday(parseDay("2026-08-03")!)).toBe(1);
    expect(isoWeekday(parseDay("2026-08-09")!)).toBe(7);
  });
});

/* ══ 2. THE GRID ═════════════════════════════════════════════════════════════════════════ */

describe("the month grid is always six full weeks", () => {
  it("returns 42 days beginning on the week's first day, whatever the month", () => {
    // A constant height is what makes the flip decided on one month still correct on the next:
    // a five-row month followed by a six-row one would grow the card after it was placed.
    for (const view of [{ y: 2026, m: 2 }, { y: 2026, m: 8 }, { y: 2026, m: 11 }, { y: 2028, m: 2 }]) {
      for (const weekStart of [1, 7] as const) {
        const g = monthGrid(view, weekStart);
        expect(g, `${view.y}-${view.m} weekStart=${weekStart}`).toHaveLength(42);
        expect(isoWeekday(g[0]!), "the grid does not start on the week's first day").toBe(weekStart);
        // Every day of the month is present exactly once, and the neighbours are marked.
        const inside = g.filter((d) => !d.outside);
        expect(inside[0]!.d, "the first day of the month is not the first inside cell").toBe(1);
        expect(new Set(inside.map(dayKey)).size).toBe(inside.length);
      }
    }
  });

  it("takes its week start from the locale, and falls back to Monday", () => {
    expect(localeWeekStart("de")).toBe(1);
    expect(localeWeekStart("not a tag"), "an unknown tag must not throw").toBe(1);
    // `en` is Sunday-first where the runtime knows; either answer is a legal week start.
    expect([1, 7]).toContain(localeWeekStart("en"));
  });

  it("renders six rows of seven day BUTTONS, and one tab stop among them", () => {
    const { card, cells } = open();
    expect(card.getAttribute("role")).toBe("dialog");
    expect(card.getAttribute("aria-label")).toBe("Pick a date");
    expect(cells()).toHaveLength(42);
    for (const c of cells()) expect(c.tagName).toBe("BUTTON");
    expect(card.querySelectorAll(".dp-wd")).toHaveLength(7);
    // The grid ROVES: exactly one cell is tabbable, so Tab does not walk 42 controls.
    expect(cells().filter((c) => c.tabIndex === 0)).toHaveLength(1);
  });

  it("names the month and the weekdays from Intl, in the host's locale", () => {
    const en = open();
    expect(en.card.querySelector(".dp-month")!.textContent).toContain("August");
    cleanup();
    document.body.innerHTML = "";
    const de = open({ locale: "de" });
    // German is the check that nothing is hardcoded English — "August" is spelled the same, so
    // the weekday row is what separates the two.
    const names = [...de.card.querySelectorAll(".dp-wd")].map((n) => n.textContent);
    expect(names.join(" "), "the weekday names are not German").toMatch(/Mo|Di|Mi|Do|Fr|Sa|So/);
    expect(names, "a weekday header is empty").not.toContain("");
  });
});

/* ══ 3. THE FLOOR ════════════════════════════════════════════════════════════════════════ */

describe("days before the floor cannot be chosen", () => {
  it("disables every day before `min`, and marks today without making it pickable", () => {
    const { cell, cells, onPick } = open();
    for (const key of ["2026-08-01", "2026-08-03", TODAY]) {
      expect(cell(key)!.getAttribute("aria-disabled"), `${key} is pickable`).toBe("true");
    }
    expect(cell(TOMORROW)!.getAttribute("aria-disabled"), "tomorrow is not pickable").toBeNull();
    // Today is still MARKED — a reader needs the anchor even when it is out of reach.
    expect(cell(TODAY)!.hasAttribute("data-today")).toBe(true);
    expect(cell(TODAY)!.getAttribute("aria-label")).toContain("today");
    // The first pickable cell in DOM order is tomorrow, not merely "some enabled cell".
    expect(cells().find((c) => !c.hasAttribute("aria-disabled"))!.dataset.day).toBe(TOMORROW);
    // …and pressing a disabled day does nothing at all.
    fireEvent.click(cell(TODAY)!);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("puts the cursor on the first PICKABLE day, never on a disabled one", () => {
    const { cells } = open();
    const stop = cells().find((c) => c.tabIndex === 0)!;
    expect(stop.dataset.day).toBe(TOMORROW);
    expect(stop.getAttribute("aria-disabled")).toBeNull();
  });

  it("starts on the chosen day when there is one, and renders it selected", () => {
    const { cell, cells } = open({ value: "2026-09-15" });
    const stop = cells().find((c) => c.tabIndex === 0)!;
    expect(stop.dataset.day).toBe("2026-09-15");
    expect(cell("2026-09-15")!.getAttribute("aria-selected")).toBe("true");
  });

  it("refuses the previous month while it holds no pickable day", () => {
    const { card } = open();
    // The floor is 2026-08-05, so July has nothing to offer and the arrow says so.
    expect(card.querySelector<HTMLButtonElement>(".dp-nav-prev")!.disabled).toBe(true);
    expect(card.querySelector<HTMLButtonElement>(".dp-nav-next")!.disabled).toBe(false);
  });

  it("carries the host's note for a pickable day, and asks about no other", () => {
    /* WHAT THAT DAY WOULD BOOK. The host owns the sentence because the zone and the hour are
       the host's; this file only has to put it where a reader hears it, and only for days a
       press can reach. A disabled day books nothing, so it is never asked about. */
    const asked: string[] = [];
    const { cell } = open({
      dayNote: (day) => { asked.push(day); return day === TOMORROW ? "09:00" : null; },
    });
    expect(cell(TOMORROW)!.getAttribute("aria-label")).toBe("Wednesday, August 5, 2026, 09:00");
    // A day the host has nothing to say about reads exactly as it did before the prop existed.
    expect(cell("2026-08-06")!.getAttribute("aria-label")).toBe("Thursday, August 6, 2026");
    expect(asked, "a disabled day was asked what it would book").not.toContain(TODAY);
    expect(asked).toContain(TOMORROW);
  });

  it("with no note at all, a cell reads as its date — the prop is the host's to skip", () => {
    const { cell } = open();
    expect(cell(TOMORROW)!.getAttribute("aria-label")).toBe("Wednesday, August 5, 2026");
  });

  it("with no floor at all, every day is pickable and the past is reachable", () => {
    // The floor is the HOST's rule, not the primitive's — a picker used for a past date must not
    // inherit the resurface chooser's horizon.
    const { cell, card } = open({ min: undefined });
    expect(cell("2026-08-01")!.getAttribute("aria-disabled")).toBeNull();
    expect(card.querySelector<HTMLButtonElement>(".dp-nav-prev")!.disabled).toBe(false);
  });
});

/* ══ 4. THE KEYBOARD ═════════════════════════════════════════════════════════════════════ */

describe("the grid is operable from the keyboard", () => {
  /** Press a key on whatever cell currently holds focus, as a reader would. */
  const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
  const at = () => (document.activeElement as HTMLElement).dataset.day;

  it("moves a day, a week, and a month — and follows the cursor across a month edge", () => {
    open();
    expect(at()).toBe(TOMORROW);
    press("ArrowRight");
    expect(at()).toBe("2026-08-06");
    press("ArrowDown");
    expect(at()).toBe("2026-08-13");
    press("ArrowUp");
    expect(at()).toBe("2026-08-06");
    press("ArrowLeft");
    expect(at()).toBe(TOMORROW);
    press("PageDown");
    expect(at()).toBe("2026-09-05");
    // The shown month followed the cursor — a tab stop on a hidden cell is a dead keyboard.
    expect(document.querySelector(".dp-month")!.textContent).toContain("September");
    press("PageUp");
    expect(at()).toBe(TOMORROW);
    expect(document.querySelector(".dp-month")!.textContent).toContain("August");
  });

  it("Home and End reach the ends of the cursor's own week", () => {
    open({ min: undefined, value: "2026-08-12" }); // a Wednesday, mid-week
    expect(at()).toBe("2026-08-12");
    press("Home");
    const first = at()!;
    press("End");
    const last = at()!;
    expect(compareDays(parseDay(first)!, parseDay(last)!)).toBeLessThan(0);
    // Six days apart, whichever day the locale starts its week on.
    expect(dayKey(addDays(parseDay(first)!, 6))).toBe(last);
  });

  it("Enter and Space pick the focused day; a disabled day answers neither", () => {
    const a = open();
    press("Enter");
    expect(a.onPick).toHaveBeenCalledWith(TOMORROW);
    cleanup();
    document.body.innerHTML = "";
    const b = open();
    press(" ");
    expect(b.onPick).toHaveBeenCalledWith(TOMORROW);
    cleanup();
    document.body.innerHTML = "";
    // Walk BACK onto a disabled day and press: the cursor may stand there, the answer may not.
    const c = open();
    press("ArrowLeft");
    expect(at()).toBe(TODAY);
    press("Enter");
    expect(c.onPick, "a day before the floor was picked from the keyboard").not.toHaveBeenCalled();
  });

  /**
   * THE MONTH ARROWS ARE ORDINARY BUTTONS, AND THE GRID'S KEYS MUST NOT REACH THEM.
   *
   * Found by review, and it was the worst kind of defect this component could have: the key
   * handler sits on the dialog ROOT, so a keydown on a nav button bubbled to it, `preventDefault`
   * suppressed the button's own activation, and the `Enter` arm then picked the CURSOR's day. So
   * pressing Enter on "Next month" did not change the month — it scheduled a resurface for a day
   * the reader never chose and closed the picker to prove it. A keyboard reader could not reach
   * any month but the first.
   */
  it("Enter on a month arrow steps the month — it does NOT pick the cursor's day", () => {
    const { onPick, onClose, card } = open();
    const next = card.querySelector<HTMLButtonElement>(".dp-nav-next")!;
    next.focus();
    fireEvent.keyDown(next, { key: "Enter" });
    // The arrow's own activation must survive: nothing is picked, nothing is closed.
    expect(onPick, "Enter on the month arrow picked a date").not.toHaveBeenCalled();
    expect(onClose, "Enter on the month arrow closed the picker").not.toHaveBeenCalled();
    // …and Space likewise, which is the other key a button activates on.
    fireEvent.keyDown(next, { key: " " });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("stepping a month leaves FOCUS on the arrow, so it can be pressed again", () => {
    /**
     * The other half of the same defect. `showMonth` moves the cursor as well as the view, and
     * the focus effect followed it — off the arrow and into the new month's grid. So the arrow
     * worked exactly once and every further step needed a Shift+Tab back to it.
     */
    const { card } = open();
    const next = card.querySelector<HTMLButtonElement>(".dp-nav-next")!;
    next.focus();
    fireEvent.click(next);
    expect(document.querySelector(".dp-month")!.textContent).toContain("September");
    expect(document.activeElement, "the arrow lost focus the moment it was used")
      .toBe(document.querySelector(".dp-nav-next"));
    // A second press therefore reaches the arrow, not a day cell — August → September → October.
    fireEvent.click(document.querySelector<HTMLButtonElement>(".dp-nav-next")!);
    expect(document.querySelector(".dp-month")!.textContent).toContain("October");
  });

  it("AN ADJACENT MONTH'S DAY CAN BE PRESSED — focus arrives before the click completes", () => {
    /**
     * Found by review, and it was introduced by the previous round's fix for the tab stop.
     *
     * A real pointer press is `mousedown` → focus → `mouseup` → `click`. When `onFocus` changed
     * the shown MONTH, that first step unmounted the very cell being pressed, so `click` landed
     * on nothing and `onPick` never ran: a neighbouring month's day was unselectable by mouse,
     * and the month jumped instead. **The existing case missed it because `fireEvent.click`
     * dispatches a click with no focus step** — the synthetic event skipped exactly the part
     * that broke.
     *
     * So this dispatches the real sequence. The fix keeps the view still on focus, and clamps
     * the cursor into the shown month in `showMonth` instead, where it cannot race a press.
     */
    const { onPick, card } = open({ min: undefined });
    const cell = card.querySelector<HTMLButtonElement>('[data-day="2026-07-27"]')!;
    expect(cell.hasAttribute("data-outside"), "2026-07-27 is not a neighbour's cell here").toBe(true);
    const month = () => document.querySelector(".dp-month")!.textContent;
    const before = month();
    /* `fireEvent.focus`, not `cell.focus()` — and the difference is the whole test. A bare
       `.focus()` is not act-wrapped, so React never flushes the re-render between the focus and
       the click and the cell stays mounted whatever the handler did. The browser DOES flush
       there, which is why this defect was real and my first version of this case passed against
       the very code it was written to catch. */
    fireEvent.mouseDown(cell);
    fireEvent.focus(cell);
    fireEvent.mouseUp(cell);
    fireEvent.click(cell);
    expect(onPick, "a day in the neighbouring month could not be pressed").toHaveBeenCalledWith("2026-07-27");
    expect(month(), "the month moved out from under the press").toBe(before);
    /* And the cell the press landed on is still the one in the document — the check that would
       fail if the grid re-rendered it into another row mid-press. */
    expect(document.querySelector('[data-day="2026-07-27"]'), "the pressed cell left the DOM")
      .toBe(cell);
  });

  it("THE GRID ALWAYS HAS EXACTLY ONE TAB STOP, wherever the cursor has been", () => {
    /**
     * The invariant the previous round's fix was really for, stated as the invariant rather than
     * as the mechanism that used to deliver it. A neighbour's cell is `aria-disabled`, not
     * `disabled`, so it can hold focus and become the cursor. Stepping the month by the same
     * amount would then put the cursor two months from the shown grid, where NO cell carries it
     * — and `tabIndex={isCursor ? 0 : -1}` gives every cell -1, so Tab skips the calendar
     * entirely and the focus effect's own lookup finds nothing.
     */
    const { card } = open({ min: undefined });
    const stops = () => [...document.querySelectorAll<HTMLButtonElement>(".dp [data-day]")]
      .filter((c) => c.tabIndex === 0);
    expect(stops(), "the grid did not start with one tab stop").toHaveLength(1);
    // Put the cursor on a cell belonging to the PREVIOUS month, then step forward twice.
    fireEvent.focus(card.querySelector<HTMLButtonElement>('[data-day="2026-07-27"]')!);
    expect(stops(), "focusing a neighbour's cell lost the tab stop").toHaveLength(1);
    fireEvent.click(document.querySelector<HTMLButtonElement>(".dp-nav-next")!);
    expect(stops(), "one month step lost the tab stop").toHaveLength(1);
    fireEvent.click(document.querySelector<HTMLButtonElement>(".dp-nav-next")!);
    expect(stops(), "a second month step lost the tab stop").toHaveLength(1);
  });

  it("Escape still closes from a month arrow — the one key that is not the grid's", () => {
    const { onClose, card } = open();
    const prevBtn = card.querySelector<HTMLButtonElement>(".dp-nav-next")!;
    prevBtn.focus();
    fireEvent.keyDown(prevBtn, { key: "Escape" });
    expect(onClose, "Escape from the head did not close the dialog").toHaveBeenCalledTimes(1);
  });

  it("Escape asks the HOST to close — the host owns focus return", () => {
    const { onClose, onPick } = open();
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("a key the picker handles reaches NOTHING else", () => {
    /**
     * The shell's key registry listens on `document` too, and `b` / `a` / `e` are horizons. An
     * arrow press that bubbled out of this dialog would be handled twice — the same boundary
     * `MoreMenu` states, and the reason `stopImmediatePropagation` is called on the native event
     * rather than `stopPropagation` alone.
     */
    const heard: string[] = [];
    const spy = (e: Event) => heard.push((e as KeyboardEvent).key);
    document.addEventListener("keydown", spy);
    try {
      open();
      press("ArrowRight");
      press("Escape");
      expect(heard, "a handled key escaped the dialog and reached the shell").toEqual([]);
    } finally {
      document.removeEventListener("keydown", spy);
    }
  });

  it("a key it does NOT handle is left alone", () => {
    // The complement of the case above: claiming every key would swallow the shell's own
    // shortcuts while a picker happens to be open.
    const heard: string[] = [];
    const spy = (e: Event) => heard.push((e as KeyboardEvent).key);
    document.addEventListener("keydown", spy);
    try {
      open();
      press("q");
      expect(heard).toEqual(["q"]);
    } finally {
      document.removeEventListener("keydown", spy);
    }
  });
});

/* ══ 5. PLACEMENT — below when it fits, above when it does not, never off-screen ══════════ */

describe("placement", () => {
  const VIEW = { width: 1200, height: 900 };
  const SIZE = { width: 256, height: 268 };
  const anchorAt = (top: number, height = 30, left = 400) =>
    ({ top, bottom: top + height, left, right: left + 120 });

  it("opens BELOW when the whole card fits there", () => {
    const p = placeDatePicker(anchorAt(200), SIZE, VIEW);
    expect(p.side).toBe("below");
    expect(p.top).toBe(230 + DP_GAP);
  });

  it("opens ABOVE when the room below is short — the reported defect", () => {
    /**
     * The resurface strip stands at the FOOT of the reading column, so this is the ordinary
     * case, not the edge one: an anchor at 800 in a 900px window leaves 92px below and needs
     * 268. The native input opened downward here and ran off the display.
     *
     * Mutation that must go red: delete the `above` branch and let it always open below.
     */
    const p = placeDatePicker(anchorAt(800), SIZE, VIEW);
    expect(p.side, "the card opened below a control at the foot of the column").toBe("above");
    expect(p.top).toBe(800 - DP_GAP - SIZE.height);
    // The promise is not "above" — it is "on screen".
    expect(p.top).toBeGreaterThanOrEqual(DP_EDGE);
    expect(p.top + SIZE.height).toBeLessThanOrEqual(VIEW.height - DP_EDGE);
  });

  it("stays inside the viewport even when NEITHER side has room", () => {
    // A short window: 420px tall with the anchor in the middle. Neither side fits 268, so the
    // card is clamped rather than painted off an edge — the one thing it may never do.
    const view = { width: 1200, height: 420 };
    const p = placeDatePicker(anchorAt(190), SIZE, view);
    expect(p.top).toBeGreaterThanOrEqual(DP_EDGE);
    expect(p.top + SIZE.height).toBeLessThanOrEqual(view.height - DP_EDGE);
  });

  it("clamps the LEFT edge at both ends of the window", () => {
    const right = placeDatePicker(anchorAt(200, 30, 1150), SIZE, VIEW);
    expect(right.left + SIZE.width, "the card runs off the right edge")
      .toBeLessThanOrEqual(VIEW.width - DP_EDGE);
    const left = placeDatePicker(anchorAt(200, 30, -50), SIZE, VIEW);
    expect(left.left, "the card runs off the left edge").toBeGreaterThanOrEqual(DP_EDGE);
    // …and where there is room it simply aligns to the anchor.
    expect(placeDatePicker(anchorAt(200, 30, 400), SIZE, VIEW).left).toBe(400);
  });

  it("never leaves the viewport, over a sweep of anchors and window heights", () => {
    // The invariant rather than four examples: whatever the anchor and however short the window,
    // the card is inside it on both axes.
    for (const height of [420, 560, 720, 900, 1200]) {
      for (let top = -40; top <= height + 40; top += 23) {
        const view = { width: 1200, height };
        const p = placeDatePicker(anchorAt(top), SIZE, view);
        expect(p.top, `h=${height} anchor=${top}`).toBeGreaterThanOrEqual(DP_EDGE);
        expect(p.top + SIZE.height, `h=${height} anchor=${top}`)
          .toBeLessThanOrEqual(view.height - DP_EDGE);
        expect(["above", "below"]).toContain(p.side);
      }
    }
  });

  it("A WINDOW SMALLER THAN THE CARD: the card caps itself so the clamp can hold", () => {
    /**
     * Found by review, and the promise was genuinely unkeepable as written. The card was a FIXED
     * 256×~268px, so in a window narrower than 276 or shorter than 288 the clamp pinned the near
     * edge to the 10px inset and the FAR edge stayed outside — the last week of the month could
     * not be reached. The clamp was doing all it could; the card was the thing that would not
     * yield. My own sweep never saw it because every height it used was ≥ 420.
     *
     * The card now caps itself in CSS, and that is what makes the arithmetic correct rather than
     * a second clamp arguing with the first: the component measures `offsetWidth`/`offsetHeight`
     * AFTER layout, so a capped card reports its capped size and the existing single
     * `Math.max`/`Math.min` pair then keeps it inside.
     */
    const css = readFileSync(
      resolve(process.cwd(), "packages/ui/src/primitives/date-picker.css"), "utf8",
    );
    const rule = /\.dp\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(rule, "the picker's card rule is gone — re-derive this test").not.toBe("");
    /* In the page's own px: under the web door's Text size (a CSS zoom on <html>) a bare `100vw`
       renders zoom times the window, so the cap divides by `--ui-zoom` (1 where none is stamped). */
    expect(rule, "the card cannot shrink below the window's width").toContain("max-width:calc(100vw / var(--ui-zoom, 1) - 20px)");
    expect(rule, "the card cannot shrink below the window's height").toContain("max-height:calc(100vh / var(--ui-zoom, 1) - 20px)");
    /* The concession, and it is the right one: on a window too small for a month the grid scrolls
       INSIDE the card rather than putting days outside it. */
    expect(rule, "a capped card with no overflow would simply hide the days it cannot show")
      .toContain("overflow:auto");
    /* And the near edge is still pinned for a caller that hands in an oversized box, so the
       function alone never returns a negative coordinate. */
    const p = placeDatePicker(
      { top: 100, bottom: 130, left: 100, right: 220 },
      { width: 400, height: 400 },
      { width: 300, height: 260 },
    );
    expect(p.top, "an oversized card was placed above the window").toBe(DP_EDGE);
    expect(p.left, "an oversized card was placed left of the window").toBe(DP_EDGE);
  });

  it("records the side it chose on the card, for a rendered check to read", () => {
    const { card } = open();
    expect(["above", "below"]).toContain(card.getAttribute("data-side"));
  });
});

/* ══ 6. DISMISSAL ════════════════════════════════════════════════════════════════════════ */

describe("dismissal", () => {
  it("an outside press closes it — on mousedown, so the press that opened it cannot", () => {
    const { onClose } = open();
    // `click` must NOT close it: the opening press is a mousedown/mouseup pair, and a click
    // listener would receive the opening gesture's own click and shut the card immediately.
    fireEvent.click(document.body);
    expect(onClose, "a click dismissed it — the opening press would close it too")
      .not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a press INSIDE the card, or on the anchor, does not close it", () => {
    const { onClose, card, anchor } = open();
    fireEvent.mouseDown(card.querySelector(".dp-month")!);
    fireEvent.mouseDown(anchor);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("picking a day answers the host once, with a calendar day", () => {
    const { onPick, cell } = open();
    fireEvent.click(cell("2026-08-20")!);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("2026-08-20");
  });
});
