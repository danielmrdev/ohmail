/** @vitest-environment jsdom */
/**
 * THE DOORBELL DOES NOT GROW WITH THE QUEUE, and the circle is legible by
 * construction.
 *
 * The cap fixes a regression, and an instructive one: the doorbell had always rendered one avatar
 * per waiting sender, and that was fine for as long as the Screener was structurally empty
 * on Cloud accounts. The moment the Screener became real, a seeded mailbox with a long queue of waiting
 * senders drew as many letters — measured live, far wider than the pane — and pushed the label and the
 * "Screener ›" affordance off the right of the pane. The count was never the problem; the
 * stack pretending to be the count was.
 *
 * So the assertion is a bound, not a number of pixels: however many senders arrive, at most
 * `max` circles are drawn and the remainder becomes one "+N". A pixel assertion would be
 * a lie in jsdom, which lays nothing out.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Avatar, Doorbell } from "@ohmail/ui";

afterEach(cleanup);

const initials = (n: number) =>
  Array.from({ length: n }, (_, i) => String.fromCharCode(65 + (i % 26)));

const circles = (root: HTMLElement) => [...root.querySelectorAll(".doorbell .avs .av:not(.more)")];
const overflow = (root: HTMLElement) => root.querySelector(".doorbell .avs .av.more");

describe("the Screener hint is capped", () => {
  it("more waiting senders than circles draw four circles and one overflow count", () => {
    // THE GUARD. Delete the `slice` in `Doorbell` and this reads 86 — which is the live
    // failure, in the same units it was reported in.
    const { container } = render(
      <Doorbell actionLabel="Screener ›" initials={initials(86)} message="86 new senders waiting" onPress={() => {}} />,
    );
    expect(circles(container)).toHaveLength(4);
    expect(overflow(container)?.textContent).toBe("+82");
  });

  it("the bound holds at 5, 200 and 2000 — it is a cap, not a coincidence at 86", () => {
    for (const n of [5, 200, 2000]) {
      const { container, unmount } = render(
        <Doorbell actionLabel="Screener ›" initials={initials(n)} message={`${n} waiting`} onPress={() => {}} />,
      );
      expect(circles(container).length, `${n} senders`).toBeLessThanOrEqual(4);
      expect(overflow(container)?.textContent).toBe(`+${n - 4}`);
      unmount();
    }
  });

  it("under the cap there is no +N at all", () => {
    const { container } = render(
      <Doorbell actionLabel="Screener ›" initials={initials(3)} message="3 waiting" onPress={() => {}} />,
    );
    expect(circles(container)).toHaveLength(3);
    expect(overflow(container)).toBeNull();
  });

  it("the label and the action survive — they are what the hint is FOR", () => {
    const onPress = vi.fn();
    const { container, getByText } = render(
      <Doorbell
        initials={initials(86)}
        message="86 new senders waiting"
        actionLabel="Screener ›"
        onPress={onPress}
      />,
    );
    expect(getByText("86 new senders waiting")).toBeTruthy();
    expect(container.querySelector(".db-go")?.textContent).toBe("Screener ›");
  });

  it("max={0} means no faces, not slice(0, -1) quietly losing one sender", () => {
    const { container } = render(
      <Doorbell actionLabel="Screener ›" initials={initials(7)} max={0} message="7 waiting" onPress={() => {}} />,
    );
    expect(circles(container)).toHaveLength(0);
    expect(overflow(container)?.textContent).toBe("+7");
  });
});

describe("the sender circle carries a hue, and only a hue", () => {
  it("a hue becomes a custom property; lightness and chroma stay in the stylesheet", () => {
    // The caller may pass any angle; it cannot pass a lightness. That is what makes
    // "legible in light and dark" a property of `avatar.css` rather than of every call
    // site remembering to pick a dark enough colour.
    const { container } = render(<Avatar initials="L" hue={196} />);
    const el = container.querySelector<HTMLElement>(".av")!;
    expect(el.className).toContain("tinted");
    expect(el.style.getPropertyValue("--av-h")).toBe("196");
  });

  it("no hue is the untinted circle the Screener already shipped", () => {
    const { container } = render(<Avatar initials="L" />);
    const el = container.querySelector<HTMLElement>(".av")!;
    expect(el.className).not.toContain("tinted");
    expect(el.getAttribute("style")).toBeNull();
  });
});
