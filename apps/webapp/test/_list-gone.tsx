/** A view mounted without the shell still needs the list surface's shell half: nothing is gone unless a case says so. */
import * as React from "react";
import { ListGoneProvider, type ListGoneFacts } from "../app/shell/list-view";

export const NO_GONE: ListGoneFacts = { isGone: () => false, openTrash: null };

export function WithListGone({ value = NO_GONE, children }: { value?: ListGoneFacts; children: React.ReactNode }) {
  return React.createElement(ListGoneProvider, { value, children });
}
