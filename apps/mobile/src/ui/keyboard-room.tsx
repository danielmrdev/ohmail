/**
 * THE ROOM A FORM KEEPS ABOVE THE KEYBOARD (Android). The window is drawn edge to edge, so the
 * keyboard resizes nothing: on the standalone door a 411 dp phone kept the focused SMTP port half
 * under it and Connect could not be scrolled into view. This wrapper shortens its scroller's frame
 * by the keyboard's reported height (`keyboard-lift.ts`, the sheets' arrangement), and the native
 * scroll view brings the focused field back into its shortened frame. iOS needs no wrapper: the
 * scroller asks for `automaticallyAdjustKeyboardInsets`, which measures in window coordinates.
 */
import type { ReactNode } from "react";
import { View } from "react-native";
import { useKeyboardLift } from "./keyboard-lift";

export function KeyboardRoom({ children }: { children: ReactNode }) {
  const keyboardLift = useKeyboardLift();
  return <View style={{ flex: 1, paddingBottom: keyboardLift }}>{children}</View>;
}
