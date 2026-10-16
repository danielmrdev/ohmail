/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DWELL_MS, EVIDENCE_WINDOW_MS, READING_LINE, createReaderSeen } from "../app/shell/reader-seen";
import { scrollIntoViewProgrammatically, scrollProgrammatically, stampLive } from "../app/shell/programmatic-scroll";

/**
 * THE READER-SEEN CORE, numbers only: a sibling panel is committed only by a PERSON's scroll — rule A
 * (a downward pass past its end), rule B (2 s at the reading line) and the end-of-reader rule (at the
 * scroll end, every panel wholly in view) — and a scroll is the person's only with EVIDENCE within a
 * second before it: a wheel, touch or pointer press on the scroller, a scroll key the app did not
 * take, or the frame clause (pointer on a frame, document focused, height steady, no focus,
 * selection or key move in the last second). A stamped app write is never one. jsdom has no
 * layout: panel rects come from `at`; the scroller is 1 000 px tall, so the line is at 330. Each
 * deciding line is mutated in turn and a case below goes red (the changes file lists them).
 */

const H = 1000;
let at: Record<string, { top: number; bottom: number }> = {};
let height = 5000;
let ch = 1000;
let cw = 600;
let top = 0;
let hovered = false;
let focused = true;
let shown = true;
let seen: string[] = [];
let scroller: HTMLDivElement;
let core: ReturnType<typeof createReaderSeen> | null = null;

function panel(id: string, unseen = true): HTMLElement {
  const el = document.createElement("article");
  el.dataset.convId = id;
  if (unseen) el.setAttribute("data-unseen", "");
  el.getBoundingClientRect = () => ({ ...at[id]!, left: 0, right: 600, width: 600, height: at[id]!.bottom - at[id]!.top, x: 0, y: at[id]!.top, toJSON: () => ({}) }) as DOMRect;
  scroller.appendChild(el);
  return el;
}
function mount(opened = "open"): void {
  core = createReaderSeen({
    scroller, openedId: opened, onSeen: (id) => seen.push(id),
    frameHovered: () => hovered, documentFocused: () => focused, visible: () => shown,
  });
}
const fire = (type: string, target: EventTarget = scroller, init: EventInit = {}) => target.dispatchEvent(new Event(type, { bubbles: true, ...init }));
const wheel = () => fire("wheel");
const touch = () => fire("touchmove");
const key = (k: string, init: KeyboardEventInit = {}, target: EventTarget = scroller) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
const scroll = () => scroller.dispatchEvent(new Event("scroll"));
/** Move every panel up by `dy` and deliver the scroller's scroll event. */
const scrollBy = (dy: number) => {
  for (const r of Object.values(at)) { r.top -= dy; r.bottom -= dy; }
  top += dy;
  scroll();
};
const later = (ms: number) => vi.advanceTimersByTime(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T09:00:00Z"));
  at = {}; height = 5000; ch = 1000; cw = 600; top = 0; hovered = false; focused = true; shown = true; seen = [];
  scroller = document.createElement("div");
  Object.defineProperty(scroller, "clientHeight", { get: () => ch });
  Object.defineProperty(scroller, "clientWidth", { get: () => cw });
  Object.defineProperty(scroller, "scrollHeight", { get: () => height });
  Object.defineProperty(scroller, "scrollTop", { get: () => top, set: (v: number) => { top = v; } });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: H, left: 0, right: 600, width: 600, height: H, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(scroller);
});
afterEach(() => {
  core?.dispose();
  core = null;
  scroller.remove();
  vi.useRealTimers();
});

describe("the numbers", () => {
  it("are the ruling's", () => {
    expect([READING_LINE, DWELL_MS, EVIDENCE_WINDOW_MS]).toEqual([0.33, 2000, 1000]);
  });
});

describe("rule A — a downward pass past a panel's end", () => {
  it("commits p1-p3 carried above the line by a wheel, not p4 still below it", () => {
    at = { p1: { top: 100, bottom: 400 }, p2: { top: 420, bottom: 700 }, p3: { top: 720, bottom: 900 }, p4: { top: 920, bottom: 1500 } };
    for (const id of Object.keys(at)) panel(id);
    mount();
    wheel();
    scrollBy(600);
    expect(seen).toEqual(["p1", "p2", "p3"]);
  });
  it("a panel already above the line at the open is never committed by rule A (upward reading)", () => {
    at = { old: { top: -800, bottom: 200 }, p2: { top: 400, bottom: 900 } };
    panel("old"); panel("p2");
    mount();
    wheel();
    scrollBy(-50);
    expect(seen).toEqual([]);
  });
  it("the baseline commits nothing, whatever it finds", () => {
    at = { p1: { top: -500, bottom: -100 }, p2: { top: 340, bottom: 360 } };
    panel("p1"); panel("p2");
    mount();
    expect(seen).toEqual([]);
  });
  it("the opened panel and a read one are never committed", () => {
    at = { open: { top: 100, bottom: 400 }, read: { top: 420, bottom: 700 } };
    panel("open"); panel("read", false);
    mount("open");
    wheel();
    scrollBy(600);
    expect(seen).toEqual([]);
  });
});

describe("evidence before attribution", () => {
  const one = () => { at = { p1: { top: 300, bottom: 500 } }; panel("p1"); mount(); };
  it("a scroll 1 000 ms after the wheel is the person's, 1 001 ms is not", () => {
    one(); wheel(); later(1000); scrollBy(300);
    expect(seen).toEqual(["p1"]);
  });
  it("1 001 ms after the wheel it is not", () => {
    one(); wheel(); later(1001); scrollBy(300);
    expect(seen).toEqual([]);
  });
  it("a touch move and a touch start are evidence", () => {
    one(); touch(); scrollBy(300);
    expect(seen).toEqual(["p1"]);
  });
  it("a pointer press on the scroller (its scrollbar) is evidence; one on a panel inside it is not", () => {
    one(); fire("pointerdown", scroller.firstElementChild!); scrollBy(300);
    expect(seen, "a press on a panel").toEqual([]);
    scrollBy(-300);
    fire("pointerdown"); scrollBy(300);
    expect(seen).toEqual(["p1"]);
  });
  it("a scroll key the app did not take is evidence; one it took is not", () => {
    one();
    const taken = new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true });
    taken.preventDefault();
    scroller.dispatchEvent(taken);
    scrollBy(300);
    expect(seen, "a key the app consumed").toEqual([]);
    scrollBy(-300);
    key("PageDown"); scrollBy(300);
    expect(seen).toEqual(["p1"]);
  });
  it("j (not a scroll key) is no evidence", () => {
    one(); key("j"); scrollBy(300);
    expect(seen).toEqual([]);
  });
  it("a scroll with no input at all commits nothing and the next human one does not inherit it", () => {
    one(); scrollBy(300); wheel(); scrollBy(10);
    expect(seen, "the unattributed pass consumed p1's record").toEqual([]);
  });
});

describe("the frame clause", () => {
  const two = () => { at = { p1: { top: 100, bottom: 400 }, p2: { top: 420, bottom: 700 } }; panel("p1"); panel("p2"); };
  it("pointer on a frame, focused, height steady, nothing moved for a second: a bare scroll is the person's", () => {
    two();
    const human: number[] = [];
    core = createReaderSeen({ scroller, openedId: "open", onSeen: (id) => seen.push(id), frameHovered: () => hovered, documentFocused: () => focused, visible: () => shown, onHumanScroll: () => human.push(1) });
    hovered = true;
    scrollBy(450);
    expect(seen).toEqual(["p1", "p2"]);
    expect(human.length, "the anchor's handover is told").toBe(1);
  });
  it("a focus move within the second before: nothing (a focus() that scrolled)", () => {
    two(); mount(); hovered = true;
    fire("focusin", document.body); later(999); scrollBy(450);
    expect(seen).toEqual([]);
  });
  it("a selection change within the second before: nothing (find-in-page)", () => {
    two(); mount(); hovered = true;
    document.dispatchEvent(new Event("selectionchange")); later(500); scrollBy(450);
    expect(seen).toEqual([]);
  });
  it("a selection moved with its event still to come: nothing (WebKit's find scrolls first)", () => {
    two(); mount(); hovered = true;
    const t = document.createTextNode("WORDU4"); document.body.appendChild(t);
    document.getSelection()!.selectAllChildren(document.body);
    scrollBy(450);
    expect(seen).toEqual([]);
    t.remove();
  });
  it("any key within the second before: nothing (j, Tab, Enter)", () => {
    two(); mount(); hovered = true;
    key("Tab", {}, document.body); scrollBy(450);
    expect(seen).toEqual([]);
  });
  it("the document not focused: nothing", () => {
    two(); mount(); hovered = true; focused = false; scrollBy(450);
    expect(seen).toEqual([]);
  });
  it("the height changed (a frame measuring, scroll anchoring): nothing", () => {
    two(); mount(); hovered = true; height += 300; scrollBy(450);
    expect(seen).toEqual([]);
  });
  it("not hovered and no input: nothing", () => {
    two(); mount(); scrollBy(450);
    expect(seen).toEqual([]);
  });
});

describe("the viewport's own geometry (the window grows at the scroll end)", () => {
  const two = () => { at = { p1: { top: 100, bottom: 400 }, p2: { top: 420, bottom: 700 } }; panel("p1"); panel("p2"); };
  it("the viewport grown taller under a resting pointer: nothing, and nothing from the dwell", () => {
    two(); mount(); hovered = true; later(1200);
    ch = 1140; scrollBy(450);
    later(DWELL_MS * 2);
    expect(seen).toEqual([]);
  });
  it("the viewport grown wider: nothing", () => {
    two(); mount(); hovered = true; later(1200);
    cw = 900; scrollBy(450);
    expect(seen).toEqual([]);
  });
  it("a window resize voids the evidence path for a second, and drops a running dwell", () => {
    two(); mount();
    wheel(); window.dispatchEvent(new Event("resize")); scrollBy(450);
    expect(seen, "a wheel just before the resize").toEqual([]);
    later(1001); scrollBy(-450); wheel(); scrollBy(450);
    expect(seen, "a second later a person's scroll counts again").toEqual(["p1", "p2"]);
  });
  it("a resize drops a dwell a person's scroll armed", () => {
    at = { tall: { top: 200, bottom: 3200 } }; panel("tall"); mount();
    wheel(); scrollBy(100); later(500);
    window.dispatchEvent(new Event("resize"));
    later(DWELL_MS * 2);
    expect(seen).toEqual([]);
  });
  it("the evidence path takes the geometry check too: a wheel, then the content grows under the scroll", () => {
    two(); mount();
    wheel(); height += 300; scrollBy(450);
    expect(seen).toEqual([]);
  });
});

describe("a later key, focus or selection move voids the evidence", () => {
  const one = () => { at = { p1: { top: 300, bottom: 500 } }; panel("p1"); mount(); };
  it("a wheel, then Tab 200 ms later: the scroll that follows is not the person's", () => {
    one(); wheel(); later(200); key("Tab", {}, document.body); scrollBy(300);
    expect(seen).toEqual([]);
  });
  it("a wheel, then a focus move 300 ms later: nothing", () => {
    one(); wheel(); later(300); fire("focusin", document.body); scrollBy(300);
    expect(seen).toEqual([]);
  });
  it("a wheel, then a selection change: nothing", () => {
    one(); wheel(); document.dispatchEvent(new Event("selectionchange")); scrollBy(300);
    expect(seen).toEqual([]);
  });
  it("a touch on a control, then the focus it takes: the scroll that follows is not the person's", () => {
    one(); const btn = document.createElement("button"); scroller.appendChild(btn);
    fire("touchstart", btn); fire("focusin", btn); scrollBy(300);
    expect(seen).toEqual([]);
  });
  it("focus landing on the scroller itself moves nothing and voids nothing", () => {
    one(); wheel(); fire("focusin", scroller); scrollBy(300);
    expect(seen).toEqual(["p1"]);
  });
  it("a free scroll key is its own evidence, its keydown notwithstanding", () => {
    one(); key("PageDown"); scrollBy(300);
    expect(seen).toEqual(["p1"]);
  });
});

describe("the stamp is the frame's, not the clock's", () => {
  it("a scroll landing on the stamped value is never a reading, even inside a wheel's second", () => {
    at = { p1: { top: 100, bottom: 400 } }; panel("p1"); mount();
    wheel(); hovered = true;
    for (const r of Object.values(at)) { r.top -= 500; r.bottom -= 500; }
    scrollProgrammatically(scroller, 500);
    scroll();
    expect(seen).toEqual([]);
    later(DWELL_MS * 2);
    expect(seen, "the stamped scroll also cancelled the dwell").toEqual([]);
  });
  it("a scroll that left the stamped value is judged on its own evidence", () => {
    at = { p1: { top: 300, bottom: 500 } }; panel("p1"); mount();
    scrollProgrammatically(scroller, 0);
    wheel(); scrollBy(300);
    expect(seen).toEqual(["p1"]);
  });
  it("scrollIntoView stamps every ancestor where it ended", () => {
    const dock = document.createElement("div"); scroller.appendChild(dock);
    scrollIntoViewProgrammatically(dock, { block: "end" });
    expect(stampLive(scroller)).toBe(true);
  });
});

describe("rule B — the dwell, and the end of the reader", () => {
  const tall = () => { at = { tall: { top: 200, bottom: 3200 } }; return panel("tall"); };
  it("an older panel entering from above commits at 2 000 ms, not at 1 999", () => {
    at = { old: { top: -900, bottom: -100 }, open: { top: 0, bottom: 1200 } };
    panel("old"); panel("open", false); mount("open");
    wheel(); scrollBy(-500);
    later(1999); expect(seen).toEqual([]);
    later(1); expect(seen).toEqual(["old"]);
  });
  it("a 3 000 px panel whose end never passes the line is read by the dwell alone", () => {
    tall(); mount(); wheel(); scrollBy(100);
    later(DWELL_MS); expect(seen).toEqual(["tall"]);
  });
  it("an unattributed scroll at 1 500 ms cancels it", () => {
    tall(); mount(); wheel(); scrollBy(100); later(1200); // past the wheel's second, inside the dwell
    scrollBy(5); later(DWELL_MS);
    expect(seen).toEqual([]);
  });
  it("a press that read the panel meanwhile leaves the fire with nothing to write", () => {
    const el = tall(); mount(); wheel(); scrollBy(100); later(1500);
    el.removeAttribute("data-unseen"); later(600);
    expect(seen).toEqual([]);
  });
  it("the page going hidden cancels the dwell, even if it is back before the fire", () => {
    tall(); mount(); wheel(); scrollBy(100); later(500);
    shown = false; document.dispatchEvent(new Event("visibilitychange"));
    shown = true;
    later(DWELL_MS * 2);
    expect(seen).toEqual([]);
  });
  it("a fire while the page is hidden writes nothing", () => {
    tall(); mount(); wheel(); scrollBy(100); later(500);
    shown = false;
    later(DWELL_MS * 2);
    expect(seen).toEqual([]);
  });
  it("at the scroll end, every short panel wholly in view is read by the dwell", () => {
    at = { open: { top: -400, bottom: 600 }, t1: { top: 620, bottom: 700 }, t2: { top: 720, bottom: 800 } };
    panel("open", false); panel("t1"); panel("t2");
    height = 1800; mount("open");
    wheel(); top = 799; scrollBy(1); // 800 + 1000 = 1800: the end
    expect(seen, "neither passes the line").toEqual([]);
    later(DWELL_MS);
    expect(seen).toEqual(["t1", "t2"]);
  });
  it("short of the end, only the panel spanning the line", () => {
    at = { open: { top: -400, bottom: 600 }, t1: { top: 620, bottom: 700 }, t2: { top: 720, bottom: 800 } };
    panel("open", false); panel("t1"); panel("t2");
    height = 5000; mount("open");
    wheel(); scrollBy(1);
    later(DWELL_MS);
    expect(seen).toEqual([]);
  });
});

describe("the top of the reader (the first-letter twin of the end rule)", () => {
  /** Twenty letters of 234 px, 12 apart, the opened one (newest) last: the tester's conversation. */
  const conversation = (): string[] => {
    const ids = Array.from({ length: 20 }, (_, i) => `m${i}`);
    height = 20 + ids.length * 246;
    top = height - ch;
    at = Object.fromEntries(ids.map((id, i) => [id, { top: 20 + i * 246 - top, bottom: 20 + i * 246 + 234 - top }]));
    ids.forEach((id, i) => panel(id, i < ids.length - 1));
    mount(ids[ids.length - 1]);
    return ids;
  };
  /** Wheel steps of `step` until scrollTop reaches `to`. */
  const wheelTo = (to: number, step = 300): void => {
    while (top !== to) { wheel(); scrollBy(Math.sign(to - top) * Math.min(step, Math.abs(to - top))); }
  };
  /** A short first letter, the reader resting on it after the person's own scroll up. */
  const atTheTop = (): void => {
    at = { first: { top: 20, bottom: 254 }, second: { top: 266, bottom: 500 }, third: { top: 512, bottom: 746 }, open: { top: 758, bottom: 1400 } };
    panel("first"); panel("second"); panel("third"); panel("open", false);
    height = 2000;
    for (const r of Object.values(at)) { r.top -= 300; r.bottom -= 300; }
    top = 300; mount("open");
  };

  it("scrolled from its first letter to its last after a dwell at the top, every letter is read", () => {
    const ids = conversation();
    wheelTo(0);
    later(4000);
    wheelTo(height - ch);
    later(DWELL_MS);
    expect([...new Set(seen)].sort()).toEqual(ids.slice(0, -1).sort());
  });
  it("a short first letter, wholly above the line at the top, is read by the dwell at 2 000 ms, not 1 999", () => {
    atTheTop();
    wheel(); scrollBy(-300);
    later(DWELL_MS - 1);
    expect(seen).toEqual([]);
    later(1);
    expect(seen).toEqual(["first", "second"]);
  });
  it("short of the top by two pixels, the first letter waits", () => {
    atTheTop();
    wheel(); scrollBy(-298);
    later(DWELL_MS);
    expect(seen).toEqual(["second"]);
  });
  it("a letter wholly in view below the line is not read at the top: it has the line still to pass", () => {
    atTheTop();
    wheel(); scrollBy(-300);
    later(DWELL_MS);
    expect(seen).not.toContain("third");
  });
  it("a jump to the top is a glance: nothing from the dwell, nothing when the person then scrolls on", () => {
    atTheTop();
    for (const r of Object.values(at)) { r.top += 300; r.bottom += 300; }
    scrollProgrammatically(scroller, 0);
    scroll();
    later(DWELL_MS * 2);
    expect(seen, "the jump").toEqual([]);
    wheel(); scrollBy(300);
    later(DWELL_MS);
    expect(seen, "scrolled on from the jump").not.toContain("first");
  });
  it("a jump to the top inside a wheel's second is still the app's", () => {
    atTheTop();
    wheel();
    for (const r of Object.values(at)) { r.top += 300; r.bottom += 300; }
    scrollProgrammatically(scroller, 0);
    scroll();
    later(DWELL_MS * 2);
    expect(seen).toEqual([]);
  });
  it("a resize at the top drops the dwell the person's scroll armed", () => {
    atTheTop();
    wheel(); scrollBy(-300);
    later(500);
    window.dispatchEvent(new Event("resize"));
    later(DWELL_MS * 2);
    expect(seen).toEqual([]);
  });
});
