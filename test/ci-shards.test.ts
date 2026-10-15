import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  ALONE_MARKER, SHARDS, aloneFiles, checkMap, dovecotPinned, hashShard, readMap, shardFiles, testFiles, verifyReport,
  type ShardMap,
} from "./support/ci-shards.mjs";

/**
 * THE SUITE'S SHARD MAP. Every test file runs exactly once: in the shard the map names, in the shard its
 * path hashes to when the map does not name it, or alone. Each refusal below is also driven against a
 * planted tree, so none is green for want of a subject.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("the shard map of this tree", () => {
  const map = readMap(ROOT);
  const files = testFiles(ROOT);
  const alone = new Set(aloneFiles(ROOT, files));

  it("holds SHARDS shards and nothing stale, and was measured", () => {
    expect(map.shards).toHaveLength(SHARDS);
    expect(checkMap(ROOT, map)).toEqual([]);
    expect(map.measuredAt).toMatch(/^[0-9a-f]{40}$/);
  });

  it("runs every test file exactly once: in one shard, alone, or in the desktop job", async () => {
    const desktop = new Set((await import("./support/ci-shards.mjs")).desktopFiles(ROOT, files));
    const seen = new Map<string, number>();
    for (let n = 0; n < SHARDS; n++) for (const f of shardFiles(n, ROOT, map)) seen.set(f, (seen.get(f) ?? 0) + 1);
    expect([...seen].filter(([, c]) => c > 1)).toEqual([]);
    for (const f of [...alone, ...desktop]) expect(seen.has(f), `${f} runs alone or in the desktop job, and in a shard`).toBe(false);
    expect([...desktop].filter((f) => alone.has(f))).toEqual([]);
    expect(files.filter((f) => !seen.has(f) && !alone.has(f) && !desktop.has(f))).toEqual([]);
    expect(seen.size + alone.size + desktop.size).toBe(files.length);
    expect(files.length).toBeGreaterThan(1000);
  });

  it("finds the files that run alone by their marker, the deployment-wide pg twins among them", () => {
    for (const f of alone) expect(readFileSync(join(ROOT, f), "utf8")).toContain(ALONE_MARKER);
    expect([...alone]).toEqual(expect.arrayContaining([
      "packages/services/test/account-lifecycle-pass.pg.test.ts",
      "packages/services/test/unsubscribe-drain-cursor.pg.test.ts",
      "packages/services/test/unsubscribe-idempotency.pg.test.ts",
      "packages/services/test/unsubscribe-switch.pg.test.ts",
    ]));
  });

  it("packs every file that dials Dovecot into one shard, which is a shard that starts it", () => {
    expect(map.pins.dovecot.length).toBeGreaterThan(0);
    const holders = new Set(map.pins.dovecot.map((f) => map.shards.findIndex((s) => s.includes(f))));
    expect([...holders]).toHaveLength(1);
    const [n] = [...holders];
    expect(n).toBeGreaterThanOrEqual(0);
    expect(shardFiles(n, ROOT, map).some((f) => dovecotPinned(ROOT, f))).toBe(true);
    for (const f of map.pins.dovecot) expect(dovecotPinned(ROOT, f), `${f} is pinned and dials nothing`).toBe(true);
  });
});

describe("the map's two rules, on a planted tree", () => {
  const scratch = mkdtempSync(join(tmpdir(), "ohmail-ci-shards-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const plant = (rel: string, text = "export {};\n") => {
    mkdirSync(dirname(join(scratch, rel)), { recursive: true });
    writeFileSync(join(scratch, rel), text);
  };
  for (let i = 0; i < SHARDS + 2; i++) plant(`packages/p/test/f${i}.test.ts`);
  plant("packages/p/test/twin.pg.test.ts", `// ${ALONE_MARKER}\n`);
  /* The private app's file, spelled in pieces: a published tree holds no such app, and the whole path would
     read as a citation of it. */
  const privateAppFile = ["apps", "admin", "test", "console.test.ts"].join("/");
  plant(privateAppFile);
  const map: ShardMap = { measuredAt: "0".repeat(40), shards: Array.from({ length: SHARDS }, (_, i) => [`packages/p/test/f${i}.test.ts`]), pins: { dovecot: [] } };

  it("runs a file no shard names in the shard its path hashes to, and nowhere else", () => {
    const planted = [`packages/p/test/f${SHARDS}.test.ts`, `packages/p/test/f${SHARDS + 1}.test.ts`];
    for (const f of planted) {
      const holders = [...Array(SHARDS).keys()].filter((n) => shardFiles(n, scratch, map).includes(f));
      expect(holders, f).toEqual([hashShard(f)]);
    }
    // The alone file and the private app's file run in no shard.
    for (let n = 0; n < SHARDS; n++) {
      expect(shardFiles(n, scratch, map)).not.toContain("packages/p/test/twin.pg.test.ts");
      expect(shardFiles(n, scratch, map)).not.toContain(privateAppFile);
    }
  });

  it("refuses a mapped file that is gone, and a mapped file that runs alone", () => {
    expect(checkMap(scratch, map)).toEqual([]);
    const stale = { ...map, shards: map.shards.map((s, i) => (i === 3 ? [...s, "packages/p/test/gone.test.ts"] : s)) };
    expect(checkMap(scratch, stale)).toEqual(["STALE packages/p/test/gone.test.ts (shard 3) is not a test file in this tree"]);
    const aloneMapped = { ...map, shards: map.shards.map((s, i) => (i === 0 ? [...s, "packages/p/test/twin.pg.test.ts"] : s)) };
    expect(checkMap(scratch, aloneMapped)).toEqual([expect.stringMatching(/^ALONE packages\/p\/test\/twin\.pg\.test\.ts/)]);
  });

  it("reads a shard's report back: a file that did not run and a file nobody asked for both refuse", () => {
    const want = shardFiles(2, scratch, map);
    const row = (f: string) => ({ name: join(scratch, f), startTime: 0, endTime: 1 });
    expect(verifyReport(2, { testResults: want.map(row) }, scratch, map)).toEqual({ missing: [], extra: [] });
    expect(verifyReport(2, { testResults: [] }, scratch, map).missing).toEqual(want);
    expect(verifyReport(2, { testResults: [...want, "packages/p/test/f0.test.ts"].map(row) }, scratch, map).extra)
      .toEqual(want.includes("packages/p/test/f0.test.ts") ? [] : ["packages/p/test/f0.test.ts"]);
  });
});
