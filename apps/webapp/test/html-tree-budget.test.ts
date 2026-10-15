import { describe, expect, it } from "vitest";
import { MAX_PARSE_WORK, treeStepper, treeWithin } from "@ohmail/client-engine/html-tree-budget";

/**
 * treeWithin COUNTS THE TREE A BROWSER BUILDS, UNDER A BUDGET. The shapes here are the ones a string
 * scan diverges from: active-formatting reconstruction (`L` unclosed `<b>` × `R` paragraphs builds
 * `L·R` elements from `~7L + 4R` bytes), through every unwrapped special element, in quirks and
 * no-quirks mode. Every count below was read equal in parse5, Chromium 151 and WebKit 26 (the
 * amplifying shapes, element for element). The bound catches them where a scan does not.
 */

const FRAME = { elements: 2_048 as const };
const PARSE = { elements: 4_096 as const };
const FRAME_TEXT = { elements: 2_048, textChars: 131_072 };

/** `n` unclosed formatting elements, each with a distinct class so Noah's Ark keeps them all. */
const opens = (n: number): string => Array.from({ length: n }, (_, i) => `<b class="c${i}">`).join("");
/** `R` paragraphs, each of which re-opens every still-open formatting element. */
const paras = (r: number): string => "<p>t</p>".repeat(r);
const quirksAndStd = (html: string): string[] => [html, `<!doctype html>${html}`];

/**
 * The amplifying trees a sanitized document re-parses into (the boundary the sanitizer removed is
 * already gone here — which boundary it was is the sanitizer's business, tested through the
 * component). An inner block element closes the open `<p>` and the formatting list re-opens every
 * `<b>` in the next block, so `L` openings and `R` blocks build `L·R` elements.
 */
const pCloserAmp = (closer = "<p>t</p>", r = 1500, l = 400): string => `<p>${opens(l)}${closer.repeat(r)}</p>`;
/** The first-parse amplifier straight from the review (`amp-parse`): the openings are closed, the
 *  paragraphs follow at body level and re-open the still-listed formatting elements. */
const parseAmp = (inner = paras(1600), l = 400): string => `<p>${opens(l)}</p>${inner}`;
/** `<li>` after the special element that wrapped it is gone: each `<li>` re-opens the formatting. */
const liAmp = (r = 1500, l = 400): string => `<ul><li>${opens(l)}${"<li>t</li>".repeat(r)}</li></ul>`;

describe("treeWithin: the element bound", () => {
  it("admits a document at the bound and refuses the tree one element past it", () => {
    // Paragraphs plus html/head/body exactly at the bound fit; one more element is past.
    const at = treeWithin(`<body>${"<p>x</p>".repeat(2_045)}</body>`, FRAME);
    expect(at.fits && at.elements).toBe(2_048);
    const past = treeWithin(`<body>${"<p>x</p>".repeat(2_046)}</body>`, FRAME);
    expect(past).toEqual({ fits: false, past: "elements" });
  });

  it("counts the tree the parser builds, not the string: a flat string of escaped markup is text", () => {
    const r = treeWithin("&lt;p&gt;".repeat(5_000), FRAME);
    expect(r.fits).toBe(true);
    expect(r.fits && r.elements).toBeLessThan(10);
  });
});

describe("treeWithin: the reviewer's amplifying trees read past, in quirks and no-quirks mode", () => {
  // What the FRAME parses (the boundary already removed): past the frame bound.
  const frameShapes: Array<[string, string]> = [
    ["p-closer via p (button/object/applet/marquee removed)", pCloserAmp()],
    ["p-closer via div", pCloserAmp("<div>t</div>")],
    ["p-closer via ul", pCloserAmp("<ul>t</ul>")],
    ["li-closer (form/fieldset/menu removed)", liAmp()],
    ["template content", `<template>${parseAmp()}</template>`],
    ["noscript content (scripting off)", `<noscript>${parseAmp()}</noscript>`],
    ["svg foreignObject", `<svg><foreignObject>${parseAmp()}</foreignObject></svg>`],
    ["math annotation-xml text/html", `<math><annotation-xml encoding="text/html">${parseAmp()}</annotation-xml></math>`],
  ];
  for (const [name, html] of frameShapes) {
    it(`frame bound: ${name}`, () => {
      for (const variant of quirksAndStd(html)) {
        expect(treeWithin(variant, FRAME_TEXT), `${name} fit the frame bound`).toEqual({ fits: false, past: "elements" });
      }
    });
  }

  // What the FIRST parse sees (`amp-parse`): past the parse bound.
  const parseShapes: Array<[string, string]> = [
    ["raw paragraphs", parseAmp()],
    ["div blocks", parseAmp("<div>t</div>".repeat(1_600))],
    ["ul blocks", parseAmp("<ul>t</ul>".repeat(1_600))],
  ];
  for (const [name, html] of parseShapes) {
    it(`parse bound: ${name}`, () => {
      for (const variant of quirksAndStd(html)) {
        expect(treeWithin(variant, PARSE), `${name} fit the parse bound`).toEqual({ fits: false, past: "elements" });
      }
    });
  }

  it("2,000 flat tables are past the frame bound (the layout residual)", () => {
    expect(treeWithin("<table><tr><td>x</td></tr></table>".repeat(2_000), FRAME)).toEqual({ fits: false, past: "elements" });
  });
});

describe("treeWithin: fits where the tree is small, whatever the string looks like", () => {
  it("a <p> inside <select> is ignored, so the select amplifier fits", () => {
    // In select, every `<p>`, `<b>` and `<div>` is dropped: the tree stays tiny though the string is huge.
    for (const variant of quirksAndStd(`<select><option>${parseAmp()}</option></select>`)) {
      const r = treeWithin(variant, FRAME);
      expect(r.fits).toBe(true);
      expect(r.fits && r.elements).toBeLessThan(100);
    }
  });

  it("an ordinary long newsletter fits with room to spare", () => {
    const rows = Array.from({ length: 100 }, (_, n) =>
      `<tr><td style="padding:12px"><a href="https://example.com/${n}">Row ${n}</a></td><td>Oct ${n % 28}</td></tr>`).join("");
    const r = treeWithin(`<table width="600">${rows}</table>`, FRAME_TEXT);
    expect(r.fits).toBe(true);
    expect(r.fits && r.elements).toBeLessThan(2_048 / 2);
  });

  it("a 1,998-element designed document fits the frame bound", () => {
    const rows = Array.from({ length: 399 }, (_, n) =>
      `<tr><td style="padding:12px"><a href="https://example.com/${n}">Row ${n}</a><br>more</td><td>Oct ${n % 28}</td></tr>`).join("");
    const r = treeWithin(`<table width="600">${rows}</table>`, FRAME_TEXT);
    expect(r.fits).toBe(true);
  });

  it("tables that fit stay under the bound (300 deep, 500 flat)", () => {
    expect(treeWithin("<table><tr><td>".repeat(300) + "x", FRAME).fits).toBe(true);
    expect(treeWithin("<table><tr><td>x</td></tr></table>".repeat(500), FRAME).fits).toBe(true);
  });
});

describe("treeWithin: the text bound, style excluded", () => {
  it("a newsletter of 70 KB of <style> and 70 KB of text fits; its style does not count", () => {
    const style = `<style>${"a{color:red}".repeat(6_000)}</style>`; // ~72 KB
    const text = `<p>${"word ".repeat(14_000)}</p>`; // ~70 KB of text, one element
    const r = treeWithin(style + text, FRAME_TEXT);
    expect(r.fits).toBe(true);
    expect(r.fits && r.textChars).toBeLessThan(131_072);
    expect(r.fits && r.textChars).toBeGreaterThan(65_536);
  });

  it("131,073 characters of body text is past the text bound", () => {
    expect(treeWithin(`<p>${"a".repeat(131_073)}</p>`, FRAME_TEXT)).toEqual({ fits: false, past: "text" });
    expect(treeWithin(`<p>${"a".repeat(131_072)}</p>`, FRAME_TEXT).fits).toBe(true);
  });

  it("without a text budget, text is never a refusal", () => {
    expect(treeWithin(`<p>${"a".repeat(400_000)}</p>`, { elements: 2_048 }).fits).toBe(true);
  });
});

describe("treeWithin: the work bound caps the parse's own cost", () => {
  it("one tag carrying tens of thousands of distinct attributes is past on work", () => {
    // Each new attribute name is compared with the tag's earlier ones: O(attributes^2) in the parser,
    // charged to MAX_PARSE_WORK. parse5 measured 8.7-18.7 s over the full part without the bound.
    const attrs = Array.from({ length: 40_000 }, (_, i) => `a${i.toString(36)}`).join(" ");
    expect(treeWithin(`<b ${attrs}>x</b>`, FRAME)).toEqual({ fits: false, past: "work" });
  });

  it("a shallow stack of open formatting elements amplifying text is past on work, not elements", () => {
    // 500 open <span> (under the element bound) then a run of text: a token per alternating
    // character and a stack scan per token. Only the work bound catches it.
    const html = "<b>" + "<span>".repeat(500) + "a ".repeat(60_000);
    expect(treeWithin(html, FRAME)).toEqual({ fits: false, past: "work" });
  });

  it("an ordinary newsletter stays well inside the work bound", () => {
    const rows = Array.from({ length: 400 }, (_, n) =>
      `<tr><td style="padding:12px"><a href="https://example.com/${n}">Row ${n}</a></td></tr>`).join("");
    const control = treeWithin(`<table width="600">${rows}</table>`, FRAME_TEXT);
    expect(control.fits && control.work).toBeLessThan(MAX_PARSE_WORK / 10);
  });

  /**
   * THE ABORT IS THE WHOLE POINT. Counting the element bomb to completion is ~270 ms of main
   * thread (node, measured); aborting at the bound is ~15-25 ms. The ceiling is generous
   * for a loaded host, and the mutation that removes the throw — counting after `parse()` returns —
   * reddens it. The reading is fits=false either way, so only the clock catches that mutation.
   */
  it("aborts in well under 150 ms on the 642,008-element shape", () => {
    const bomb = parseAmp();
    const t0 = performance.now();
    const r = treeWithin(bomb, PARSE);
    const ms = performance.now() - t0;
    expect(r).toEqual({ fits: false, past: "elements" });
    expect(ms, `the parse bomb took ${ms.toFixed(0)} ms — the abort did not fire`).toBeLessThan(150);
  });
});

describe("treeStepper: the same reading a slice at a time", () => {
  /** Runs the stepper to its reading, counting the calls that answered null. */
  const stepped = (html: string, budget: { elements: number; textChars?: number }, size: number) => {
    const step = treeStepper(html, budget, size);
    let r = step();
    let pending = 0;
    while (r === null) {
      pending += 1;
      r = step();
    }
    return { reading: r, pending, again: step() };
  };

  it("equals treeWithin over every shape at slice sizes 1, 7, 1,024 and 32,768", () => {
    const rows = Array.from({ length: 100 }, (_, n) =>
      `<tr><td style="padding:12px"><a href="https://example.com/${n}">Row ${n}</a></td><td>Oct ${n % 28}</td></tr>`).join("");
    const shapes: Array<[string, string, { elements: number; textChars?: number }]> = [
      ["an ordinary newsletter", `<table width="600">${rows}</table>`, FRAME_TEXT],
      ["the frame amplifier", pCloserAmp(), FRAME_TEXT],
      ["the parse amplifier", parseAmp(), PARSE],
      ["the li amplifier", liAmp(), FRAME_TEXT],
      ["noscript content", `<noscript>${parseAmp()}</noscript>`, FRAME_TEXT],
      ["the select amplifier that fits", `<select><option>${parseAmp()}</option></select>`, FRAME],
      ["the work shape", "<b>" + "<span>".repeat(500) + "a ".repeat(60_000), FRAME],
      ["text one past the bound", `<p>${"a".repeat(131_073)}</p>`, FRAME_TEXT],
      ["surrogate pairs and CRLF across slice ends", `<p>${"\u{1F600}\r\nx&amp;y&notin;".repeat(400)}</p>`, FRAME_TEXT],
      ["style excluded from text", `<style>${"a{color:red}".repeat(600)}</style><p>${"word ".repeat(1_400)}</p>`, FRAME_TEXT],
    ];
    for (const [name, html, budget] of shapes) {
      const once = treeWithin(html, budget);
      for (const size of [1, 7, 1_024, 32_768]) {
        const s = stepped(html, budget, size);
        expect(s.reading, `${name} at ${size} characters a step`).toEqual(once);
        expect(s.again, `${name}: a known reading is answered again`).toEqual(once);
      }
    }
  });

  it("equals treeWithin under a per-step share of work, pausing inside a slice", () => {
    const rows = Array.from({ length: 60 }, (_, n) => `<tr><td><a href="https://example.com/${n}">Row ${n}</a></td></tr>`).join("");
    const shapes: Array<[string, { elements: number; textChars?: number }]> = [
      [`<table width="600">${rows}</table>`, FRAME_TEXT],
      [pCloserAmp("<p>t</p>", 300, 80), FRAME_TEXT],
      [parseAmp(paras(400), 100), PARSE],
      ["<b>" + "<span>".repeat(300) + "a ".repeat(20_000), FRAME],
      [`<p>${"\u{1F600}\r\nx&amp;y".repeat(200)}</p>`, FRAME_TEXT],
    ];
    for (const [html, budget] of shapes) {
      const once = treeWithin(html, budget);
      for (const [chars, work] of [[32_768, 1], [32_768, 97], [7, 1_000], [1_024, 25_000]] as const) {
        const step = treeStepper(html, budget, chars, work);
        let r = step();
        while (r === null) r = step();
        expect(r, `${html.length} chars at ${chars} chars / ${work} work a step`).toEqual(once);
      }
    }
  });

  it("a share of work splits the one slice that would have spent it all", () => {
    // Thousands of distinct formatting elements: every push compares itself with the whole list (charged).
    const html = `<p>${opens(2_000)}${paras(10)}`;
    const count = (work: number) => {
      const step = treeStepper(html, FRAME, 32_768, work);
      let n = 1;
      let r = step();
      while (r === null) {
        n += 1;
        r = step();
      }
      return { r, n };
    };
    const whole = count(Infinity);
    const shared = count(25_000);
    expect(whole.r).toEqual({ fits: false, past: "work" });
    expect(shared.r).toEqual(whole.r);
    expect(whole.n).toBe(1);
    // A step stops at the first character past its share, so it can overshoot by one token's work.
    expect(shared.n).toBeGreaterThanOrEqual(MAX_PARSE_WORK / (2 * 25_000));
  });

  it("answers null while slices remain and the reading on the step that finishes", () => {
    const html = `<p>${"x".repeat(100_000)}</p>`;
    expect(stepped(html, FRAME_TEXT, 32_768).pending).toBe(3);
    expect(stepped("<p>x</p>", FRAME_TEXT, 32_768).pending).toBe(0);
  });
});

