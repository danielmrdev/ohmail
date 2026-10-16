/** @vitest-environment jsdom */
/**
 * TEXT FIELD — the one treatment for typed text.
 *
 * The component is thin on purpose, so what is held is thin too: it renders the element the
 * caller asked for, wears the treatment's classes beside the caller's own, passes every native
 * attribute through and forwards the ref. The look lives in `text-field.css`, which jsdom cannot
 * compute, so the two rules of the stylesheet a reader would otherwise have to trust are read out
 * of the file: the box declares its edge, and the line shape withdraws it AFTER the box so it wins
 * by order at the same specificity — the reason it is one class and not `.tf.tf-line`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TextField } from "@ohmail/ui";

afterEach(cleanup);

describe("TextField", () => {
  it("is an input by default, in the box shape, with native attributes passed through", () => {
    const ref = createRef<HTMLInputElement>();
    const { container } = render(
      <TextField ref={ref} aria-label="Address" placeholder="you@example.org" readOnly value="x" onChange={() => {}} />,
    );
    const el = container.querySelector("input")!;
    expect(el.className).toBe("tf");
    expect(el.type).toBe("text");
    expect(el.getAttribute("aria-label")).toBe("Address");
    expect(el.placeholder).toBe("you@example.org");
    expect(el.readOnly).toBe(true);
    expect(ref.current).toBe(el);
  });

  it("keeps the input type a caller names", () => {
    const { container } = render(<TextField type="search" aria-label="Filter" />);
    expect(container.querySelector("input")!.type).toBe("search");
  });

  it("`multiline` is a textarea and marks itself as the area", () => {
    const ref = createRef<HTMLTextAreaElement>();
    const { container } = render(<TextField multiline ref={ref} rows={4} aria-label="Note" />);
    const el = container.querySelector("textarea")!;
    expect(el.className).toBe("tf tf-area");
    expect(el.rows).toBe(4);
    expect(ref.current).toBe(el);
    expect(container.querySelector("input")).toBeNull();
  });

  it("the line shape, mono and a caller's class ride beside the treatment, never instead of it", () => {
    const { container } = render(<TextField shape="line" mono className="rcp-input" aria-label="To" />);
    const el = container.querySelector("input")!;
    expect(el.classList.contains("tf")).toBe(true);
    expect(el.classList.contains("tf-line")).toBe(true);
    expect(el.classList.contains("tf-mono")).toBe(true);
    expect(el.classList.contains("rcp-input")).toBe(true);
  });

  it("disabled reaches the element", () => {
    const { container } = render(<TextField disabled aria-label="Held" />);
    expect(container.querySelector("input")!.disabled).toBe(true);
  });
});

/**
 * FOCUS LEFT, NOT BLURRED. WebKitGTK answers an assistive tool's focus request on a field that
 * already has focus by blurring it and focusing it again inside one call; a field that unmounted
 * on that blur killed the web process. The door is asked one task later and only
 * if focus did not come back.
 */
describe("TextField onFocusLeft", () => {
  const task = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

  it("a blur that focus comes back from in the same task is not a leave", async () => {
    const left = vi.fn();
    const { container } = render(<TextField aria-label="New tag" onFocusLeft={left} />);
    const el = container.querySelector("input")!;
    el.focus();
    // The focus reset an AT-SPI grab_focus performs on an already-focused field.
    el.blur();
    el.focus();
    await task();
    expect(left).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(el);
  });

  it("focus moving elsewhere is a leave, once, one task after the blur and not inside it", async () => {
    const left = vi.fn();
    const blur = vi.fn();
    const { container } = render(
      <>
        <TextField aria-label="New tag" onFocusLeft={left} onBlur={blur} />
        <button type="button">Elsewhere</button>
      </>,
    );
    const el = container.querySelector("input")!;
    el.focus();
    container.querySelector("button")!.focus();
    expect(blur, "the caller's own onBlur still runs, at once").toHaveBeenCalledTimes(1);
    expect(left, "never inside the blur's dispatch").not.toHaveBeenCalled();
    await task();
    expect(left).toHaveBeenCalledTimes(1);
  });

  it("the multiline field takes the same door", async () => {
    const left = vi.fn();
    const { container } = render(<TextField multiline aria-label="Note" onFocusLeft={left} />);
    const el = container.querySelector("textarea")!;
    el.focus();
    el.blur();
    el.focus();
    await task();
    expect(left).not.toHaveBeenCalled();
    el.blur();
    await task();
    expect(left).toHaveBeenCalledTimes(1);
  });

  it("a field removed before the check is not told it was left", async () => {
    const left = vi.fn();
    const { container, unmount } = render(<TextField aria-label="New tag" onFocusLeft={left} />);
    const el = container.querySelector("input")!;
    el.focus();
    el.blur();
    unmount();
    await task();
    expect(left).not.toHaveBeenCalled();
  });
});

describe("text-field.css — the two rules a reader would otherwise have to trust", () => {
  const css = readFileSync(resolve(__dirname, "..", "src", "primitives", "text-field.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const block = (sel: string): string => {
    const i = css.indexOf(`${sel}{`);
    expect(i, `no rule for ${sel}`).toBeGreaterThan(-1);
    return css.slice(i, css.indexOf("}", i));
  };

  it("the box draws a 1px edge from the hair token on the canvas ground — present while empty", () => {
    const box = block(".tf");
    expect(box).toMatch(/border:1px solid var\(--hair\)/);
    expect(box).toMatch(/background:var\(--canvas\)/);
    // Nothing conditions the edge on content: no `:placeholder-shown` rule withdraws it.
    expect(css).not.toMatch(/placeholder-shown/);
  });

  it("focus is a ring from the focus tokens, with the edge withdrawn under it", () => {
    const focus = block(".tf:focus-visible");
    expect(focus).toMatch(/outline:var\(--focus-w\) solid var\(--focus,var\(--accent\)\)/);
    expect(focus).toMatch(/border-color:transparent/);
  });

  it("the line shape withdraws the box, is one class, and is declared after the box", () => {
    const line = block(".tf-line");
    expect(line).toMatch(/border:0/);
    expect(line).toMatch(/background:none/);
    expect(css.indexOf(".tf-line{")).toBeGreaterThan(css.indexOf(".tf{"));
    expect(css).not.toMatch(/\.tf\.tf-line/);
  });

  it("every size sits in the phone band with the floor a text control needs", () => {
    for (const m of css.matchAll(/font-size:[^;}]*/g)) {
      if (/\d+(?:\.\d+)?px/.test(m[0])) {
        expect(m[0]).toContain("var(--input-floor)");
        expect(m[0]).toContain("var(--type-up)");
      }
    }
  });
});
