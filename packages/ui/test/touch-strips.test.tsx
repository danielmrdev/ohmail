/** @vitest-environment jsdom */
/**
 * ═══ THE FOUR CONTROLS THAT WERE STILL UNDER 44, AND WHAT EACH ONE PRESSES NOW ═══════════════
 *
 * `.msg-open` (26×26, on EVERY message), `.ftw` (14 wide), `.fmore` and `.infonote-sum` took
 * neither the drawn 44 nor a hit strip. They are the remainder of the touch-target pass, and the
 * reason they were left is the reason they need reading rather than a blanket rule: three of them
 * sit beside another control, and the strip rule forbids a strip that overlaps one.
 *
 * ── WHAT A "GEOMETRY CASE" IS IN JSDOM ───────────────────────────────────────────────────────
 *
 * jsdom performs no layout, so nothing here measures a rendered box. What it DOES have is a real
 * CSS parser: the stylesheet is injected and read back through the CSSOM, so every number below
 * comes from the declarations the browser would use — `@media` condition, selector, `position`,
 * `top`, `height`, `translate` — and not from a regular expression over the file's text. A regex
 * would pass for a rule inside the wrong media block, for a strip on a host with no containing
 * block, and for `height:44px` written where `top` is missing; each of those renders a pressable
 * area that is not 44.
 *
 * So the shape of every case is: derive the strip's vertical extent from its declarations, and
 * refuse unless the four facts that make that extent real are all present. `pressableHeight`
 * throws with the missing fact named rather than returning a number nobody can trust.
 *
 * ── AND THE ONE THAT IS NOT A STRIP ──────────────────────────────────────────────────────────
 *
 * `.ftw` is 14px WIDE. The deficiency is horizontal, and the rule's own words are "Vertical only
 * — neighbours in a row sit 0–6px apart horizontally, so a horizontal strip would overlap the
 * control beside it": `.ritem` begins 0px to the twisty's right and is itself a control. What
 * the twisty needs is the ROW to be 44, which it then fills (`align-self:stretch`). That arm
 * reads the row's floor and the stretch together, because either alone is a control that presses
 * 14×20 while looking finished.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = [resolve(__dirname, "..", "..", ".."), resolve(__dirname, "..", "..")]
  .find((r) => existsSync(resolve(r, "packages/ui/src/base.css")))!;

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

/** The phone block every stylesheet in this system writes its touch rules into. */
const PHONE = "(max-width: 640px)";

interface Parsed { media: string | null; selector: string; style: CSSStyleDeclaration }

/**
 * Every style rule in a stylesheet, each tagged with the media condition it stands under.
 * Parsed by the DOM, so an unparseable declaration is absent here exactly as it would be absent
 * in the browser.
 */
const rules = (css: string): Parsed[] => {
  const el = document.createElement("style");
  el.textContent = css;
  document.head.append(el);
  const sheet = el.sheet!;
  const out: Parsed[] = [];
  const walk = (list: CSSRuleList, media: string | null): void => {
    for (const rule of Array.from(list)) {
      if (rule.type === 4 /* CSSMediaRule */) {
        const m = rule as CSSMediaRule;
        walk(m.cssRules, m.media.mediaText);
      } else if (rule.type === 1 /* CSSStyleRule */) {
        const r = rule as CSSStyleRule;
        for (const selector of r.selectorText.split(",")) {
          out.push({ media, selector: selector.trim(), style: r.style });
        }
      }
    }
  };
  walk(sheet.cssRules, null);
  el.remove();
  return out;
};

const find = (all: Parsed[], selector: string, media: string | null): CSSStyleDeclaration | null =>
  all.find((r) => r.selector === selector && r.media === media)?.style ?? null;

/**
 * One declaration, ALWAYS through `getPropertyValue`.
 *
 * jsdom's CSSStyleDeclaration implements camelCase accessors for only a subset of properties —
 * `position`, `top` and `height` are there, `min-height`, `align-self`, `align-items`,
 * `margin-top` and `padding-top` are not, and an unimplemented one reads `undefined`. So
 * `style.minHeight === ""` is a comparison that can never be true, which is a case that cannot
 * fail: it reads as "no floor is declared" for a stylesheet that declares one. Every read below
 * goes through the property name.
 */
const val = (style: CSSStyleDeclaration, prop: string): string => style.getPropertyValue(prop);

/**
 * The rule, or a throw that NAMES what is missing.
 *
 * `find(...)!` reads well and fails as `Cannot read properties of null` — a red that says nothing
 * about the stylesheet and reads, to whoever meets it next, as a broken test rather than a missing
 * rule. Watched: deleting `.frow`'s floor produced exactly that message on two cases before this
 * existed.
 */
const must = (all: Parsed[], selector: string, media: string | null): CSSStyleDeclaration => {
  const style = find(all, selector, media);
  if (!style) throw new Error(`no rule for \`${selector}\`${media ? ` under ${media}` : " outside any media block"}`);
  return style;
};

/**
 * The TOP component of a box edge, whether the stylesheet wrote the longhand or the shorthand.
 *
 * `.msg-subject` writes `margin: 8px 0 0` and `.msg-sender` writes `padding: 3px 8px 3px 3px`;
 * jsdom expands neither into a `-top` longhand it will hand back. Reading the longhand alone
 * returns "" for both, and a measurement built on "" is a number nobody wrote.
 */
const edgeTop = (style: CSSStyleDeclaration, edge: "margin" | "padding"): string => {
  const long = val(style, `${edge}-top`);
  if (long) return long;
  const short = val(style, edge).trim().split(/\s+/)[0] ?? "";
  return short;
};

/**
 * The strip's vertical extent, in pixels — or a throw naming the fact that is missing.
 *
 * Four facts make the extent real, and every one of them has a failure mode that renders as a
 * control that is still 26 tall:
 *
 *   · the HOST is `position:relative` inside the same media block — without it the strip's
 *     containing block is some ancestor and `top:50%` is half of that ancestor, so the strip
 *     lands somewhere else entirely (this is the one that looks right in the file and is wrong
 *     on screen);
 *   · the strip is `position:absolute` — a static `::before` is a box in the flow, which would
 *     change the drawn size, which is the thing the strip exists to avoid;
 *   · `content` is declared — a `::before` with no content generates no box at all;
 *   · `top:50%` with `translate:0 -50%` centres it on the host. `top` alone hangs the strip off
 *     the host's midpoint downward, so it covers 22px of whatever is below and 0 of the control.
 */
const pressableHeight = (all: Parsed[], host: string, strip: string): number => {
  const h = find(all, host, PHONE);
  if (!h) throw new Error(`no phone rule for the host \`${host}\` — the strip has no containing block`);
  if (val(h, "position") !== "relative") throw new Error(`\`${host}\` is not position:relative under ${PHONE}`);
  const s = find(all, strip, PHONE);
  if (!s) throw new Error(`no phone rule for \`${strip}\``);
  if (val(s, "position") !== "absolute") throw new Error(`\`${strip}\` is not position:absolute — it is a box in the flow`);
  if (!val(s, "content")) throw new Error(`\`${strip}\` declares no content — no box is generated`);
  if (val(s, "top") !== "50%") throw new Error(`\`${strip}\` is not anchored at top:50% (got ${val(s, "top") || "nothing"})`);
  if (val(s, "translate").replace(/\s+/g, " ").trim() !== "0 -50%") {
    throw new Error(`\`${strip}\` is not centred — translate is \`${val(s, "translate")}\``);
  }
  const px = /^(\d+(?:\.\d+)?)px$/.exec(val(s, "height"));
  if (!px) throw new Error(`\`${strip}\` has no pixel height (got ${val(s, "height") || "nothing"})`);
  return Number(px[1]);
};

describe("the per-message open-reader glyph presses 44 without drawing it", () => {
  const all = rules(read("packages/ui/src/composites/message.css"));

  it("`.msg-open` gains a centred 44px strip on phones", () => {
    expect(pressableHeight(all, ".msg-open", ".msg-open::before")).toBeGreaterThanOrEqual(44);
  });

  it("and keeps its DRAWN 26×26 — the strip is the only thing that changed", () => {
    const drawn = must(all, ".msg-open", null);
    expect(val(drawn, "width")).toBe("26px");
    expect(val(drawn, "height")).toBe("26px");
    // No phone rule may resize it: a min-height here would be the drawn change this avoids.
    expect(val(must(all, ".msg-open", PHONE), "min-height")).toBe("");
  });

  it("the strip stops clear of `.subj-rule`, the next control down the panel", () => {
    /* The measurement, from the declarations rather than from a rendering: `.msg-from` is
       `align-items:center`, its tallest item is `.msg-sender` — a 26px avatar (`.av.s`) plus
       3px of padding at each end — so the line is 32 and the 26px glyph is centred in it. A
       44px strip centred on the glyph reaches (44 - 32) / 2 = 6px past the line; `.msg-subject`
       puts the subject's box 8px below it. 2px of clearance, and the sign is what matters. */
    const strip = pressableHeight(all, ".msg-open", ".msg-open::before");
    const sender = must(all, ".msg-sender", null);
    const avatar = must(rules(read("packages/ui/src/primitives/avatar.css")), ".av.s", null);
    const pad = /^(\d+)px/.exec(edgeTop(sender, "padding"))![1];
    const lineHeight = Number(/^(\d+)px$/.exec(val(avatar, "height"))![1]) + Number(pad) * 2;
    const overhang = (strip - lineHeight) / 2;

    const subject = must(rules(read("apps/webapp/app/app.css")), ".msg-subject", null);
    const gapBelow = Number(/^(\d+)px$/.exec(edgeTop(subject, "margin"))![1]);

    expect(lineHeight, "the from-line's height, from the avatar and the sender's padding").toBe(32);
    expect(overhang, "how far the strip reaches past the line at each end").toBe(6);
    expect(gapBelow, "`.msg-subject`'s top margin").toBe(8);
    expect(overhang, "the strip reaches the subject line's control").toBeLessThan(gapBelow);
  });
});

describe("the folder row: the twisty gets the ROW, the ⋯ gets a strip", () => {
  const all = rules(read("packages/ui/src/composites/rail.css"));

  it("`.ftw` presses the row's full 44 — the floor is declared, and the twisty fills it", () => {
    /* Both halves, because either one alone is a 14×20 control that reads as finished: the row
       has a 44px floor of its own, and the twisty stretches to the line rather than centring in
       it. `.frow`'s floor is written in the phone block beside every other touch rule; it was
       previously true only as a side effect of `.ritem`'s min-height, which is a sibling's
       property. */
    const row = must(all, ".frow", PHONE);
    expect(val(row, "min-height")).toBe("44px");
    expect(val(must(all, ".ftw", null), "align-self")).toBe("stretch");
    expect(Number(/^(\d+)px$/.exec(val(row, "min-height"))![1])).toBeGreaterThanOrEqual(44);
  });

  it("and NO strip is written for it — a horizontal one would lie over `.ritem`", () => {
    /* The rule's own exception. `.ritem` is `flex:1 1 auto` immediately to the twisty's right,
       so a strip wide enough to help would overlap a control; and a VERTICAL strip would add
       nothing the stretched box does not already have. */
    expect(find(all, ".ftw::before", PHONE)).toBeNull();
    const ftwPhone = find(all, ".ftw", PHONE);
    expect(ftwPhone === null ? "" : val(ftwPhone, "position")).not.toBe("relative");
  });

  it("`.fmore` gains a centred 44px strip, which is exactly the row it sits in", () => {
    const strip = pressableHeight(all, ".fmore", ".fmore::before");
    expect(strip).toBeGreaterThanOrEqual(44);
    /* Equal to the row's floor, so the strip reaches past neither end of the row — the only
       thing it could overlap vertically. Horizontally `.ritem` ends where `.fmore` begins. */
    expect(strip).toBe(Number(/^(\d+)px$/.exec(val(must(all, ".frow", PHONE), "min-height"))![1]));
  });

  it("and keeps its drawn padding box", () => {
    expect(val(must(all, ".fmore", null), "padding")).toBe("2px 7px");
    expect(val(must(all, ".fmore", PHONE), "min-height")).toBe("");
  });
});

describe("the (i) disclosure's summary presses 44 while it is closed", () => {
  const all = rules(read("packages/ui/src/primitives/info-note.css"));
  const HOST = ".infonote:not([open]) > .infonote-sum";

  it("the closed summary gains a centred 44px strip", () => {
    expect(pressableHeight(all, HOST, `${HOST}::before`)).toBeGreaterThanOrEqual(44);
  });

  it("the OPEN note has no strip — the note's own paragraph sits 5px under the summary", () => {
    /* `.infonote-more` is prose, and several callers fill it with prose that carries links. A
       44px strip centred on a ~17px summary reaches ~13px past it, so an always-on strip would
       lie over the first 8px of that paragraph and take presses meant for it. The alternative
       the strip rule offers — grow the gap — would be a visible change on every phone with a
       note open. Closed, the paragraph has no box; and closed is the state the big target is
       for, because the press it takes is the one that opens the note. */
    expect(edgeTop(must(all, ".infonote-more", null), "margin")).toBe("5px");
    expect(find(all, ".infonote > .infonote-sum::before", PHONE)).toBeNull();
    expect(find(all, ".infonote[open] > .infonote-sum::before", PHONE)).toBeNull();
  });

  it("and the summary's drawn line is untouched — no floor, no padding added", () => {
    const drawn = must(all, ".infonote > .infonote-sum", null);
    expect(val(drawn, "align-items")).toBe("baseline");
    expect(val(must(all, HOST, PHONE), "min-height")).toBe("");
    expect(val(must(all, HOST, PHONE), "padding")).toBe("");
  });
});

describe("every strip in the pass stands under the phone block and nowhere else", () => {
  /* A strip outside the media block would be a 44px pressable area on the desktop, where the
     density is a design the wider layout was drawn around — and it would silently swallow the
     rows above and below a control that is 26 tall by choice there. */
  const files = [
    "packages/ui/src/composites/message.css",
    "packages/ui/src/composites/rail.css",
    "packages/ui/src/primitives/info-note.css",
  ];
  it("no `height:44px` strip is declared at any other width", () => {
    for (const f of files) {
      const strips = rules(read(f)).filter((r) => r.selector.includes("::before") && val(r.style, "height") === "44px");
      expect(strips.length, `${f} declares no 44px strip at all`).toBeGreaterThan(0);
      for (const s of strips) expect(s.media, `${f}: \`${s.selector}\` stands outside the phone block`).toBe(PHONE);
    }
  });
});
