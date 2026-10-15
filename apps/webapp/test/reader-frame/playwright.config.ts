/**
 * The reader-frame rig: the frame measurement and the picture path in chromium AND webkit.
 * `classic-bars.pw.ts` runs in its own chromium project with scroll bars that take width
 * (headless chromium hides them by default). Build, then run:
 *   node apps/webapp/test/reader-frame/build-harness.mjs
 *   npx playwright test -c apps/webapp/test/reader-frame/playwright.config.ts
 * `.pw.ts`, not `.test.ts`, so vitest never sweeps a spec in. `retries: 0`: a count that holds
 * on the second try does not hold.
 */
import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const repo = resolve(__dirname, "../../../..");

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.pw\.ts$/,
  outputDir: resolve(repo, "build/reader-frame/results"),
  fullyParallel: false,
  workers: 2,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 5_000 },
  reporter: [["list", { printSteps: false }]],
  use: { viewport: { width: 1000, height: 1100 }, actionTimeout: 10_000, trace: "off", video: "off" },
  projects: [
    { name: "chromium", testIgnore: /classic-bars/, use: { browserName: "chromium" } },
    { name: "webkit", testIgnore: /classic-bars/, use: { browserName: "webkit" } },
    {
      name: "chromium-classic-bars",
      testMatch: /classic-bars\.pw\.ts$/,
      use: { browserName: "chromium", launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } },
    },
  ],
});
