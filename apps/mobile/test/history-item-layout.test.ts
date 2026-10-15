/**
 * A YEAR PRESS REACHES THAT YEAR, WHEREVER IT IS. History's list is a SectionList with no item
 * layout, and React Native's `VirtualizedList` then ends its tail spacer at the highest cell it
 * has measured (`constrainToMeasured`), so a jump below the rows laid out so far stopped at their
 * end. The list is now told the heights History draws its rows at — the slot ledger — and every
 * cell's place follows from them. This suite has no React Native renderer; what is measured is
 * the layout the list is handed and the wiring that hands it. The landing itself is a device read.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { planSections, sectionItemLayout, type RowLayout } from "../src/ui/mail-list-plan";
import { HISTORY_SLOT_FIRST_PAINT, SlotHeights } from "../src/ui/history-slot";

const read = (rel: string) => withoutComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

const SLOTS = 5000;
/** The list head above the rows (title, count, explainer, the 8 of canvas). */
const HEAD = 212;

function ledger(): SlotHeights {
  const h = new SlotHeights();
  // The first screens have laid out, at uneven heights; the rest of the list never has.
  for (let i = 0; i < 40; i++) h.record(i, 84 + (i % 5 === 0 ? 22 : 0));
  return h;
}
const layoutOf = (h: SlotHeights): RowLayout => ({ offsetOf: (i) => h.offsetOf(i), lengthOf: (i) => h.heightOf(i) });
const history = () => planSections([{ key: "history", rows: Array.from({ length: SLOTS }, (_, i) => i) }]);

describe("History's cells are placed from the ledger", () => {
  it("the header cell stands under the head, each row at its ledger offset, the footer at the end", () => {
    const h = ledger();
    const at = sectionItemLayout(history(), layoutOf(h), HEAD)!;
    expect(at).toBeTypeOf("function");
    expect(at(null, 0)).toEqual({ length: 0, offset: HEAD, index: 0 });
    for (const i of [0, 1, 39, 40, 41, 3999, SLOTS - 1]) {
      expect(at(null, i + 1), `slot ${i}`).toEqual({ length: h.heightOf(i), offset: HEAD + h.offsetOf(i), index: i + 1 });
    }
    expect(at(null, SLOTS + 1)).toEqual({ length: 0, offset: HEAD + h.offsetOf(SLOTS), index: SLOTS + 1 });
  });

  it("the cells tile the content with no gap and no overlap, past every row laid out", () => {
    const h = ledger();
    const at = sectionItemLayout(history(), layoutOf(h), HEAD)!;
    for (let index = 0; index <= SLOTS; index++) {
      const a = at(null, index);
      expect(at(null, index + 1).offset, `cell ${index + 1} starts where ${index} ends`).toBe(a.offset + a.length);
    }
    // The content a jump can reach runs to the last slot, not to the 40 rows that have laid out.
    expect(at(null, SLOTS + 1).offset).toBe(HEAD + 40 * 84 + 8 * 22 + (SLOTS - 40) * 84);
    expect(HISTORY_SLOT_FIRST_PAINT).toBe(84);
  });

  it("a year's jump target is its first row's cell: slot 0's frame plus the ledger offset", () => {
    const h = ledger();
    const at = sectionItemLayout(history(), layoutOf(h), HEAD)!;
    const slot0 = at(null, 1).offset; // what `onRowFrame` reports for slot 0, `top` in history.tsx
    for (const start of [0, 37, 1200, 4321]) expect(slot0 + h.offsetOf(start)).toBe(at(null, start + 1).offset);
  });

  it("a titled or grouped list gets no layout: its rows are measured as they lay out", () => {
    const h = layoutOf(ledger());
    expect(sectionItemLayout(planSections([{ key: "a", title: "New", rows: [1, 2] }]), h, 0)).toBeUndefined();
    expect(sectionItemLayout(planSections([{ key: "a", rows: [1] }, { key: "b", rows: [2] }]), h, 0)).toBeUndefined();
    const shelf = sectionItemLayout(planSections([{ key: "waiting", rows: [1, 2], padTop: 8 }]), h, 10)!;
    expect(shelf(null, 0)).toEqual({ length: 8, offset: 10, index: 0 });
    expect(shelf(null, 1).offset).toBe(18);
  });
});

describe("the wiring", () => {
  it("History hands the list its ledger, and draws each row at the length it hands", () => {
    const src = read("../app/history.tsx");
    expect(src).toContain("rowLayout={rowLayout}");
    expect(src).toContain("offsetOf: (i: number) => heights.offsetOf(i)");
    expect(src).toContain('lengthOf: (i: number) => (rowAt(i) === "gone" ? 0 : heights.heightOf(i))');
    expect(src).toContain('height: m === "gone" ? 0 : heights.heightOf(i)');
  });

  it("MailList places the cells under its head from the row layout alone", () => {
    const src = read("../src/ui/MailList.tsx");
    expect(src).toContain("rowLayout ? sectionItemLayout(sections, rowLayout, headH ?? 0) : undefined");
    expect(src).toContain("getItemLayout={itemLayout}");
  });
});
