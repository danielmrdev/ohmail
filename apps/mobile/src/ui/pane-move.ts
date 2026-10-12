/**
 * THE MOVE FROM A PUSHED ROUTE TO THE PAIR'S PANE, one door for the routes that yield to a pane (the
 * pushed reader, the sender page). Only the FOCUSED route moves: a covered one would act on the top
 * of the stack and blank itself. The route first draws one static empty view, so no view of it can
 * be moved while the stack runs its exit (an unfold crashed in `addViewAt` on 5 in 10 when the
 * route re-rendered during it), and from that view's layout pops back to the pane's EXISTING route
 * (`dismissTo`), never appending one. A target that goes before the layout cancels the move.
 */
import { createElement, useEffect, useRef, useState, type ReactElement } from "react";
import { View } from "react-native";
import { router, useIsFocused } from "expo-router";
import { readerMoveDue } from "./reader-held";

export interface PaneTarget {
  pathname: string;
  params: Record<string, string>;
}

/** Null while the route stays; once it hands itself to the pane, the one thing it may render. */
export function usePaneMove(target: PaneTarget | null, held: boolean): ReactElement | null {
  const focused = useIsFocused();
  const [leaving, setLeaving] = useState<PaneTarget | null>(null);
  const moved = useRef(false);
  const due = target !== null && focused && readerMoveDue(target.pathname, held);
  const key = target === null ? "" : `${target.pathname}?${JSON.stringify(target.params)}`;
  useEffect(() => {
    if (moved.current) return;
    setLeaving(due ? target : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [due, key]);
  if (leaving === null) return null;
  const go = () => {
    if (moved.current || !due) return;
    moved.current = true;
    router.dismissTo({ pathname: leaving.pathname, params: leaving.params });
  };
  return createElement(View, { style: { flex: 1 }, onLayout: go, collapsable: false });
}
