/**
 * The iOS posture module's SHAPE — this repo has no Swift toolchain, so the source is read with
 * comments blanked and asked for the tokens that decide: `getHasFold` no longer returns a
 * literal `false`, the Duo model identifier read on the 27.1 simulator is named, the simulator
 * env doors are read, and the status bar frame is exposed. Prose cannot satisfy it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  resolve(__dirname, "../modules/ohmail-posture/ios/OhmailPostureModule.swift"),
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

describe("the iOS posture module names the Duo", () => {
  it("getHasFold answers by the model, not a literal false", () => {
    const body = src.slice(src.indexOf('Function("getHasFold")'));
    const fn = body.slice(0, body.indexOf("}") + 1);
    expect(fn).not.toMatch(/return\s+false/);
    expect(fn).toMatch(/isDuo\(\)/);
  });
  it("reads the simulator's model identifier and the device's uname", () => {
    expect(src).toContain('"SIMULATOR_MODEL_IDENTIFIER"');
    expect(src).toContain("utsname()");
    expect(src).toContain('"iPhone19,4"');
  });
  it("exposes the status bar frame for the closed face's cluster — async, on the main queue", () => {
    expect(src).toContain('AsyncFunction("getStatusCluster")');
    expect(src).toContain("statusBarFrame");
    expect(src).toMatch(/getStatusCluster[\s\S]*?runOnQueue\(\.main\)/);
    // a sync Function has no runOnQueue in Expo Modules — the 27.1 build refused it (rc 65)
    expect(src).not.toMatch(/\bFunction\("getStatusCluster"\)/);
  });
  it("keeps the launch-override door", () => {
    expect(src).toContain('environment["OHMAIL_POSTURE"]');
  });
});
