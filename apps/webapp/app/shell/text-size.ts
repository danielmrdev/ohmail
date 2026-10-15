/**
 * SETTINGS → TEXT SIZE — one setting, per device, read before the first paint on every surface.
 *
 * The desktop window turns it into the webview's own page zoom (the shell's `set_text_size`), so
 * layout, hit targets and geometry scale as one. A browser has no such door, so the web door and
 * the served host client stamp a CSS `zoom` on `<html>` plus `--ui-zoom` for the stylesheet's
 * viewport units; `@ohmail/ui`'s `uiZoom()` reads that stamp back for the shell's geometry. 100% is
 * the absence of both, byte-identical to the stylesheet without this feature. Phones keep the OS
 * font scale. Import-free: the desktop's paint-blocking boot stamp reaches this file.
 */

/** The one key, unkeyed by owner: a text size is a fact about this screen and these eyes. */
export const TEXT_SIZE_KEY = "ohmail.textSize";

/** The offered sizes, in percent. The shell's `text_scale::SIZES` is the same list. */
export const TEXT_SIZES = [90, 100, 110, 125, 150] as const;

export type TextSize = (typeof TEXT_SIZES)[number];

export const DEFAULT_TEXT_SIZE: TextSize = 100;

/** The custom property the stylesheet divides viewport units by. */
export const UI_ZOOM_VAR = "--ui-zoom";

export function isTextSize(v: unknown): v is TextSize {
  return typeof v === "number" && (TEXT_SIZES as readonly number[]).includes(v);
}

/** The stored size, or the default for an empty, blocked or foreign value. */
export function readTextSize(storage?: Storage | null): TextSize {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(TEXT_SIZE_KEY);
    const n = raw === null || raw === undefined ? NaN : Number(raw);
    return isTextSize(n) ? n : DEFAULT_TEXT_SIZE;
  } catch {
    return DEFAULT_TEXT_SIZE;
  }
}

/** The browser half: `zoom` and `--ui-zoom` on the root, both removed at 100%. */
export function stampTextSize(root: HTMLElement, size: TextSize): void {
  if (size === DEFAULT_TEXT_SIZE) {
    root.style.removeProperty("zoom");
    root.style.removeProperty(UI_ZOOM_VAR);
    return;
  }
  const zoom = String(size / 100);
  root.style.setProperty("zoom", zoom);
  root.style.setProperty(UI_ZOOM_VAR, zoom);
}

/** How a size reaches the screen on this host. The browser stamp unless a host installs another. */
export type TextSizeApplier = (size: TextSize) => void;

let applier: TextSizeApplier | null = null;

/** The desktop window installs the native zoom here; every other host keeps the stamp. */
export function installTextSizeApplier(next: TextSizeApplier | null): void {
  applier = next;
}

/** Put a size on screen now, through this host's door. */
export function applyTextSize(size: TextSize): void {
  if (applier) applier(size);
  else if (typeof document !== "undefined") stampTextSize(document.documentElement, size);
}

/**
 * THE SAME READ AND STAMP AS A STRING, for the web door, which paints from server-rendered HTML
 * before any bundle runs (inlined under the request's nonce beside the theme and column stamps).
 * Hand-written for `columnsBootScript`'s reason; `text-size.test.ts` executes it and requires the
 * stamp {@link stampTextSize} writes.
 */
export function textSizeBootScript(): string {
  const sizes = JSON.stringify(TEXT_SIZES);
  return (
    `(function(){try{var n=Number(localStorage.getItem(${JSON.stringify(TEXT_SIZE_KEY)}));` +
    `if(n===${DEFAULT_TEXT_SIZE}||${sizes}.indexOf(n)<0)return;var z=String(n/100),d=document.documentElement.style;` +
    `d.setProperty("zoom",z);d.setProperty(${JSON.stringify(UI_ZOOM_VAR)},z)}catch(e){}})()`
  );
}
