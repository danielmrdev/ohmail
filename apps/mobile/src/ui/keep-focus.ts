/**
 * THE CARET COMES BACK WITH ITS DIALOG. Android draws a `Modal` in a dialog window of its own, and
 * an unfold hands the composer a NEW one (measured: the dialog's window changed on every unfold,
 * never on a fold): the text survives, the field that held the caret does not. So the composer
 * remembers which field had it and, when its dialog is shown again, gives it back — unless the
 * person had let it go before the redraw (a blur longer ago than the redraw takes).
 */
import { useRef, type RefObject } from "react";

export interface Focusable { focus(): void }

/** A blur within this long of the redraw is the old window going, not the person. */
export const REDRAW_BLUR_MS = 1500;

export interface FocusMemory {
  field: RefObject<Focusable | null>;
  blurredAt: number | null;
}

/** Whether a show gives the caret back: a REDRAW (not the first show) of a field still held. */
export function refocusOnShow(show: number, last: FocusMemory | null, now: number): boolean {
  if (show <= 1 || last === null) return false;
  return last.blurredAt === null || now - last.blurredAt <= REDRAW_BLUR_MS;
}

export function useFocusKeeper(now: () => number = Date.now): {
  bind(field: RefObject<Focusable | null>): { onFocus(): void; onBlur(): void };
  onShow(): void;
} {
  const last = useRef<FocusMemory | null>(null);
  const shows = useRef(0);
  return {
    bind: (field) => ({
      onFocus: () => { last.current = { field, blurredAt: null }; },
      onBlur: () => { if (last.current?.field === field) last.current.blurredAt = now(); },
    }),
    onShow: () => {
      shows.current += 1;
      if (refocusOnShow(shows.current, last.current, now())) last.current?.field.current?.focus();
    },
  };
}
