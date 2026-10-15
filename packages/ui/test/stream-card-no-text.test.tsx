/** @vitest-environment jsdom */
/**
 * A CARD WHOSE MESSAGE HAS NO TEXT PART STILL RENDERS. The card pages its body through `pageEnds`,
 * which reads `text.length`, so a null text part threw out of the render. The stored text part is
 * `NOT NULL DEFAULT ''` and no typed caller hands the card a null, so the card reads one as empty.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { StreamCard } from "@ohmail/ui";

afterEach(cleanup);

const card = (body: string | null) => (
  <StreamCard
    id="m1" from="Ann" time="09:00" subject="Hello" body={body as string}
    expandLabel="Expand" collapseLabel="Collapse" moreLabel={(p: number) => `more ${p}`}
  />
);

describe("StreamCard with no text part", () => {
  it("renders, opens, and offers no further page", () => {
    const { container } = render(card(null));
    const article = container.querySelector("article");
    expect(article).not.toBeNull();
    fireEvent.click(article!);
    expect(container.querySelector("button.msg-page-more")).toBeNull();
  });

  it("a card with a text part draws it (the positive control)", () => {
    const { container } = render(card("A short note."));
    fireEvent.click(container.querySelector("article")!);
    expect(container.textContent).toContain("A short note.");
  });
});
