/**
 * THE SCROLLER A STUCK REPLY DOCK RIDES, or null. In the split reading column the dock is
 * `position: sticky` at the column's foot (packages/ui reader.css); its box is then always on
 * screen, so `scrollIntoView` moves nothing, while its FLOW place is the column's end. A caller
 * that wants the editor at its own place, clear of the letter above it, scrolls this to its end.
 * Null when the dock is in flow (the overlay, the two-pane band), where `scrollIntoView` works.
 */
export function stuckDockScroller(reply: Element): Element | null {
  const dock = reply.parentElement;
  const win = reply.ownerDocument?.defaultView;
  if (!dock || !win || win.getComputedStyle(dock).position !== "sticky") return null;
  for (let a = dock.parentElement; a; a = a.parentElement) {
    if (/(auto|scroll)/.test(win.getComputedStyle(a).overflowY)) return a;
  }
  return null;
}
