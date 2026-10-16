import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StoreCloseTimeoutError } from "../src/db.js";
import { tearDown, tracked } from "./_teardown.js";

/** The shared sidecar test teardown (`_teardown.ts`): what can still run stops before a store closes. */
describe("the sidecar tests' one teardown order", () => {
  it("stops every tracked mirror and engine, then closes the stores, then removes the directories", async () => {
    const order: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "ohmail-teardown-"));
    const mirrors: Array<{ stop(): Promise<void> }> = [];
    const make = tracked((name: string) => ({ stop: async () => { order.push(`stop ${name}`); } }), mirrors);
    make("a");
    make("b");
    const engines = [{ stop: () => { order.push("stop engine"); } }];
    const stores = [{ close: async () => { order.push(`close (dir there: ${existsSync(dir)})`); } }];
    await tearDown({ stop: [engines, mirrors], close: stores, remove: [dir] });
    expect(order).toEqual(["stop engine", "stop b", "stop a", "close (dir there: true)"]);
    expect(existsSync(dir), "the directory outlived the teardown").toBe(false);
    expect(mirrors).toHaveLength(0);
  });

  it("a stop that never settles is left to the close door at the bound", async () => {
    const order: string[] = [];
    const stuck = [{ stop: () => new Promise<void>(() => { order.push("stop (never settles)"); }) }];
    const began = Date.now();
    await tearDown({ stop: [stuck], close: [{ close: async () => { order.push("close"); } }], stopMs: 100 });
    expect(order).toEqual(["stop (never settles)", "close"]);
    expect(Date.now() - began).toBeLessThan(2_000);
  });

  it("a close that timed out is rethrown by name after the directories are gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmail-teardown-"));
    const timedOut = new StoreCloseTimeoutError(1, 3_000);
    const outcome = await tearDown({
      close: [{ close: () => Promise.reject(timedOut) }, { close: () => Promise.reject(new Error("an ordinary close failure")) }],
      remove: [dir],
    }).then(() => "clean", (e: unknown) => e);
    expect(outcome).toBe(timedOut);
    expect(existsSync(dir)).toBe(false);
  });

  it("an engine stop whose store close timed out is rethrown by name too, after the directories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ohmail-teardown-"));
    const timedOut = new StoreCloseTimeoutError(1, 3_000);
    const outcome = await tearDown({
      stop: [[{ stop: () => Promise.reject(timedOut) }, { stop: () => Promise.reject(new Error("an ordinary stop failure")) }]],
      remove: [dir],
    }).then(() => "clean", (e: unknown) => e);
    expect(outcome, "an engine's close timeout was swallowed by the teardown").toBe(timedOut);
    expect(existsSync(dir)).toBe(false);
  });
});
