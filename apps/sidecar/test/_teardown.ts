import { rmSync } from "node:fs";
import { StoreCloseTimeoutError } from "../src/db.js";

/** Anything a test starts that can still be asking the store for work: a mirror, an engine. */
export interface Stoppable { stop(): unknown }
/** A store a test opened. */
export interface Closable { close(): Promise<void> }

/** How long one stop may take before the teardown moves on and lets the store's close door decide. */
export const TEARDOWN_STOP_MS = 4_000;

/**
 * Wrap a constructor so everything it makes is recorded in `into`, for {@link tearDown} to stop.
 * A file aliases its import once (`const createCloudMirror = tracked(makeMirror, mirrors)`) and
 * every call site stays as written.
 */
export function tracked<A extends unknown[], T extends Stoppable>(make: (...a: A) => T, into: T[]): (...a: A) => T {
  return (...a: A): T => {
    const made = make(...a);
    into.push(made);
    return made;
  };
}

/**
 * ONE TEARDOWN ORDER for a sidecar test file: stop what can still run, then close the stores, then
 * remove their directories. A test that timed out leaves its body running, and closing the store
 * first shut Postgres down under that body's next statement, which loops in WASM until the worker
 * is killed (the drain-stop case held one at full CPU for two hours). A stop that does not settle in
 * {@link TEARDOWN_STOP_MS} is left to the close door. A close that times out, whether a store's own
 * or inside an engine's stop, is rethrown by name after the directories are gone: that is a call
 * still running, not a teardown detail. Any other stop or close failure is the test body's to report.
 */
export async function tearDown(t: {
  stop?: Stoppable[][]; close?: Closable[]; remove?: string[]; stopMs?: number;
}): Promise<void> {
  let timedOut: StoreCloseTimeoutError | null = null;
  const keep = (err: unknown): void => {
    if (err instanceof StoreCloseTimeoutError) timedOut ??= err;
  };
  for (const list of t.stop ?? []) {
    for (const s of list.splice(0).reverse()) await stopWithin(s, t.stopMs ?? TEARDOWN_STOP_MS, keep);
  }
  for (const o of t.close?.splice(0) ?? []) await o.close().catch(keep);
  for (const d of t.remove?.splice(0) ?? []) rmSync(d, { recursive: true, force: true });
  if (timedOut) throw timedOut;
}

async function stopWithin(s: Stoppable, ms: number, keep: (err: unknown) => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  try {
    await Promise.race([Promise.resolve().then(() => s.stop()).catch(keep), bound]);
  } finally {
    clearTimeout(timer);
  }
}
