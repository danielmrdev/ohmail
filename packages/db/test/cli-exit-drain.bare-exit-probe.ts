/**
 * The CONTROL for `cli-exit-drain.test.ts`: the defect, on purpose, in four lines.
 *
 * The two behavioural cases in that file assert that a CLI's last line SURVIVES a pipe. An
 * assertion like that is only evidence if the harness could have seen it fail — and this file's
 * whole history is of a harness that could not: for its entire life on Linux it died at spawn
 * with argument-list-too-long before running, and the first repair produced two green behavioural cases that stayed
 * green with `process.exit` restored, because `tsx`'s transform spawns an `esbuild` service
 * process that INHERITS stderr, and an inherited fd is put back into blocking mode — after which
 * every write completes synchronously and nothing is left to discard. A guard that cannot fail is
 * decoration, and this one was decoration twice.
 *
 * So the failure is watched on every run instead of once, by hand: this probe writes the same
 * oversized line the real CLIs write and then calls `process.exit` — the shape the CLIs are
 * forbidden from having — and the test asserts the line comes back TRUNCATED. If it ever arrives
 * whole, the harness has stopped being able to observe the defect and the behavioural cases next
 * to it mean nothing; the fix is to restore the conditions, not to relax the case.
 *
 * ── THE SENTINEL AND THE EXIT CODE ARE HALF THE POINT ────────────────────────────────────
 *
 * "Most of the output is missing" is also what a probe that NEVER RAN looks like. A shim that
 * throws on an unreadable pin file, a loader that cannot resolve, a syntax error — all of them
 * leave a short body with no pin in it, exit non-zero, and would have satisfied a control that
 * only asked for absence. So this probe says who it is BEFORE the oversized write (small enough
 * to be inside the pipe buffer, so the truncation cannot take it) and leaves by a code no
 * failure path produces. The test asserts all four: the sentinel arrived, the big line STARTED,
 * its tail did not, and the exit was this file's own.
 *
 * Deliberately in `test/`, not `src/`: the structural case scans `packages/db/src` for
 * `process.exit` and this file is a standing violation of the rule it protects.
 */
/**
 * Proof the body ran. NOT exported, and that is not tidiness: importing this module RUNS it,
 * so an `import { PROBE_SENTINEL }` in the test would print 400 KB and kill the vitest worker
 * with `process.exit`. The string is duplicated in the test, beside a note saying so.
 */
const PROBE_SENTINEL = "___PROBE_RAN";
/** Not 0 and not 1: a loader or shim failure exits 1, and this must not look like one. */
const PROBE_EXIT = 3;

console.error(PROBE_SENTINEL);
console.error(process.env.TF_PROD_DB_HOST ?? "");
process.exit(PROBE_EXIT);
