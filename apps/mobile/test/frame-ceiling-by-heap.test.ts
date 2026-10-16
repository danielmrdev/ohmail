/* @reads: apps/mobile/modules/ohmail-posture/android/src/main/java/app/ohmail/posture/OhmailPostureModule.kt apps/mobile/modules/ohmail-posture/ios/OhmailPostureModule.swift apps/mobile/modules/ohmail-posture/expo-module.config.json */
/**
 * THE DRAWN DOCUMENT'S CEILING IS THE PHONE'S OWN (`src/mail/frame-ceiling.ts`). Measured on one AVD with
 * one picture named N times and one non-ASCII character in the text (ASCII alone fails later): at 64 MB
 * the longest document that drew and the shortest that ran out of memory were read at each heap class,
 * and one fixed constant was past the smallest heap's failure. Each class's ceiling is held under
 * half the longest that drew at its heap, and a phone whose class cannot be read takes the floor.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PHONE_FRAME_CHARS_PER_HEAP_MB, PHONE_FRAME_FLOOR_CHARS, PHONE_FRAME_MAX_CHARS } from "../src/mail/frame-budget";
import { deviceHeapOf, phoneFrameMaxChars, processMemoryHeap, IOS_FLOOR_CLASS_MB, type HeapReaders } from "../src/mail/frame-ceiling";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { frameTreeLine, planFrameCount, planFrameLength, startFrameCount, type FrameCount } from "../src/mail/frame-tree";

const heap = (memoryClassMb: number, lowRam = false) => ({ memoryClassMb, lowRam });
/** Per heap, the drawn lengths read on the AVD with one U+2019 in the text: the longest that drew, the first that failed. */
const MEASURED = { 64: [6_412_850, 7_023_526], 96: [10_992_920, 12_061_603], 128: [14_962_312, 15_878_329] } as const;

describe("phoneFrameMaxChars: min(8,000,000, 50,000 x memory class)", () => {
  it("scales with the class and stops at the 8,000,000 cap", () => {
    expect(phoneFrameMaxChars(heap(64))).toBe(3_200_000);
    expect(phoneFrameMaxChars(heap(96))).toBe(4_800_000);
    expect(phoneFrameMaxChars(heap(128))).toBe(6_400_000);
    expect(phoneFrameMaxChars(heap(160))).toBe(PHONE_FRAME_MAX_CHARS);
    expect(phoneFrameMaxChars(heap(192))).toBe(PHONE_FRAME_MAX_CHARS);
    expect(phoneFrameMaxChars(heap(512))).toBe(PHONE_FRAME_MAX_CHARS);
    expect(phoneFrameMaxChars(heap(48))).toBe(2_400_000);
    expect(phoneFrameMaxChars(heap(95.9))).toBe(95 * PHONE_FRAME_CHARS_PER_HEAP_MB);
  });

  it("a 64 MB class admits no more than 3.2 million: the formerly crashing 8.40 million is refused", () => {
    const ceiling = phoneFrameMaxChars(heap(64));
    expect(ceiling).toBeLessThanOrEqual(3_200_000);
    expect(planFrameLength(8_397_545, ceiling).known).toEqual({ fits: false, past: "length" });
    expect(planFrameCount("x".repeat(ceiling + 1), false, ceiling).known).toEqual({ fits: false, past: "length" });
    expect(planFrameCount("x".repeat(ceiling), false, ceiling).known).toBeNull();
  });

  it("every measured heap's ceiling is under half the longest that drew there, so under half its first failure", () => {
    for (const [mb, [drew, failed]] of Object.entries(MEASURED)) {
      expect(drew, `${mb} MB`).toBeLessThan(failed);
      expect(phoneFrameMaxChars(heap(Number(mb))), `${mb} MB`).toBeLessThanOrEqual(drew / 2);
    }
  });

  it("a low-RAM phone is held to the floor, or to its class's figure when that is lower", () => {
    expect(phoneFrameMaxChars(heap(256, true))).toBe(PHONE_FRAME_FLOOR_CHARS);
    expect(phoneFrameMaxChars(heap(128, true))).toBe(PHONE_FRAME_FLOOR_CHARS);
    expect(phoneFrameMaxChars(heap(48, true))).toBe(2_400_000);
  });

  it("an unknown phone takes the floor", () => {
    expect(phoneFrameMaxChars(null)).toBe(PHONE_FRAME_FLOOR_CHARS);
    expect(PHONE_FRAME_FLOOR_CHARS).toBe(4_000_000);
  });
});

describe("deviceHeapOf: the posture module's answer, or null when it cannot say", () => {
  const ok: HeapReaders = { getMemoryClass: () => 96, isLowRamDevice: () => false };
  it("reads a well-formed answer", () => {
    expect(deviceHeapOf(ok)).toEqual({ memoryClassMb: 96, lowRam: false });
    expect(deviceHeapOf({ getMemoryClass: () => 64, isLowRamDevice: () => true })).toEqual({ memoryClassMb: 64, lowRam: true });
  });

  it("an absent module, or one without the readers (an older binary), is null and draws at the floor", () => {
    for (const mod of [null, undefined, {}, { getMemoryClass: () => 96 }, { isLowRamDevice: () => false }] as (HeapReaders | null | undefined)[]) {
      expect(deviceHeapOf(mod)).toBeNull();
      expect(phoneFrameMaxChars(deviceHeapOf(mod))).toBe(PHONE_FRAME_FLOOR_CHARS);
    }
  });

  it("a reader that throws is null, never a throw into the frame", () => {
    const boom = () => { throw new Error("native"); };
    expect(deviceHeapOf({ getMemoryClass: boom, isLowRamDevice: () => false })).toBeNull();
    expect(deviceHeapOf({ getMemoryClass: () => 96, isLowRamDevice: boom })).toBeNull();
  });

  it("an answer of the wrong kind is null: no class, 0 (the iOS simulator), negative, NaN, a string, a non-boolean flag", () => {
    for (const v of [0, 0.5, -96, Number.NaN, Number.POSITIVE_INFINITY, "96", null, undefined]) {
      expect(deviceHeapOf({ getMemoryClass: () => v, isLowRamDevice: () => false }), String(v)).toBeNull();
    }
    expect(deviceHeapOf({ getMemoryClass: () => 96, isLowRamDevice: () => "false" })).toBeNull();
    expect(deviceHeapOf({ getMemoryClass: () => 96, isLowRamDevice: () => undefined })).toBeNull();
  });
});

describe("the ceiling a plan was made under is in its log line", () => {
  it("a refusal past this phone's ceiling names the ceiling", () => {
    let got: FrameCount | null = null;
    startFrameCount(planFrameLength(8_397_545, 3_200_000), (c) => { got = c; }, () => () => {});
    expect(JSON.parse(frameTreeLine(got!))).toMatchObject({ fits: false, past: "length", chars: 8_397_545, ceiling: 3_200_000, steps: 0 });
  });
});

describe("iOS: the class from the process's memory limit, never under the floor unless the device is low-memory", () => {
  const MB = 1024 * 1024, GB = 1024 * MB;
  const at = (availableMb: number, footprintMb: number, physicalGb: number) =>
    processMemoryHeap({ available: availableMb * MB, footprint: footprintMb * MB, physical: physicalGb * GB });

  it("the limit is what the process may still allocate plus what it holds, / 16 MB per class MB", () => {
    expect(at(1_500, 148, 6)).toEqual({ memoryClassMb: 103, lowRam: false });
    expect(phoneFrameMaxChars(at(1_500, 148, 6))).toBe(103 * PHONE_FRAME_CHARS_PER_HEAP_MB);
    expect(phoneFrameMaxChars(at(2_600, 400, 6))).toBe(PHONE_FRAME_MAX_CHARS);
    expect(phoneFrameMaxChars(at(1_200, 336, 4))).toBe(96 * PHONE_FRAME_CHARS_PER_HEAP_MB);
    expect(IOS_FLOOR_CLASS_MB).toBe(80);
  });

  it("the same process reads the same class however much it holds when mail is first opened", () => {
    const classes = [[1_900, 100], [1_400, 600], [600, 1_400], [100, 1_900]].map(([a, f]) => at(a, f, 6)!.memoryClassMb);
    expect(new Set(classes)).toEqual(new Set([125]));
  });

  it("a device that is not low-memory never draws under the floor, however small the limit reads", () => {
    expect(IOS_FLOOR_CLASS_MB * PHONE_FRAME_CHARS_PER_HEAP_MB).toBeGreaterThanOrEqual(PHONE_FRAME_FLOOR_CHARS);
    expect(phoneFrameMaxChars(at(500, 100, 4))).toBe(IOS_FLOOR_CLASS_MB * PHONE_FRAME_CHARS_PER_HEAP_MB);
    expect(phoneFrameMaxChars(at(500, 100, 4))).toBeGreaterThanOrEqual(PHONE_FRAME_FLOOR_CHARS);
  });

  it("a low-memory device (under 3 GB) takes its own figure, at most the floor", () => {
    expect(at(800, 200, 2)).toMatchObject({ lowRam: true });
    expect(phoneFrameMaxChars(at(1_400, 200, 2))).toBe(PHONE_FRAME_FLOOR_CHARS);
    expect(phoneFrameMaxChars(at(800, 200, 2))).toBe(62 * PHONE_FRAME_CHARS_PER_HEAP_MB);
    expect(phoneFrameMaxChars(at(400, 100, 2))).toBe(31 * PHONE_FRAME_CHARS_PER_HEAP_MB);
  });

  it("no limit (the simulator answers 0), a footprint task_info could not read, or a malformed answer is unknown: the floor", () => {
    expect(at(0, 180, 16)).toBeNull();
    expect(processMemoryHeap({ available: 900 * MB, footprint: -1, physical: 6 * GB })).toBeNull();
    for (const bad of [null, undefined, 7, "x", {}, { available: 1, footprint: 1 }, { available: Number.NaN, footprint: 1, physical: 1 }]) {
      expect(processMemoryHeap(bad), JSON.stringify(bad) ?? "undefined").toBeNull();
    }
    expect(phoneFrameMaxChars(deviceHeapOf({ getProcessMemory: () => ({ available: 0, footprint: 9e7, physical: 8 * GB }) }))).toBe(PHONE_FRAME_FLOOR_CHARS);
    expect(phoneFrameMaxChars(deviceHeapOf({ getProcessMemory: () => { throw new Error("native"); } }))).toBe(PHONE_FRAME_FLOOR_CHARS);
  });

  it("the module's Android readers are read first; iOS's process memory only where they are absent", () => {
    expect(deviceHeapOf({ getProcessMemory: () => ({ available: 1_800 * MB, footprint: 200 * MB, physical: 6 * GB }) })).toEqual({ memoryClassMb: 125, lowRam: false });
    expect(deviceHeapOf({ getMemoryClass: () => 64, isLowRamDevice: () => false, getProcessMemory: () => ({ available: 1, footprint: 1, physical: 1 }) })).toEqual({ memoryClassMb: 64, lowRam: false });
  });
});

describe("the posture module both platforms already link carries the readers", () => {
  // One left-to-right pass (scripts/lib/source-scan.mjs): a comment-shaped string is not a comment.
  const read = (p: string): string => withoutComments(readFileSync(resolve(__dirname, p), "utf8"));
  const kotlin = read("../modules/ohmail-posture/android/src/main/java/app/ohmail/posture/OhmailPostureModule.kt");
  const swift = read("../modules/ohmail-posture/ios/OhmailPostureModule.swift");

  it("Android: ActivityManager's memory class and low-RAM flag; no manager reads as unknown", () => {
    expect(kotlin).toContain('Function("getMemoryClass") { activityManager()?.memoryClass ?: 0 }');
    expect(kotlin).toContain('Function("isLowRamDevice") { activityManager()?.isLowRamDevice ?: true }');
    expect(kotlin).toContain("getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager");
    expect(kotlin).not.toContain("getProcessMemory");
  });

  it("iOS: the process's available memory, its footprint and the device's physical memory, in bytes", () => {
    expect(swift).toContain("import os");
    expect(swift).toContain('"available": Double(os_proc_available_memory()),');
    expect(swift).toContain("task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)");
    expect(swift).toContain("let footprint = kr == KERN_SUCCESS ? Double(info.phys_footprint) : -1");
    expect(swift).toContain('"physical": Double(ProcessInfo.processInfo.physicalMemory),');
    expect(swift).toMatch(/Function\("getProcessMemory"\) \{ \(\) -> \[String: Double\] in\s*return OhmailPostureModule\.processMemory\(\)/);
    expect(swift).not.toContain('Function("getMemoryClass")');
  });

  it("no new native module: the posture module's registration is unchanged", () => {
    const cfg = JSON.parse(readFileSync(resolve(__dirname, "../modules/ohmail-posture/expo-module.config.json"), "utf8"));
    expect(cfg.android.modules).toEqual(["app.ohmail.posture.OhmailPostureModule"]);
    expect(cfg.apple.modules).toEqual(["OhmailPostureModule"]);
  });
});
