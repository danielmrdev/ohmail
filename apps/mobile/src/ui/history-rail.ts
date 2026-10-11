/**
 * THE YEAR RAIL'S COLUMN. The rail stands at History's right edge over a scrolling list, so the
 * LIST keeps the rail's MEASURED width clear on its right — the head's sentence and link, and every
 * row's date and preview, end before the rail at every width and font scale (the webapp's rows keep
 * the same gutter, `history-rail.css`). With no rail, or before it has laid out, the list keeps its
 * full width; the head keeps its own padding either way.
 */

/** The head's own padding on each side. */
export const HISTORY_HEAD_PAD = 12;
/** Where the rail stands from the screen's right edge. */
export const HISTORY_RAIL_RIGHT = 2;
/** The room between the list's content and the rail. */
export const HISTORY_RAIL_GAP = 8;

/** What the list leaves clear on its right while the rail stands: its width, inset and the air. */
export function historyListGutter(railWidth: number | null): number {
  if (railWidth === null || !(railWidth > 0)) return 0;
  return Math.ceil(railWidth) + HISTORY_RAIL_RIGHT + HISTORY_RAIL_GAP;
}
