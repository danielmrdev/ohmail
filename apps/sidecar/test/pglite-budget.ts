/**
 * THE PGLITE STANDUP BUDGET — why the files importing this raise vitest's default 5 s timeout.
 *
 * Every test in those files stands up its own local database inside the test body: `openLocalDb`
 * — or `createSidecar`, which opens the same store — boots PGlite (WASM Postgres) and runs the
 * full migration set before the test's own work begins. Measured on this machine, 2026-08-26,
 * from the suite's own timings: 5.3–5.6 s wall per mirror standup (`cloud-write-through.test.ts`,
 * all four tests — three passed at 5.3–5.5 s only because their afterEach teardown sat outside
 * the budget), and ~7.5 s per DOOR standup (`hello.test.ts`, both tests, re-measured green under
 * `--testTimeout=30000` after failing at the default on an otherwise idle machine). The WHOLE of
 * vitest's 5 s default is spent before the first assertion, so green versus "Test timed out in
 * 5000ms" is decided by scheduler load, not by the code under test.
 *
 * The raise covers the standup's measured cost with headroom for a loaded machine. It is NOT
 * license for a slow assertion: everything after the standup runs against in-process fakes and
 * settles in milliseconds, so a genuine hang still fails — later, and just as red.
 */
export const PGLITE_STANDUP_BUDGET_MS = 30_000;
