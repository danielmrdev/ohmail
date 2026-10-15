/**
 * Preamble for `cli-exit-drain.test.ts` — puts the oversized `TF_PROD_DB_HOST` pin into the CLI
 * process's view of the environment, from a file, because the environment BLOCK cannot carry it.
 *
 * ── WHY A FILE AND NOT `spawn`'s `env` ────────────────────────────────────────────────────
 *
 * Linux caps a SINGLE argv/env string at MAX_ARG_STRLEN = 32 pages (measured on
 * this machine — a string just under it execs, a few bytes more fails). The test's pin is
 * past it, deliberately (see the size note in the test header), so it cannot cross an
 * execve boundary at all: handing it to `spawn` fails with argument-list-too-long before `/bin/sh` starts, which is
 * how that test spent its whole life on Linux never once running its two behavioural cases.
 *
 * ── WHY IT IS NOT PUT BACK INTO THE REAL ENVIRONMENT EITHER ───────────────────────────────
 *
 * The obvious repair — read the file here and assign `process.env.TF_PROD_DB_HOST` — writes the
 * pin into the process's actual environment block, and so moves the same argument-list-too-long failure one
 * level down instead of removing it. `tsx` transforms the CLI through `esbuild`, whose
 * synchronous API SPAWNS a service process; that spawn inherits the environment and dies:
 *
 *     Error: spawn <argument list too long> … at ensureServiceIsRunning (esbuild/lib/main.js) { name: 'TransformError' }
 *
 * — i.e. the CLI is killed by its own loader before it prints anything. Measured, not feared.
 *
 * So the pin is installed as a NON-ENUMERABLE property on a plain-object replacement for
 * `process.env`. A read — `process.env.TF_PROD_DB_HOST`, which is the only thing the CLIs do
 * with it — returns the whole pin. Enumeration does not see it, and enumeration is
 * how `child_process` builds a child's environment, so nothing below this process can inherit a
 * string no execve would accept. Verified in place: the full length in-process, `${#…}` = 0 in a
 * spawned shell, no argument-list-too-long failure.
 *
 * Nothing about what the test measures is touched. The CLI reads `process.env.TF_PROD_DB_HOST`
 * exactly as it does when an operator exports the variable, composes its own refusal line from
 * it, writes that line into a real kernel pipe, and exits by setting `process.exitCode` — the
 * drain-versus-exit race under test happens entirely after this file has finished.
 *
 * No-op unless `TF_PROD_DB_HOST_FILE` is set, so importing it can never leak a pin into an
 * unrelated run.
 */
import { readFileSync } from "node:fs";

const file = process.env.TF_PROD_DB_HOST_FILE;
if (file) {
  const pin = readFileSync(file, "utf8");
  // A plain object, so the assignment below cannot write through to the real environment block:
  // `process.env` is a writable data property over an exotic proxy, and replacing it leaves the
  // block the kernel copies on execve exactly as it was.
  const view = { ...process.env };
  delete view.TF_PROD_DB_HOST_FILE;
  Object.defineProperty(view, "TF_PROD_DB_HOST", {
    value: pin,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  process.env = view;
}
