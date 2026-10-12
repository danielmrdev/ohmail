/**
 * THE iPAD'S WINDOW CONTROLS ARE PART OF THE TOP INSET. In Split View, Slide Over and a free window
 * iPadOS draws its window controls over the app's top-leading corner, and the safe area this app
 * reads does not include them: they sat on Back and on the list title, and a tap on Back opened the
 * controls. A window that does not fill the screen is given that strip on top of the
 * system inset. Read from the frames: the controls end ~42pt under the system inset in both shapes.
 * A full-screen window and every phone are untouched. Dependency-free so a node test can drive it.
 */
export const IPAD_WINDOW_CONTROLS_PT = 44;

export interface WindowShape {
  isPad: boolean;
  window: { width: number; height: number };
  screen: { width: number; height: number };
}

/** True where iPadOS draws window controls over the app: an iPad window smaller than its screen. */
export function windowedOnPad({ isPad, window, screen }: WindowShape): boolean {
  if (!isPad) return false;
  return window.width < screen.width - 1 || window.height < screen.height - 1;
}

/** The top inset a screen pays: the system's, plus the controls' strip on a windowed iPad. */
export function topInsetWithControls(systemTop: number, shape: WindowShape): number {
  return windowedOnPad(shape) ? systemTop + IPAD_WINDOW_CONTROLS_PT : systemTop;
}
