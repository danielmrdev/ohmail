/**
 * SETTINGS → TEXT SIZE IN THE WINDOW: the shell's page zoom, never the browser stamp, so the
 * shell's geometry stays in one space (`text-size.ts` has the setting, `text_scale.rs` the
 * zoom). Where the shell refuses — a build without the command — the browser stamp stands in.
 * Reached by the paint-blocking boot stamp, so it imports no package.
 */
import { setNativeTextSize } from "./native.js";
import { DEFAULT_TEXT_SIZE, stampTextSize, type TextSize } from "../../webapp/app/shell/text-size.js";

export function applyDesktopTextSize(size: TextSize): Promise<void> {
  return setNativeTextSize(size).then((took) => {
    stampTextSize(document.documentElement, took ? DEFAULT_TEXT_SIZE : size);
  });
}
