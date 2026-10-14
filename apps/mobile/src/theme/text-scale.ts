/**
 * A SYSTEM TEXT-SIZE CHANGE RE-MEASURES EVERY TEXT NODE, renderer-free so the suite can drive it.
 *
 * React keeps the shadow nodes it last committed, and its next commit hands back boxes measured at
 * the old size while the glyphs draw at the new one. A node is re-measured only when its props
 * change, so every text host carries `maxFontSizeMultiplier={t.textCap}`, a cap that never binds and
 * MOVES on every probe-height, density or text-size change (`textEpochOf`). It only grows: a value
 * flipping back and forth could land on the one the nodes carry. `test/text-size-changes-live.test.ts`.
 */

/** Above iOS's largest accessibility size (3.571) and Android's largest font scale, so never a cap. */
export const TEXT_CAP_FLOOR = 100;

/** Rounding, not a new size: the smallest system step moves the probe's h1 line by about 1.5 pt. */
const PROBE_SLACK_PT = 0.5;

export interface ScaleReading {
  /** Bumped once per observed text-size change; the cap's parity follows it. */
  readonly generation: number;
  /** The probe's last height, null before its first layout. */
  readonly height: number | null;
}

export const FIRST_READING: ScaleReading = { generation: 0, height: null };

/** The next reading for a probe layout; the SAME object when nothing moved, so no render follows. */
export function readProbe(prev: ScaleReading, height: number): ScaleReading {
  if (!Number.isFinite(height) || height <= 0) return prev;
  if (prev.height === null) return { generation: prev.generation, height };
  if (Math.abs(height - prev.height) <= PROBE_SLACK_PT) return prev;
  return { generation: prev.generation + 1, height };
}

/** The cap every text host carries: a new value for every generation, never one before it, never binding. */
export function textCapOf(generation: number): number {
  return TEXT_CAP_FLOOR + generation;
}

/**
 * THE KEY THE MEASUREMENT IS CACHED UNDER. React Native keeps text measurements in a cache keyed by the
 * string, its layout attributes and the paragraph's attributes, and `maxFontSizeMultiplier` is not
 * among them: after a density change a Text carrying a new cap was measured again and handed the old
 * density's answer ("Bac" for Back, panes past the screen). `minimumFontScale` IS a paragraph attribute
 * of that key and acts only with `adjustsFontSizeToFit`, which no text here sets, so every Text carries
 * one per generation: fifty values 0.01 apart, further apart than the cache's float tolerance.
 */
export const TEXT_KEY_BASE = 0.5;
const TEXT_KEY_STEP = 0.01;
const TEXT_KEY_SPAN = 50;

export function textKeyOf(generation: number): number {
  return Math.round((TEXT_KEY_BASE + TEXT_KEY_STEP * (generation % TEXT_KEY_SPAN)) * 100) / 100;
}

/** The text epoch after a window reading: one more when the density or the text size moved. */
export function textEpochOf(
  epoch: number,
  prev: { scale: number; fontScale: number },
  next: { scale: number; fontScale: number },
): number {
  return prev.scale !== next.scale || prev.fontScale !== next.fontScale ? epoch + 1 : epoch;
}
