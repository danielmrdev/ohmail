import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE WINDOW CAN BE MADE AS SHORT AS THE SCREEN. Its minimum was 600 logical px, so on
 * a screen shorter than that in logical px — 1366x768 at 150% (512), 1920x1080 at 200% (540) — every
 * resize came back taller than the screen and the bottom (Send, a wizard's Continue) sat off it. The
 * floor is the short-viewport layout the web already draws (640x400, `short-viewport-and-touch-targets`).
 *
 * MUTATION WATCHED: `minHeight` back to 600 ⇒ RED.
 */
const conf = JSON.parse(readFileSync(fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url)), "utf8")) as {
  app: { windows: { label: string; minHeight?: number; minWidth?: number }[] };
};
const main = conf.app.windows.find((w) => w.label === "main");

describe("the main window's minimum fits short HiDPI screens", () => {
  it("names a minimum, and that minimum fits every common short screen in logical px", () => {
    expect(main?.minHeight, "the main window states its minimum height").toBeTypeOf("number");
    for (const [h, scale] of [[768, 1.5], [1080, 2], [900, 2]] as const) {
      expect(main!.minHeight!, `${h}px at ${scale * 100}%`).toBeLessThanOrEqual(Math.floor(h / scale) - 40);
    }
  });
  it("is not below the short-viewport layout the web draws", () => {
    expect(main!.minHeight!).toBeGreaterThanOrEqual(400);
  });
});
