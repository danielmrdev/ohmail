/**
 * A HUGE BODY IS DRAWN A PAGE AT A TIME ON THE PHONE. A 2 MiB plain body handed whole to one Text
 * froze the app for over a minute when it was shown (rig AVD); the desktop's bound (`BODY_PAGE_CHARS`, the
 * shared `packages/ui/src/format/long-text.ts`) now pages it here too. There is no RN renderer in
 * this workspace, so the plan is driven as a function and every body surface is read by parsing:
 * no Text draws a `.body` itself, and each surface names `BodyPages` for it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const SURFACES = [
  "src/ui/MessageReader.tsx",
  "src/ui/MailBodyFrame.tsx",
  "src/ui/SenderDetail.tsx",
  "src/ui/DraftReader.tsx",
  "app/(tabs)/reads.tsx",
];

/** The cell's body: 2 MiB of distinct words, ten to a line. */
function hugeBody(): string {
  const lines: string[] = [];
  let len = 0;
  for (let n = 0; len < 2 * 1024 * 1024; ) {
    const w: string[] = [];
    for (let k = 0; k < 10; k++, n++) w.push(`b${n.toString(36)}x`);
    const l = w.join(" ");
    lines.push(l);
    len += l.length + 1;
  }
  return lines.join("\n");
}

/** `.body` reads drawn as a Txt child, and the `text` of every BodyPages, per file. */
function bodyDraws(rel: string): { bare: string[]; paged: string[] } {
  const sf = ts.createSourceFile(rel, src(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bare: string[] = [];
  const paged: string[] = [];
  const readsBody = (e: ts.Node): boolean =>
    (ts.isPropertyAccessExpression(e) && e.name.text === "body") || ts.forEachChild(e, readsBody) === true;
  const visit = (n: ts.Node): void => {
    if (ts.isJsxElement(n) && n.openingElement.tagName.getText(sf) === "Txt") {
      for (const c of n.children) if (ts.isJsxExpression(c) && c.expression && readsBody(c.expression)) bare.push(c.getText(sf));
    }
    if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText(sf) === "BodyPages") {
      for (const a of n.attributes.properties) {
        if (ts.isJsxAttribute(a) && a.name.getText(sf) === "text" && a.initializer && ts.isJsxExpression(a.initializer)
          && a.initializer.expression && readsBody(a.initializer.expression)) paged.push(a.initializer.getText(sf));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { bare, paged };
}

describe("the page plan", () => {
  it("a body of one page or less draws whole, as before", async () => {
    const { bodyPages, BODY_PAGE_CHARS } = await import("../src/ui/body-pages");
    expect(bodyPages("Hello", 1)).toEqual({ pages: null, more: null });
    expect(bodyPages("x".repeat(BODY_PAGE_CHARS), 1)).toEqual({ pages: null, more: null });
  });

  it("a 2 MiB body draws one page, and each press adds one", async () => {
    const { bodyPages, BODY_PAGE_CHARS } = await import("../src/ui/body-pages");
    const body = hugeBody();
    const one = bodyPages(body, 1);
    expect(one.pages).toHaveLength(1);
    expect(one.pages![0]!.length).toBeLessThanOrEqual(BODY_PAGE_CHARS);
    expect(one.pages![0]!.length).toBeGreaterThan(BODY_PAGE_CHARS * 0.875);
    expect(one.more).toBe(3);
    const two = bodyPages(body, 2);
    expect(two.pages).toHaveLength(2);
    expect(two.pages![0]).toBe(one.pages![0]);
    expect(body.startsWith(two.pages!.join(""))).toBe(true);
    expect(two.more).toBe(6);
  });

  it("the last press shows all of it and offers no more", async () => {
    const { bodyPages } = await import("../src/ui/body-pages");
    const body = hugeBody();
    const all = bodyPages(body, 1000);
    expect(all.pages!.join("")).toBe(body);
    expect(all.more).toBeNull();
  });

  it("a clamped card draws the first page and offers no press", async () => {
    const { bodyPages, BODY_PAGE_CHARS } = await import("../src/ui/body-pages");
    const plan = bodyPages(hugeBody(), 3, true);
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages![0]!.length).toBeLessThanOrEqual(BODY_PAGE_CHARS);
    expect(plan.more).toBeNull();
  });

  it("the count asked for one message starts again at one for the next", async () => {
    const { pagesAskedFor } = await import("../src/ui/body-pages");
    expect(pagesAskedFor({ text: "a", pages: 4 }, "a")).toBe(4);
    expect(pagesAskedFor({ text: "a", pages: 4 }, "b")).toBe(1);
  });

  it("a page is drawn as line-cut blocks that read back as the page", async () => {
    const { bodyPages, pageBlocks, BODY_BLOCK_CHARS } = await import("../src/ui/body-pages");
    const page = bodyPages(hugeBody(), 1).pages![0]!;
    const blocks = pageBlocks(page);
    expect(blocks.length).toBeGreaterThan(8);
    expect(page.endsWith("\n")).toBe(true);
    expect(blocks.join("\n") + "\n").toBe(page);
    for (const b of blocks) expect(b.length).toBeLessThanOrEqual(BODY_BLOCK_CHARS);
    const long = "w ".repeat(BODY_BLOCK_CHARS) + "\nend";
    expect(pageBlocks(long)).toEqual([long.slice(0, -4), "end"]);
  });

  it("is the desktop's bound, not a second one", async () => {
    const { BODY_PAGE_CHARS } = await import("../src/ui/body-pages");
    const shared = await import("../../../packages/ui/src/format/long-text");
    expect(BODY_PAGE_CHARS).toBe(shared.BODY_PAGE_CHARS);
    const mine = src("src/ui/body-pages.ts");
    expect(mine).toContain('from "@ohmail/ui/long-text"');
    expect(mine).not.toMatch(/BODY_PAGE_CHARS\s*=/);
  });
});

describe("every phone surface that draws a body pages it", () => {
  for (const rel of SURFACES) {
    it(rel, () => {
      const { bare, paged } = bodyDraws(rel);
      expect(bare, `${rel} hands a body to one Text whole`).toEqual([]);
      expect(paged.length, `${rel} draws no body through BodyPages`).toBeGreaterThan(0);
    });
  }

  it("the press says what the desktop's says, in both languages", async () => {
    const { EN } = await import("../src/copy.en");
    const { DE } = await import("../src/copy.de");
    const web = (locale: string) =>
      (JSON.parse(src(`../webapp/messages/${locale}.json`)) as { bodyText: { more: string } }).bodyText.more;
    expect(EN.bodyShowMore(3)).toBe(web("en").replace("{percent}", "3"));
    expect(DE.bodyShowMore(3)).toBe(web("de").replace("{percent}", "3"));
  });
});
