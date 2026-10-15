/**
 * The frame-links rig: what a click on a link inside the sandboxed message frame does, in chromium
 * AND webkit (the desktop window is WebKit on macOS and Linux, Chromium on Windows).
 *
 *   node apps/webapp/test/frame-links/build-harness.mjs
 *   npx playwright test -c apps/webapp/test/frame-links/playwright.config.ts
 *
 * `.pw.ts`, never `.test.ts`: the repo's vitest include would sweep a Playwright spec in.
 */
import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const repo = resolve(__dirname, "../../../..");

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.pw\.ts$/,
  outputDir: resolve(repo, "build/frame-links/results"),
  fullyParallel: false,
  workers: 2,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  reporter: [["list", { printSteps: false }]],
  use: { viewport: { width: 1000, height: 700 }, actionTimeout: 10_000, trace: "off", video: "off" },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
