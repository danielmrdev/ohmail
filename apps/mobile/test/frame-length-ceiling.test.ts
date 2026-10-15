/**
 * A PICTURE IS WRITTEN ONCE PER REFERENCE, SO THE DRAWN DOCUMENT'S LENGTH IS READ BEFORE IT IS BUILT
 * (`src/mail/frame-length.ts`). One picture named hundreds of times made a document of tens of megabytes that killed the
 * app on a test phone when the WebView was handed it. The reading must equal the built length exactly,
 * write no picture while it reads, and the frame refuses a state past PHONE_FRAME_MAX_CHARS without
 * building it, keeping the document drawn before it (`frameShows`).
 */
import { describe, expect, it, vi } from "vitest";
import { BLANK_GIF } from "@ohmail/client-engine";
import * as sanitize from "../src/mail/sanitize";
import { buildPhoneMailDocument } from "../src/mail/mail-document";
import { drawnLength, lengthStandIn } from "../src/mail/frame-length";
import { PHONE_FRAME_FLOOR_CHARS, PHONE_FRAME_MAX_CHARS } from "../src/mail/frame-budget";
import { treeWithin } from "@ohmail/client-engine/html-tree-budget";
import { FRAME_BUDGET } from "../src/mail/frame-budget";
import { frameReadingOf, frameShows, frameTreeLine, planFrameCount, planFrameLength, startFrameCount, type FrameCount, type FramePlan, type FrameReading } from "../src/mail/frame-tree";
import { phoneFrameMaxChars } from "../src/mail/frame-ceiling";

vi.mock("../src/mail/sanitize", async (load) => {
  const real = await load<typeof import("../src/mail/sanitize")>();
  return { ...real, sanitizeMailHtmlPhone: vi.fn(real.sanitizeMailHtmlPhone) };
});
const { sanitizeMailHtmlPhone } = sanitize;
type Opts = NonNullable<Parameters<typeof sanitizeMailHtmlPhone>[1]>;

const THEME = { bg: "#fbfaf9", ink: "#251f1b", ink2: "#625952", accent: "#a3461c", fontScale: 1 };
const built = (html: string, opts: Opts): number => buildPhoneMailDocument(sanitizeMailHtmlPhone(html, opts).html, THEME).length;
const read = (html: string, opts: Opts): number => drawnLength(html, opts, sanitizeMailHtmlPhone(html, {}), THEME);
/** A picture's `data:` URI of `n` base64 characters, distinct per `seed`. */
const pic = (n: number, seed = 0): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let body = "";
  for (let i = 0; i < n; i++) body += alphabet[(i * 7 + seed * 13) % 64];
  return `data:image/png;base64,${body}`;
};
const url = (k: number): string => `https://pictures.invalid/${k}.png`;
const img = (k: number, w = 200): string => `<img src="${url(k)}" width="${w}" height="${w}" alt="">`;
const remote = (pairs: Array<[number, string]>): Opts => ({ resolvedRemote: new Map(pairs.map(([k, v]) => [url(k), v])) });

describe("the reading is the built length, written or not", () => {
  it("over every place a picture is written: an img, a style attribute, a head stylesheet, a cid, mixed and repeated", () => {
    const cases: Array<[string, string, Opts]> = [
      ["one img", img(0), remote([[0, pic(5_000)]])],
      ["one picture, 200 imgs", img(0).repeat(200), remote([[0, pic(5_000)]])],
      ["style attributes", `<p style="background:url(${url(1)})">a</p>`.repeat(30), remote([[1, pic(900, 1)]])],
      ["a head stylesheet", `<html><head><style>.a{background:url(${url(2)})}.b{background:url('${url(2)}')}</style></head><body><p class="a">x</p></body></html>`, remote([[2, pic(700, 2)]])],
      ["a cid in an img and a style", `${'<img src="cid:part1@x" width="40" height="40">'.repeat(9)}<p style="background:url(cid:part1@x)">y</p>`, { inlineImages: new Map([["part1@x", pic(3_000, 3)]]) }],
      ["two remote, one cid, interleaved", `${img(3)}<p>t</p>${img(4)}${'<img src="cid:p2@x" width="50" height="50">'}${img(3)}`.repeat(12),
        { resolvedRemote: new Map([[url(3), pic(1_200, 4)], [url(4), pic(77, 5)]]), inlineImages: new Map([["p2@x", pic(4_096, 6)]]) }],
      ["a beacon stays blank", `<img src="${url(5)}" width="1" height="1">${img(6)}`, remote([[5, pic(2_000, 7)], [6, pic(10, 8)]])],
      ["a picture the gate refuses", img(7).repeat(4), { resolvedRemote: new Map([[url(7), "data:text/html;base64,PGI+eDwvYj4="]]) }],
      ["a picture nothing names", "<p>no pictures here</p>", remote([[8, pic(9_000, 9)]])],
      ["no pictures at all", img(9).repeat(3), {}],
    ];
    for (const [name, html, opts] of cases) expect(read(html, opts), name).toBe(built(html, opts));
  });

  it("a sender who writes the stand-ins into the text is not counted for them", () => {
    const planted = `<p title="${lengthStandIn(0)}">${lengthStandIn(0)} ${lengthStandIn(1)}</p>`.repeat(7);
    const html = `${planted}${img(0)}${img(1).repeat(3)}`;
    const opts = remote([[0, pic(6_000)], [1, pic(500, 1)]]);
    expect(read(html, opts)).toBe(built(html, opts));
  });

  it("300 random documents of pictures, repeats, stand-ins in the text and refused entries: equal every time", () => {
    let seed = 0x5eed;
    const r = (): number => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    for (let k = 0; k < 300; k++) {
      const n = 1 + Math.floor(r() * 5);
      const parts: string[] = [];
      for (let i = 0, m = 3 + Math.floor(r() * 25); i < m; i++) {
        const roll = r();
        const which = Math.floor(r() * (n + 1));
        if (roll < 0.35) parts.push(img(which, 1 + Math.floor(r() * 300)));
        else if (roll < 0.5) parts.push(`<span style="background:url(${url(which)})">s</span>`);
        else if (roll < 0.62) parts.push(`<img src="cid:c${which}@x" width="9" height="9">`);
        else if (roll < 0.7) parts.push(`<p>${lengthStandIn(Math.floor(r() * 4))}</p>`);
        else parts.push(`<p>t${i}</p>`);
      }
      const remoteMap = new Map<string, string>();
      const inlineMap = new Map<string, string>();
      for (let i = 0; i < n; i++) {
        if (r() < 0.8) remoteMap.set(url(i), r() < 0.9 ? pic(Math.floor(r() * 3_000), i) : "data:image/svg+xml;base64,PHN2Zz4=");
        if (r() < 0.5) inlineMap.set(`c${i}@x`, pic(Math.floor(r() * 2_000), i + 9));
      }
      const html = parts.join("");
      const opts: Opts = { resolvedRemote: remoteMap, inlineImages: inlineMap };
      expect(read(html, opts), html).toBe(built(html, opts));
    }
  });
});

describe("a document past the ceiling is refused before it is built", () => {
  const mint = (name: string, k: number): string => `<p>Picture ${name}, ${k} times:</p><p>${`<img src="${url(0)}" width="40" height="40" alt="">`.repeat(k)}</p>`;

  it("one 114 KB picture named 200 times reads 30.5 MB, past the ceiling, and no picture is written while it is read", () => {
    const one = pic(152_604);
    const html = mint("p1", 200);
    const bare = sanitizeMailHtmlPhone(html, {});
    vi.mocked(sanitizeMailHtmlPhone).mockClear();
    const chars = drawnLength(html, remote([[0, one]]), bare, THEME);
    const longest = Math.max(...vi.mocked(sanitizeMailHtmlPhone).mock.calls.flatMap(([, o]) =>
      [...(o?.resolvedRemote?.values() ?? []), ...(o?.inlineImages?.values() ?? [])].map((v) => v.length)));
    expect(vi.mocked(sanitizeMailHtmlPhone).mock.calls.length).toBe(1);
    expect(longest).toBe(lengthStandIn(0).length);
    expect(chars).toBeGreaterThan(PHONE_FRAME_MAX_CHARS);
    expect(chars).toBe(built(html, remote([[0, one]])));
  });

  it("200 references to a 1 MiB picture read 280 MB without the 280 MB being made", () => {
    const html = mint("big", 200);
    vi.mocked(sanitizeMailHtmlPhone).mockClear();
    const chars = drawnLength(html, remote([[0, pic(1_398_104)]]), sanitizeMailHtmlPhone(html, {}), THEME);
    expect(chars).toBeGreaterThan(279_000_000);
    expect(vi.mocked(sanitizeMailHtmlPhone).mock.calls.every(([, o]) => [...(o?.resolvedRemote?.values() ?? [])].every((v) => v.length < 64))).toBe(true);
  });

  it("the refusal of a document not built is known at once, logged with the length it would have had", () => {
    const plan = planFrameLength(30_534_551, PHONE_FRAME_MAX_CHARS);
    expect(plan).toEqual({ key: "", known: { fits: false, past: "length" }, cached: false, chars: 30_534_551, ceiling: PHONE_FRAME_MAX_CHARS });
    let got: FrameCount | null = null;
    startFrameCount(plan, (c) => { got = c; }, () => () => {});
    expect(got).toMatchObject({ reading: { fits: false, past: "length" }, chars: 30_534_551, steps: 0 });
    expect(JSON.parse(frameTreeLine(got!))).toMatchObject({ fits: false, past: "length", chars: 30_534_551, ceiling: PHONE_FRAME_MAX_CHARS, steps: 0 });
  });

  it("the backstop: a built document past the ceiling is refused without a count, one at the ceiling is counted", () => {
    const over = planFrameCount(`<p>${"x".repeat(PHONE_FRAME_MAX_CHARS)}</p>`, false, PHONE_FRAME_MAX_CHARS);
    expect(over.known).toEqual({ fits: false, past: "length" });
    expect(over.cached).toBe(false);
    const at = planFrameCount("x".repeat(PHONE_FRAME_MAX_CHARS), false, PHONE_FRAME_MAX_CHARS);
    expect(at.known).toBeNull();
  });

  it("the seven-picture newsletter reads inside the floor every phone has, is built and fits", () => {
    const rows = Array.from({ length: 30 }, (_, n) => `<tr><td>${n < 7 ? img(n, n === 0 ? 600 : 200) : ""}</td><td>Item ${n}</td></tr>`).join("");
    const html = `<table width="600">${rows}</table>`;
    const opts = remote([[0, pic(605_552)], ...Array.from({ length: 6 }, (_, k) => [k + 1, pic(152_604, k + 1)] as [number, string])]);
    const chars = read(html, opts);
    expect(chars).toBeLessThanOrEqual(PHONE_FRAME_FLOOR_CHARS);
    expect(chars).toBe(built(html, opts));
    const doc = buildPhoneMailDocument(sanitizeMailHtmlPhone(html, opts).html, THEME);
    expect(planFrameCount(doc, false, PHONE_FRAME_FLOOR_CHARS).known?.fits === false).toBe(false);
    expect(treeWithin(doc, FRAME_BUDGET)).toMatchObject({ fits: true });
  });
});

describe("what the frame shows: one decision over the reading, this state's document and the one kept", () => {
  const fits = { fits: true as const, elements: 40, textChars: 9, work: 3 };
  const past = { fits: false as const, past: "length" as const };
  it("in every case", () => {
    expect(frameShows(fits, "now", "before", false)).toEqual({ show: "frame", doc: "now", withheld: false });
    expect(frameShows(past, null, "before", false)).toEqual({ show: "frame", doc: "before", withheld: true });
    expect(frameShows({ fits: false, past: "elements" }, "now", "before", false)).toEqual({ show: "frame", doc: "before", withheld: true });
    expect(frameShows(past, null, null, false)).toEqual({ show: "text" });
    expect(frameShows(null, "now", "before", false)).toEqual({ show: "frame", doc: "before", withheld: false });
    expect(frameShows(null, "now", null, false)).toEqual({ show: "space" });
    expect(frameShows(fits, "now", "before", true)).toEqual({ show: "text" });
  });
  it("the stand-ins are no substring of the blank picture the sanitizer writes for an unresolved one", () => {
    for (let i = 0; i < 40; i++) expect(BLANK_GIF.includes(lengthStandIn(i).slice(22))).toBe(false);
  });
});

/** A count run to its end on this thread, one step after another. */
function countNow(plan: FramePlan): FrameReading {
  const queue: Array<() => void> = [];
  let got: FrameReading | null = null;
  startFrameCount(plan, (c) => { got = c.reading; }, (run) => { queue.push(run); return () => {}; });
  while (queue.length > 0) queue.shift()!();
  if (got === null) throw new Error("the count never answered");
  return got;
}

describe("a pictured state the ceiling refuses with nothing kept draws the bare html, never the text part (REVIEW-026 HIGH-1)", () => {
  // Two inline photos of a few megabytes each, minted before the frame mounts: Show as text, then Show original,
  // remounts the frame with `m.inlineImages` still minted, so no bare document was drawn first.
  const ceiling = phoneFrameMaxChars({ memoryClassMb: 64, lowRam: false });
  const photos: Opts = { inlineImages: new Map([["a@x", pic(3_400_000, 1)], ["b@x", pic(3_400_000, 2)]]) };
  const html = '<p>Two photos</p><img src="cid:a@x" width="400" height="300"><img src="cid:b@x" width="400" height="300">';
  const remount = (body: string, opts: Opts) => {
    const bare = sanitizeMailHtmlPhone(body, {});
    const drawnChars = read(body, opts);
    const plan = planFrameLength(drawnChars, ceiling);
    const reading = frameReadingOf(plan, null);
    const bareDoc = buildPhoneMailDocument(bare.html, THEME);
    const barePlan = planFrameCount(bareDoc, bare.oversize === true, ceiling);
    return { drawnChars, reading, bareDoc, bareReading: countNow(barePlan) };
  };

  it("the remount draws the bare document with the images sentence once its own count fits", () => {
    const r = remount(html, photos);
    expect(r.drawnChars).toBeGreaterThan(ceiling);
    expect(r.reading).toEqual({ fits: false, past: "length" });
    expect(r.bareReading.fits).toBe(true);
    // While the bare document is counted, and once it fits until it becomes the kept document: a space, never text.
    expect(frameShows(r.reading, null, null, false, null)).toEqual({ show: "space" });
    expect(frameShows(r.reading, null, null, false, r.bareReading)).toEqual({ show: "space" });
    expect(frameShows(r.reading, null, r.bareDoc, false, "none")).toEqual({ show: "frame", doc: r.bareDoc, withheld: true });
  });

  it("the first mount is unchanged: the bare document drawn first is kept, with the images sentence", () => {
    const r = remount(html, photos);
    expect(frameShows(r.reading, null, r.bareDoc, false)).toEqual({ show: "frame", doc: r.bareDoc, withheld: true });
  });

  it("an html part that does not fit bare still falls back to the text part, its sentence true", () => {
    const bs = Array.from({ length: 400 }, (_, i) => `<b class="c${i}">`).join("");
    const amp = `<p>${bs}${"<p>t</p>".repeat(1500)}</p><img src="cid:a@x" width="40" height="40">`;
    const r = remount(amp, { inlineImages: new Map([["a@x", pic(4_200_000, 3)]]) });
    expect(r.reading).toEqual({ fits: false, past: "length" });
    expect(r.bareReading).toMatchObject({ fits: false, past: "elements" });
    expect(frameShows(r.reading, null, null, false, r.bareReading)).toEqual({ show: "text" });
    expect(frameShows(r.reading, null, null, true, r.bareReading)).toEqual({ show: "text" });
  });

  it("a refusal with no pictures in play is still the text part", () => {
    expect(frameShows({ fits: false, past: "elements" }, "doc", null, false)).toEqual({ show: "text" });
    expect(frameShows({ fits: false, past: "elements" }, "doc", null, false, "none")).toEqual({ show: "text" });
  });
});
