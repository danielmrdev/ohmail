/**
 * The editor-feel rig: the composer's mark boundaries and caret, driven by a real keyboard on
 * chromium AND webkit (the desktop is WebKitGTK; the webapp is whatever the person runs).
 *
 *   node apps/webapp/test/editor-feel/build-harness.mjs
 *   npx playwright test -c apps/webapp/test/editor-feel/playwright.config.ts
 *   npx playwright test -c apps/webapp/test/editor-feel/playwright.config.ts --project=webkit
 *
 * Files end in `.pw.ts`, not `.test.ts`: the repo's vitest include is `apps/*\/test/**\/*.test.*`
 * and a Playwright spec swept into vitest is a file that fails for the wrong reason. `retries: 0`
 * — a boundary rule that holds on the second try does not hold. Screenshots are the rig's own
 * reads (a harness page holds no mail), and traces stay off for the same reason the UX suite's do.
 */
import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const repo = resolve(__dirname, "../../../..");

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.pw\.ts$/,
  outputDir: resolve(repo, "build/editor-feel/results"),
  fullyParallel: false,
  workers: 2,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 5_000 },
  reporter: [["list", { printSteps: false }]],
  use: {
    viewport: { width: 1000, height: 700 },
    actionTimeout: 10_000,
    trace: "off",
    video: "off",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
