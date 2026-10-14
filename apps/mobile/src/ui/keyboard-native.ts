/**
 * The keyboard's native door (`OhmailPosture.showKeyboardWhenFocused`): asks for the keyboard for a
 * field once its window has input focus. Android only; elsewhere, and where the field has no native
 * tag, nothing. Called ON the module: a native method read off it and called bare is not called at all.
 * The `*-native.ts` twin the node suite never imports.
 */
import { findNodeHandle } from "react-native";
import { nativePosture } from "./posture/posture-native";
import type { Focusable } from "./keep-focus";

export function showKeyboardWhenFocused(field: Focusable): void {
  const posture = nativePosture();
  if (posture?.showKeyboardWhenFocused === undefined) return;
  const tag = findNodeHandle(field as unknown as Parameters<typeof findNodeHandle>[0]);
  if (typeof tag !== "number") return;
  posture.showKeyboardWhenFocused(tag).catch(() => undefined);
}
