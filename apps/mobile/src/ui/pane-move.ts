/**
 * THE MOVE FROM A PUSHED ROUTE TO THE PAIR'S PANE, one door for every route that yields to a pane
 * (the pushed reader, the sender page). The stack keeps a removed screen's views attached until its
 * exit ends, and when the unfold's re-render of that screen reached the device after the removal
 * had begun, a MOVED view still had its parent and the app died in `addViewAt` (5 unfolds in 10;
 * 0 in 10 with no move). So the route first draws an empty sentinel, and the replace waits for the
 * sentinel's layout: by then everything the route committed before it is on the device.
 */
import { createElement, useEffect, useRef, useState, type ReactElement } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { readerMoveDue } from "./reader-held";

export interface PaneTarget {
  pathname: string;
  params: Record<string, string>;
}

/** Null while the route stays; once it hands itself to the pane, the one thing it may render. */
export function usePaneMove(target: PaneTarget | null, held: boolean): ReactElement | null {
  const [leaving, setLeaving] = useState<PaneTarget | null>(null);
  const replaced = useRef(false);
  const path = target?.pathname ?? null;
  const key = target === null ? "" : JSON.stringify(target.params);
  useEffect(() => {
    if (target !== null && readerMoveDue(path, held)) setLeaving(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key, held]);
  if (leaving === null) return null;
  const go = () => {
    if (replaced.current) return;
    replaced.current = true;
    router.replace({ pathname: leaving.pathname, params: leaving.params });
  };
  return createElement(View, { style: { flex: 1 }, onLayout: go, collapsable: false });
}
