/**
 * The text epoch's one context: bumped by the posture provider after every density or text-size
 * change, once the root has the window's density (`ui/posture/index.tsx`), read by the theme's cap
 * (`text-scale.ts`). Its own module so the theme reads it without the native posture door.
 */
import { createContext, useContext } from "react";

export const TextEpochContext = createContext(0);

export function useTextEpoch(): number {
  return useContext(TextEpochContext);
}
