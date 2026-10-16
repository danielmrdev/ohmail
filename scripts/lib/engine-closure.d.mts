/**
 * Declarations for `engine-closure.mjs`, so the suites that read it can be typechecked.
 *
 * The module is JavaScript because it runs before any build step exists — the same reason
 * `apps/sidecar/src/phone/aliases.js` is, and the same remedy. Written by hand and held to the
 * module by the tests that import it: a wrong shape here fails where the wrong shape is used.
 */

/** A bundled input path mapped back to the source it came from (`/dist/x.js` → `/src/x.ts`). */
export function sourceForInput(input: string): string;

/** Every source file the engine's metafile conveys, and the metafile's own mtime. */
export function engineClosure(args: { root: string; metafile: string }): {
  files: string[];
  metafileMtimeMs: number;
};

/** The closure reached from `seed` by following specifiers, and what it refused to follow. */
export function sourceClosure(args: {
  root: string;
  seed: readonly string[];
  isDenied?: (spec: string) => boolean;
  specifiersIn?: (src: string, file: string) => readonly string[];
  resolve?: (spec: string, from: string) => string | null;
}): { files: string[]; refusals: unknown[] };

/** The metafile's files split by whether the bundle actually ships them. */
export function loadedClosure(args: { root: string; metafile: string; bundle?: string }): {
  loaded: string[];
  shaken: string[];
  bundle: string;
  metafileMtimeMs: number;
};
