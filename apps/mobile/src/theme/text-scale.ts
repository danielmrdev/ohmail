/**
 * A SYSTEM TEXT-SIZE CHANGE RE-MEASURES EVERY TEXT NODE, renderer-free so the suite can drive it.
 *
 * The native side re-lays the screen when the size moves, but React keeps the shadow nodes it last
 * committed, and its next commit (a dimensions event, a sync tick) hands those back: boxes measured
 * at the old size, glyphs drawn at the new one. A node is re-measured only when its props change, so
 * every `Text` and `TextInput` carries `maxFontSizeMultiplier={t.textCap}`, a cap far above any
 * platform's largest size (it never binds) whose value flips each time a hidden probe line changes
 * height. `test/text-size-changes-live.test.ts` holds both halves.
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

/** The cap every text host carries for a generation: two values, one per parity, both unbinding. */
export function textCapOf(generation: number): number {
  return TEXT_CAP_FLOOR + (generation % 2);
}
