/** @vitest-environment jsdom */
/**
 * SETTINGS → TEXT SIZE IN THE WINDOW: the shell's page zoom, read before the first frame.
 *
 *  · a size goes to the shell as `set_text_size { percent }` and the page carries NO browser
 *    stamp, so the shared geometry (`uiZoom`) stays 1 — the shell's zoom keeps it in one space;
 *  · a refused command (a build without it) falls back to the browser stamp, and a later taken
 *    one clears that stamp again;
 *  · the paint-blocking boot stamp hands the STORED size to the shell, and the entry installs the
 *    same door for Settings' presses.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uiZoom } from "@ohmail/ui";
import { applyDesktopTextSize } from "../src/text-zoom.js";
import { UI_ZOOM_VAR } from "../../webapp/app/shell/text-size.js";

type Asked = { command: string; payload?: Record<string, unknown> };
const host = globalThis as { __TAURI_INTERNALS__?: unknown };

function shell(refuse: boolean): Asked[] {
  const asked: Asked[] = [];
  host.__TAURI_INTERNALS__ = {
    invoke: async (command: string, payload?: Record<string, unknown>) => {
      asked.push({ command, payload });
      if (refuse) throw new Error("command set_text_size not allowed");
      return null;
    },
    transformCallback: () => 0,
  };
  return asked;
}

const ui = (): string => document.documentElement.style.getPropertyValue(UI_ZOOM_VAR);

beforeEach(() => document.documentElement.removeAttribute("style"));
afterEach(() => {
  delete host.__TAURI_INTERNALS__;
  document.documentElement.removeAttribute("style");
});

describe("the window's text size", () => {
  it("goes to the shell as its page zoom and stamps nothing on the page", async () => {
    const asked = shell(false);
    await applyDesktopTextSize(125);
    expect(asked).toEqual([{ command: "set_text_size", payload: { percent: 125 } }]);
    expect(ui()).toBe("");
    expect(uiZoom()).toBe(1);
  });

  it("falls back to the browser stamp when the shell refuses, and a taken size clears it", async () => {
    shell(true);
    await applyDesktopTextSize(150);
    expect(ui()).toBe("1.5");
    shell(false);
    await applyDesktopTextSize(110);
    expect(ui()).toBe("");
  });

  it("with no shell at all it is the browser stamp", async () => {
    await applyDesktopTextSize(90);
    expect(ui()).toBe("0.9");
  });
});

describe("the size is read before the first frame and the presses take the same door", () => {
  const src = (p: string): string => readFileSync(resolve(__dirname, p), "utf8");

  it("the blocking boot stamp hands the stored size to the shell", () => {
    expect(src("../src/boot-stamp.ts")).toMatch(/^void applyDesktopTextSize\(readTextSize\(\)\);$/m);
  });

  it("the window's entry installs the shell's door before the first render", () => {
    const main = src("../src/main.tsx");
    const install = main.indexOf("installTextSizeApplier((size) => void applyDesktopTextSize(size));");
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(main.indexOf("createRoot(root)"));
  });
});
