/** @vitest-environment jsdom */
/**
 * InfoNote — the compact (i) disclosure.
 *
 * THREE PROPERTIES, AND EACH ONE IS A WAY THE IDIOM STOPS BEING WORTH USING.
 *
 * 1. Closed by default. It exists to stop long explanations spending vertical space until
 *    somebody asks; one that renders open has given the space straight back.
 * 2. The lead is a REAL toggle to assistive technology, named by its own text. `<summary>` is
 *    what gives that for free, so the assertion is on the role rather than on the tag: a
 *    rewrite to a `<div>` with a click handler would look identical and announce nothing.
 * 3. The default triangle is gone. It is a `list-style` on the summary, and the reason it is
 *    asserted at all is that the rule lives in a stylesheet this test does not load — so what
 *    is checked here is the CLASS the rule hangs off, which is the part the component owns.
 */
import { describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach } from "vitest";
import { InfoNote } from "@ohmail/ui";

afterEach(cleanup);

describe("InfoNote", () => {
  it("starts collapsed, with the lead on screen and the detail behind the toggle", () => {
    const { container, getByRole } = render(
      <InfoNote lead="The one line that matters." moreLabel="More about this list">
        The three that do not, until asked.
      </InfoNote>,
    );

    const details = container.querySelector<HTMLDetailsElement>("details.infonote")!;
    expect(details.open).toBe(false);

    // The toggle is a button to AT, and its accessible name carries both the lead and the
    // label — a reader gets the sentence AND what pressing it will do.
    const toggle = getByRole("group").querySelector("summary")!;
    expect(toggle.className).toContain("infonote-sum");
    expect(toggle.textContent).toContain("The one line that matters.");
    expect(toggle.textContent).toContain("More about this list");

    expect(details.querySelector(".infonote-lead")!.textContent).toBe("The one line that matters.");
    expect(details.querySelector(".infonote-more")!.textContent).toBe(
      "The three that do not, until asked.",
    );
  });

  it("keeps a caller's className alongside its own, so a host stylesheet still reaches it", () => {
    // `.view-note` and `.d-note` size and colour these notes where they are used; the
    // component must not take the class over.
    const { container } = render(
      <InfoNote lead="Lead." moreLabel="More about this" className="view-note">
        Detail.
      </InfoNote>,
    );
    const details = container.querySelector("details")!;
    expect(details.classList.contains("infonote")).toBe(true);
    expect(details.classList.contains("view-note")).toBe(true);
  });
});
