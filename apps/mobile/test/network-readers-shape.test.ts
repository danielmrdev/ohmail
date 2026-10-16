/* @reads: apps/mobile/modules/ohmail-posture/android/src/main/java/app/ohmail/posture/OhmailPostureModule.kt apps/mobile/modules/ohmail-posture/ios/OhmailPostureModule.swift apps/mobile/modules/ohmail-posture/android/src/main/AndroidManifest.xml apps/mobile/src/net/network-native.ts */
/**
 * THE NETWORK DOOR'S PLATFORM READERS, BY THEIR SHAPE. This repo compiles neither
 * Kotlin nor Swift in the suite, so the two sources are read with comments blanked and asked for
 * the names the JS twin (`src/net/network-native.ts`) calls: one function, one event, on the
 * posture module both platforms already link. That they compile and answer is the device gate's.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string): string =>
  readFileSync(resolve(__dirname, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const kotlin = read("../modules/ohmail-posture/android/src/main/java/app/ohmail/posture/OhmailPostureModule.kt");
const swift = read("../modules/ohmail-posture/ios/OhmailPostureModule.swift");
const manifest = readFileSync(resolve(__dirname, "../modules/ohmail-posture/android/src/main/AndroidManifest.xml"), "utf8");
const twin = read("../src/net/network-native.ts");

describe("the JS twin asks the posture module for exactly what both halves define", () => {
  it("names the module, the function and the event", () => {
    expect(twin).toContain('requireOptionalNativeModule<PostureNetwork>("OhmailPosture")');
    expect(twin).toContain("getNetwork");
    expect(twin).toContain('"onNetworkChanged"');
  });

  it("Android: the default network's INTERNET capability, a default-network callback, unregistered on destroy", () => {
    expect(kotlin).toContain('Function("getNetwork")');
    expect(kotlin).toMatch(/Events\("onFoldsChanged", "onNetworkChanged"\)/);
    expect(kotlin).toContain("registerDefaultNetworkCallback(callback)");
    expect(kotlin).toContain("NET_CAPABILITY_INTERNET");
    expect(kotlin).toMatch(/OnDestroy \{[\s\S]*unregisterNetworkCallback/);
    expect(kotlin).toContain('sendEvent("onNetworkChanged"');
    expect(manifest).toContain('android:name="android.permission.ACCESS_NETWORK_STATE"');
  });

  it("iOS: a path monitor, its state under one lock, the same function and event", () => {
    expect(swift).toContain("import Network");
    expect(swift).toContain("NWPathMonitor()");
    expect(swift).toContain('Function("getNetwork")');
    expect(swift).toMatch(/Events\("onFoldsChanged", "onNetworkChanged"\)/);
    expect(swift).toContain('sendEvent("onNetworkChanged"');
    expect(swift).toMatch(/path\.status == \.satisfied \? "online" : "offline"/);
    expect(swift).toMatch(/OnDestroy \{[\s\S]*monitor\?\.cancel\(\)/);
    expect(swift).toContain("networkLock.lock()");
  });
});
