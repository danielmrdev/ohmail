/** @vitest-environment jsdom */
/**
 * GLOSS — detail on demand, the (i) whose sentence opens beside it.
 *
 * What is held here is the part a hover-only affordance gets wrong, in the order a person meets
 * it: the sentence is the trigger's accessible NAME (a reader who never sees a card gets it on
 * focus), hover opens it, focus opens it, a press pins it, Escape closes it without moving focus,
 * an outside press closes it, and nothing traps focus — Tab leaves and takes the card with it.
 * The placement is a pure function over three rectangles and is tested with numbers, because the
 * promise is "inside the window", which a jsdom layout cannot show.
 *
 * Mutation-proven at authoring time: removing `aria-label` from the trigger reddens the name case
 * and no other; removing the Escape arm reddens the Escape case alone; removing the pointerenter
 * handler reddens the hover case alone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { GLOSS_EDGE, GLOSS_GAP, Gloss, placeGloss } from "@ohmail/ui";

afterEach(cleanup);

const SENTENCE = "This computer files this mailbox: it moves mail into your folders, screens strangers and applies your rules.";

function card(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(".gloss-pop")!;
}

describe("Gloss — the trigger", () => {
  it("is a button NAMED by the sentence, collapsed at rest, with the card hidden but present", () => {
    const { container, getByRole } = render(<Gloss text={SENTENCE} />);
    const btn = getByRole("button", { name: SENTENCE });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    // The card is in the DOM closed as well as open, and is a visual echo of the name — hidden
    // from the tree so nothing is read twice.
    expect(card(container).hidden).toBe(true);
    expect(card(container).getAttribute("aria-hidden")).toBe("true");
    expect(card(container).textContent).toBe(SENTENCE);
  });

  it("with a caption, the caption is the name and the sentence is the description", () => {
    const { container, getByRole } = render(<Gloss text={SENTENCE} caption="Tracker blocked" />);
    const btn = getByRole("button", { name: "Tracker blocked", description: SENTENCE });
    expect(btn).toBeTruthy();
    // The description is computable while the card is CLOSED — that is why it stays in the DOM.
    expect(card(container).hidden).toBe(true);
    expect(card(container).getAttribute("role")).toBe("tooltip");
    expect(btn.getAttribute("aria-describedby")).toBe(card(container).id);
  });

  it("carries the placement as a class and keeps a caller's className", () => {
    const { container } = render(<Gloss text={SENTENCE} placement="chip" className="mbx-gloss" />);
    const root = container.querySelector(".gloss")!;
    expect(root.classList.contains("gloss-chip")).toBe(true);
    expect(root.classList.contains("mbx-gloss")).toBe(true);
    const { container: c2 } = render(<Gloss text={SENTENCE} />);
    expect(c2.querySelector(".gloss")!.classList.contains("gloss-meta")).toBe(true);
  });
});

describe("Gloss — opening and closing", () => {
  it("hover opens it and leaving closes it (a mouse pointer)", async () => {
    const user = userEvent.setup();
    const { container, getByRole } = render(<Gloss text={SENTENCE} />);
    const btn = getByRole("button");
    await user.hover(btn);
    expect(card(container).hidden).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    await user.unhover(btn);
    expect(card(container).hidden).toBe(true);
  });

  it("a touch's pointerenter does not open it — the tap's click does", () => {
    const { container, getByRole } = render(<Gloss text={SENTENCE} />);
    const btn = getByRole("button");
    fireEvent.pointerEnter(btn, { pointerType: "touch" });
    expect(card(container).hidden).toBe(true);
    fireEvent.click(btn);
    expect(card(container).hidden).toBe(false);
  });

  it("focus opens it; Tab leaves and takes the card with it — nothing traps focus", async () => {
    const user = userEvent.setup();
    const { container, getByRole } = render(
      <>
        <Gloss text={SENTENCE} />
        <button type="button">after</button>
      </>,
    );
    // By class, not by name: this case is about focus, and finding the trigger by its name would
    // make it red for the name mutation too — one case per property.
    const btn = container.querySelector<HTMLButtonElement>(".gloss-t")!;
    await user.tab();
    expect(document.activeElement).toBe(btn);
    expect(card(container).hidden).toBe(false);
    await user.tab();
    expect(document.activeElement).toBe(getByRole("button", { name: "after" }));
    expect(card(container).hidden).toBe(true);
  });

  it("a press pins it: the pointer may leave and it stands; a second press closes it", async () => {
    const user = userEvent.setup();
    const { container, getByRole } = render(<Gloss text={SENTENCE} />);
    const btn = getByRole("button");
    await user.click(btn);
    expect(card(container).hidden).toBe(false);
    await user.unhover(btn);
    expect(card(container).hidden).toBe(false);
    await user.click(btn);
    expect(card(container).hidden).toBe(true);
  });

  it("Escape closes it and keeps focus on the trigger, and is stopped only when it did something", async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    try {
      const { container, getByRole } = render(<Gloss text={SENTENCE} />);
      const btn = getByRole("button");
      await user.click(btn);
      expect(card(container).hidden).toBe(false);
      await user.keyboard("{Escape}");
      expect(card(container).hidden).toBe(true);
      expect(document.activeElement).toBe(btn);
      // Consumed: the shell's Escape ladder must not also act on it.
      expect(outer).not.toHaveBeenCalled();
      // Nothing open: the key belongs to whoever is listening further out.
      await user.keyboard("{Escape}");
      expect(outer).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", outer);
    }
  });

  it("a press outside closes it", async () => {
    const user = userEvent.setup();
    const { container, getByRole } = render(
      <>
        <Gloss text={SENTENCE} />
        <p>elsewhere</p>
      </>,
    );
    await user.click(getByRole("button"));
    expect(card(container).hidden).toBe(false);
    fireEvent.pointerDown(container.querySelector("p")!);
    expect(card(container).hidden).toBe(true);
  });
});

describe("placeGloss — inside the window, whichever way it opens", () => {
  const vp = { width: 390, height: 844 };
  const size = { width: 260, height: 58 };

  it("opens below a glyph with room under it, starting a little before the glyph", () => {
    const p = placeGloss({ top: 100, bottom: 113, left: 40, right: 53 }, size, vp);
    expect(p.side).toBe("below");
    expect(p.top).toBe(113 + GLOSS_GAP);
    expect(p.left).toBe(40 - GLOSS_EDGE);
  });

  it("flips above a glyph at the foot of the window", () => {
    const p = placeGloss({ top: 800, bottom: 813, left: 40, right: 53 }, size, vp);
    expect(p.side).toBe("above");
    expect(p.top + size.height).toBeLessThanOrEqual(800 - GLOSS_GAP);
    expect(p.top).toBeGreaterThanOrEqual(GLOSS_EDGE);
  });

  it("is pulled back inside on the right edge, and never past the left inset", () => {
    const right = placeGloss({ top: 100, bottom: 113, left: 370, right: 383 }, size, vp);
    expect(right.left + size.width).toBeLessThanOrEqual(vp.width - GLOSS_EDGE);
    const left = placeGloss({ top: 100, bottom: 113, left: 2, right: 15 }, size, vp);
    expect(left.left).toBe(GLOSS_EDGE);
  });

  it("with room neither way it opens below, clamped to the top inset — the start of the sentence stays readable", () => {
    const p = placeGloss({ top: 30, bottom: 43, left: 40, right: 53 }, { width: 260, height: 900 }, vp);
    expect(p.side).toBe("below");
    expect(p.top).toBe(GLOSS_EDGE);
  });

  it("an anchor OUTSIDE the window still gets a card inside it — both axes clamped", () => {
    // A glyph 1 200px down a page whose window is 844px tall (pressed by script, or moved by a
    // relayout): the card must not follow it out of view.
    const low = placeGloss({ top: 1200, bottom: 1213, left: 40, right: 53 }, size, vp);
    expect(low.top).toBeGreaterThanOrEqual(GLOSS_EDGE);
    expect(low.top + size.height).toBeLessThanOrEqual(vp.height - GLOSS_EDGE);
    const high = placeGloss({ top: -300, bottom: -287, left: 40, right: 53 }, size, vp);
    expect(high.top).toBe(GLOSS_EDGE);
    const far = placeGloss({ top: 100, bottom: 113, left: 2000, right: 2013 }, size, vp);
    expect(far.left + size.width).toBeLessThanOrEqual(vp.width - GLOSS_EDGE);
  });
});
