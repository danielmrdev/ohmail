/**
 * SCROLL-TO-READ'S NUMBERS AND ITS DWELL DECISION, one copy for the web reader and the phone's
 * (`apps/webapp/app/shell/reader-seen.ts`, `apps/mobile/src/ui/reader-seen.ts`). Pure: each core
 * hands in its panels' boxes in one coordinate system and gets back what the dwell reads. The
 * EDGE rules live here: a member that can never pass or span the line is read once it is wholly in
 * view after the same dwell — at the scroll end every such member, at the scroll top the ones wholly
 * above the line (a short first letter; the ones below it still have the line to pass).
 */

/** The reading line, as a fraction of the viewport's height from its top. */
export const READING_LINE = 0.33;
/** Rule B's dwell after the last scroll the person made. */
export const DWELL_MS = 2000;
/** A scroll counts only when the person's input precedes it by at most this. */
export const EVIDENCE_WINDOW_MS = 1000;

export interface PanelBox {
  id: string;
  top: number;
  bottom: number;
}

/** Can the reader scroll no further up? A pixel of rounding is the top. */
export function atScrollTop(offset: number): boolean {
  return offset <= 1;
}

/** Can the reader scroll no further down? A pixel of rounding is the end. */
export function atScrollEnd(offset: number, viewport: number, content: number): boolean {
  return offset + viewport >= content - 1;
}

/**
 * What the dwell reads: the one panel spanning the line; at the scroll end every panel wholly in
 * view as well; at the scroll top every panel wholly in view above the line. `panels` are the
 * unread candidates only, in order; the result keeps that order.
 */
export function dwellCommits(
  panels: readonly PanelBox[],
  view: { top: number; bottom: number; line: number },
  atEnd: boolean,
  atTop: boolean,
): string[] {
  const spans = (p: PanelBox): boolean => p.top <= view.line && p.bottom > view.line;
  const whole = (p: PanelBox): boolean => p.top >= view.top - 1 && p.bottom <= view.bottom + 1;
  if (atEnd) return panels.filter((p) => spans(p) || whole(p)).map((p) => p.id);
  const first = panels.find(spans);
  return panels.filter((p) => p === first || (atTop && whole(p) && p.bottom <= view.line)).map((p) => p.id);
}
