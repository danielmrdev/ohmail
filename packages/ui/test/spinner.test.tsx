/** @vitest-environment jsdom */
/**
 * THE WAITING MARK HOLDS STILL; THE SEGMENT TRAVELS.
 *
 * Reported on the ringed face: the loader was "a square rotating" — the old mark was a bordered
 * box with one accent edge spun by `transform: rotate`, which is a circle's trick (a spinning
 * ring reads as one) and a square's defect (a spinning box reads as a box spinning). The mark is
 * now an SVG frame whose corner radius is the pill token — a circle under paper, a square under
 * ohmarchy — and the motion is the dash offset moving ALONG the path: the box never rotates on
 * either face. Pinned in two halves: the component's markup (two rects, one path space), and the
 * stylesheet (the radius token, the dash animation, and NO rotation anywhere in it).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SettingsVerdict, Spinner } from "@ohmail/ui";

afterEach(cleanup);

// Root-relative: the suite runs from the repo root, and under jsdom `import.meta.url` is not a file: URL.
const css = readFileSync(
  resolve(process.cwd(), "packages/ui/src/primitives/spinner.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

describe("Spinner — the markup", () => {
  it("is an svg frame of two rects in one normalised path space, hidden from readers", () => {
    const { container } = render(<Spinner className="mbx-spin" />);
    const svg = container.querySelector("svg.spin.mbx-spin");
    expect(svg, "no .spin svg").toBeTruthy();
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
    const rects = [...svg!.querySelectorAll("rect")];
    expect(rects.map((r) => r.getAttribute("class"))).toEqual(["spin-track", "spin-run"]);
    // `pathLength="100"` is what makes the dash math shape-independent: a dash of it is the same
    // fraction of a circle's circumference and of a square's perimeter.
    for (const r of rects) expect(r.getAttribute("pathLength")).toBe("100");
  });

  it("the settings verdict's wait state holds the same mark rather than a rotating border", () => {
    const { container } = render(<SettingsVerdict state="wait" headline="Checking…" />);
    expect(container.querySelector(".set-verdict.wait .set-verdict-mark svg.spin")).toBeTruthy();
    const { container: ok } = render(<SettingsVerdict state="ok" headline="Works." />);
    expect(ok.querySelector(".set-verdict-mark svg")).toBeNull();
  });
});

describe("spinner.css — the shape is the radius token, the motion is along the path", () => {
  it("the frame's corners are --r-pill: a circle under paper, a square under ohmarchy", () => {
    expect(css).toMatch(/\.spin rect\{[^}]*rx:var\(--r-pill\)/);
  });

  it("the run is a dash that moves its offset — one lap per cycle", () => {
    expect(css).toMatch(/\.spin \.spin-run\{[^}]*stroke-dasharray:30 70/);
    expect(css).toMatch(/\.spin \.spin-run\{[^}]*animation:spin-lap 1s linear infinite/);
    expect(css).toMatch(/@keyframes spin-lap\{to\{stroke-dashoffset:-100\}\}/);
  });

  it("nothing in the mark rotates, and nothing names a face", () => {
    expect(css).not.toMatch(/rotate\(/);
    expect(css).not.toMatch(/data-face|data-layout/);
  });
});
