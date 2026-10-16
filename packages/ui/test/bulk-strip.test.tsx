/** @vitest-environment jsdom */
/**
 * THE BULK STRIP — one shape for the verbs over a list, and one well for an ask with a price.
 *
 * The Screener's head used to be six loose 11.5px pieces in a wrapping flex row, with a size
 * ladder drawn in a token no stylesheet defines. The composite gives it one anatomy: a row of
 * same-height capsules, a run's progress as sentence + track, and the ask as a flat tinted
 * well wearing `data-state` — the Send verb's state vocabulary on the verb that spends. These
 * pin the markup and the state dress; the view's own tests pin what the words say.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { AskWell, BulkProgress, BulkStrip, Button, SizeLadder } from "@ohmail/ui";

afterEach(cleanup);

const strip = readFileSync(
  resolve(process.cwd(), "packages/ui/src/composites/bulk-strip.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");
const button = readFileSync(
  resolve(process.cwd(), "packages/ui/src/primitives/button.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

describe("AskWell — the ask as one block, wearing its state", () => {
  it.each(["idle", "working", "done", "refused"] as const)("wears data-state=%s", (state) => {
    const { container } = render(<AskWell state={state} label="Suggest for the first" actions={<Button>Go</Button>} />);
    const well = container.querySelector(".scn-suggest")!;
    expect(well.getAttribute("data-state")).toBe(state);
    expect(well.getAttribute("role")).toBe("group");
    // Only a working well announces busy — a refused one is a sentence to read, not a wait.
    expect(well.getAttribute("aria-busy")).toBe(state === "working" ? "true" : null);
  });

  it("puts the status and the note in live regions, and omits the note's box when there is none", () => {
    const { container } = render(
      <AskWell state="idle" label="L" status="12 senders · 12 credits" actions={<Button>Go</Button>} />,
    );
    expect(container.querySelector(".scn-sg-price")!.getAttribute("role")).toBe("status");
    expect(container.querySelector(".scn-sg-price")!.textContent).toBe("12 senders · 12 credits");
    expect(container.querySelector(".scn-sg-note")).toBeNull();
    const { container: noted } = render(<AskWell state="refused" label="L" note="Stopped — credits ran out." actions={<Button>Go</Button>} />);
    expect(noted.querySelector(".scn-sg-note")!.getAttribute("role")).toBe("status");
  });
});

describe("SizeLadder — the rungs are the segmented control", () => {
  it("renders the seg in its scope size, presses the chosen rung, and reports a choice", () => {
    const onChange = vi.fn();
    const { container } = render(
      <SizeLadder sizes={[10, 25, 74]} value={25} onChange={onChange} labelOf={(n) => (n === 74 ? `all ${n}` : n)} />,
    );
    const seg = container.querySelector(".seg.scope.scn-sg-sizes")!;
    expect(seg).toBeTruthy();
    const rungs = [...seg.querySelectorAll("button.scn-sg-size")];
    expect(rungs.map((b) => b.textContent)).toEqual(["10", "25", "all 74"]);
    expect(rungs.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
    expect(rungs[1]!.className).toContain("on");
    fireEvent.click(rungs[2]!);
    expect(onChange).toHaveBeenCalledWith(74);
  });
});

describe("BulkProgress — sentence + track, never a track without a denominator", () => {
  it("announces the sentence and hides the track from readers", () => {
    const { container } = render(<BulkProgress label="Applying 7 of 40…" done={7} total={40} />);
    expect(container.querySelector(".scn-applying-lab")!.getAttribute("role")).toBe("status");
    const track = container.querySelector<HTMLProgressElement>("progress.scn-prog")!;
    expect(track.getAttribute("aria-hidden")).toBe("true");
    expect(track.value).toBe(7);
    expect(track.max).toBe(40);
  });

  it("a total of 0 draws no track — an indeterminate bar is a run that claims to be in flight for ever", () => {
    const { container } = render(<BulkProgress label="Applying…" done={0} total={0} />);
    expect(container.querySelector("progress")).toBeNull();
  });
});

describe("the strip's stylesheet — one capsule size, tokens only", () => {
  it("BulkStrip is the row, and its capsules take the decision bar's size", () => {
    const { container } = render(<BulkStrip ariaLabel="Act"><Button>A</Button></BulkStrip>);
    expect(container.querySelector(".scn-bulk[role=group]")!.getAttribute("aria-label")).toBe("Act");
    /* The size is the LITERAL plus the phone step's slot. Re-baselined rather than loosened: the
       assertion still pins 11.5px exactly, and it now also pins that this capsule takes the step —
       a declaration that lost the slot would render a pixel smaller than the bar beside it at
       phone width, which is the drift `phone-type-census.test.ts` exists to catch and this line
       would otherwise have hidden by matching either spelling. */
    expect(strip).toMatch(
      /\.scn-bulk \.btn\{[^}]*font-size:calc\(11\.5px \+ var\(--type-up\)\);padding:5\.5px 13px/,
    );
  });

  it("the well is the settings verdict's construction — inset hairline, --tint, --r-card", () => {
    const well = /\.scn-suggest\{([^}]*)\}/.exec(strip)?.[1] ?? "";
    expect(well).toContain("background:var(--tint)");
    expect(well).toContain("border-radius:var(--r-card)");
    expect(well).toContain("box-shadow:inset 0 0 0 1px var(--hair-soft)");
    expect(well).toContain("flex-basis:100%");
  });

  it("every colour in the strip is a token — the undefined --line and --chip are gone", () => {
    expect(strip).not.toMatch(/var\(--line\)|var\(--chip\)/);
    expect(strip).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(strip).not.toMatch(/data-face|data-layout/);
  });
});

describe("button.css — `data-run` is the Send verb's dress on any capsule", () => {
  it("working passes the band along the foot; done completes it; both share Send's keyframes", () => {
    expect(button).toMatch(/\.btn\[data-run="working"\]::after\{animation:send-pass 1\.4s linear infinite\}/);
    expect(button).toMatch(/\.btn\[data-run="done"\]::after\{[^}]*animation:send-done \.32s var\(--swift\) both\}/);
    // The band is the accent on a panel capsule and the on-accent light on a primary one.
    expect(button).toMatch(/\.btn\[data-run="working"\]::after,\.btn\[data-run="done"\]::after\{[^}]*background:var\(--accent\)/);
    expect(button).toMatch(/\.btn\.primary\[data-run\]::after\{background:var\(--on-accent\)/);
  });

  it("a working capsule keeps its face and refuses the flat disabled look", () => {
    const { container } = render(<Button data-run="working" disabled aria-busy="true">Suggesting…</Button>);
    expect(container.querySelector(".btn[data-run=working]:disabled")).toBeTruthy();
    expect(button).toMatch(/\.btn\[data-run="working"\]:disabled[^{]*\{[^}]*background:var\(--panel\);color:var\(--ink\)/);
  });
});
