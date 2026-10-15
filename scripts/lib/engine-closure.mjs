import fs from "node:fs";
import path from "node:path";

/**
 * engine-closure.mjs — WHICH SOURCE FILES THE SHIPPED ENGINE CONVEYS, measured rather than listed.
 * GPL-3.0 obliges the publisher to offer the CORRESPONDING SOURCE of what the binary conveys; the engine
 * bundle's esbuild metafile is the ground-truth list of every file that became bytes, so the publishable
 * set is a fact about the artifact, read here (a hand-written glob guesses and fails both ways — too narrow
 * is an incomplete corresponding source, too wide publishes files nobody ships). Included: every input
 * under `packages/<pkg>/` or `apps/<app>/`, whether esbuild read it as `dist/*.js` (mapped back to `src`)
 * or `src/*.ts`. NOT restricted to a chosen set of packages (a correction against measurement:
 * `core|services|db|client-engine` omitted 52 files the binary contains — `packages/api`'s route table 39,
 * `apps/worker` 4, `apps/sidecar` 8, `packages/db-mail` 1); safe because `scripts/build-engine.mjs` refuses a private input. Third-party (`node_modules`) excluded. Staleness is a REFUSAL, never a shrug ({@link engineClosure} throws). */

/** An input path esbuild recorded that belongs to this workspace rather than to a dependency. */
const OWN_INPUT = /^(packages|apps)\/[^/]+\/(dist|src)\//;

/** `packages/x/dist/a/b.js` → `packages/x/src/a/b.ts`; a `src` input is already the source. */
export function sourceForInput(input) {
  if (!input.includes("/dist/")) return input;
  return input.replace("/dist/", "/src/").replace(/\.js$/, ".ts");
}

/**
 * The own-workspace SOURCE files an esbuild input list conveys — the filter and the dist→src mapping
 * as ONE definition, because a second copy of it is a second answer. {@link engineClosure} reads it
 * off a metafile with the staleness rules the licence question needs; the engine MARKER sweep at a
 * landing asks the same question of a range and must not be given a hand-typed root list (the K14
 * cascade: a marker in a comment of a newly bundled db module, refused at the built artifact and
 * invisible to every earlier gate).
 */
export function ownSources(inputs) {
  return [...new Set(inputs.filter((p) => OWN_INPUT.test(p)).map(sourceForInput))].sort();
}

/**
 * The source files the engine bundle conveys.
 *
 * @param {object} o
 * @param {string} o.root      monorepo root
 * @param {string} o.metafile  path to `ohmail-engine.meta.json`
 * @returns {{ files: string[], metafileMtimeMs: number }} sorted, deduplicated, repo-relative
 */
export function engineClosure({ root, metafile }) {
  if (!fs.existsSync(metafile)) {
    throw new Error(
      `the engine metafile is missing: ${metafile}\n` +
      `  The published source set is DERIVED from what the engine actually bundles, so there is\n` +
      `  nothing to derive it from. Build the engine first:\n\n` +
      `    D=$(mktemp -d) && (cd $D && npm install --no-save esbuild@0.24.0)\n` +
      `    OHMAIL_ESBUILD_FROM=$D node scripts/build-engine.mjs`);
  }
  const meta = JSON.parse(fs.readFileSync(metafile, "utf8"));
  const inputs = Object.keys(meta.inputs ?? {});
  if (inputs.length === 0) throw new Error(`the engine metafile records no inputs: ${metafile}`);

  const files = ownSources(inputs);

  /* An extraction that silently stopped matching would hand back an empty list, and an empty list
   * publishes no engine source at all — which looks like a clean run. The engine is tens of files;
   * a handful means the shape of the metafile changed under this code. */
  if (files.length < 40) {
    throw new Error(
      `only ${files.length} own-workspace inputs were derived from the engine metafile, which is far\n` +
      `  fewer than the engine contains. The metafile's shape has changed and this derivation can no\n` +
      `  longer be trusted — fix it rather than publishing an under-derived set.`);
  }

  const missing = files.filter((f) => !fs.existsSync(path.join(root, f)));
  if (missing.length) {
    throw new Error(
      `the engine metafile names source files that are not in the tree:\n\n` +
      missing.slice(0, 20).map((f) => `    ${f}`).join("\n") +
      `\n\n  The metafile does not describe this tree. Rebuild the engine.`);
  }

  /* THE STALENESS CHECK. Newer than every source it names, or it describes a different engine. */
  const metaMtime = fs.statSync(metafile).mtimeMs;
  const newer = files.filter((f) => fs.statSync(path.join(root, f)).mtimeMs > metaMtime);
  if (newer.length) {
    throw new Error(
      `the engine metafile is STALE — ${newer.length} source file(s) changed after it was written:\n\n` +
      newer.slice(0, 20).map((f) => `    ${f}`).join("\n") +
      `\n\n  Publishing from it would offer source that corresponds to no artifact. Rebuild the engine.`);
  }

  return { files, metafileMtimeMs: metaMtime };
}

/**
 * The SOURCE closure over a runtime seed: every workspace module the seed's files import, transitively.
 * {@link engineClosure} reads what the binary CONVEYS (the licence's question, and the wrong one for a repo
 * that must compile): TypeScript erases `import type` before esbuild records an input, so a type-only module
 * is never in the metafile, and publishing the runtime closure verbatim leaves importers whose targets are
 * absent. The consequence: MOVING a type-only module out of a private directory does not on its own publish
 * it (the port could be hoisted and the payload not change by a file). The seed is what the binary contains;
 * this is what the source needs. Only own-workspace sources are followed; a file it reaches that `isDenied`
 * refuses is NOT dropped and NOT published but returned as a REFUSAL naming the importer.
 * @param o `{ root, seed, isDenied, specifiersIn, resolve }` → `{ files, refusals }` */
export function sourceClosure({ root, seed, isDenied, specifiersIn, resolve }) {
  const refusals = [];

  /* THE SEED IS JUDGED TOO, AND FOR A WHILE IT WAS NOT. This began `const included = new Set(seed)`, which
   * admitted every seed member unconditionally and consulted `isDenied` only for modules reached by
   * traversal — so the deny-list was advisory for the set that matters: any private file that becomes a
   * bundle input was published no matter what, and the publish exited 0. Not hypothetical:
   * `apps/worker/src/build-version.ts` and `packages/api/src/cookies.ts` were in the inputs AND deny-listed
   * and sat in the published closure behind a clean run (it never bit earlier because `build-engine.mjs`'s
   * census uses a DIFFERENT "private half" and reported zero). A deny-list that only governs traversal is
   * not one, so a denied seed member is refused with the file as its own importer — the artifact asked for it. */
  const included = new Set();
  const queue = [];
  for (const rel of seed) {
    if (isDenied(rel)) {
      refusals.push({ file: rel, specifier: "(the artifact conveys this file directly)", target: rel });
      continue;
    }
    included.add(rel);
    queue.push(rel);
  }

  while (queue.length) {
    const rel = queue.shift();
    if (!/\.(ts|tsx|mjs|js)$/.test(rel)) continue;
    let src;
    try {
      src = fs.readFileSync(path.join(root, rel), "utf8");
    } catch {
      continue;
    }
    for (const spec of specifiersIn(src)) {
      const target = resolve(rel, spec);
      /* Unresolvable means third-party (or a specifier no static scan can follow). Both are
       * outside this function's remit — the import-resolvability gate judges what is left. */
      if (!target || included.has(target)) continue;
      if (isDenied(target)) {
        refusals.push({ file: rel, specifier: spec, target });
        continue;
      }
      included.add(target);
      queue.push(target);
    }
  }

  return { files: [...included].sort(), refusals };
}

/**
 * WHICH OF THE CONVEYED FILES THE BUNDLE ACTUALLY LOADS — bytes shipped, not merely in the graph.
 * {@link engineClosure} answers what the binary CONVEYS; this answers which of those the artifact RUNS,
 * which a census deciding whether a Postgres-only construct is a device defect needs (a construct whose
 * bytes never reached the bundle never executes there). The mark is `bytesInOutput`, not membership of
 * `inputs`: esbuild records a file as soon as it PARSES it (every barrel re-export), and tree-shaken ones
 * appear with `bytesInOutput: 0` — counting membership would refuse debt that is not a defect. A file is
 * LOADED when ANY input mapping to it ships bytes. An output key that does not exist is a REFUSAL, not an
 * empty set: with `write: false` esbuild names the output after the ENTRY POINT's basename, so a missing
 * key would answer "no file ships bytes" (a clean, wrong pass). `bundle` naming no output throws. @param o `{ root, metafile, bundle? }` → `{ loaded, shaken, bundle, metafileMtimeMs }` */
export function loadedClosure({ root, metafile, bundle }) {
  const { files, metafileMtimeMs } = engineClosure({ root, metafile });
  const meta = JSON.parse(fs.readFileSync(metafile, "utf8"));
  const keys = Object.keys(meta.outputs ?? {});

  let key;
  if (bundle === undefined) {
    if (keys.length !== 1) {
      throw new Error(
        `this metafile records ${keys.length} outputs, so "the bundle" is ambiguous — name one:\n\n` +
        keys.slice(0, 20).map((k) => `    ${k}`).join("\n"));
    }
    key = keys[0];
  } else {
    key = keys.find((k) => k === bundle);
    if (!key) {
      throw new Error(
        `the metafile records no output named ${bundle}, so nothing could be read from it. An\n` +
        `  absent key answers "no file ships any bytes", which is an empty census reporting as a\n` +
        `  pass. The outputs it does record are:\n\n` +
        keys.slice(0, 20).map((k) => `    ${k}`).join("\n"));
    }
  }

  const shipped = new Set();
  for (const [input, record] of Object.entries(meta.outputs[key].inputs ?? {})) {
    if (!OWN_INPUT.test(input)) continue;
    if ((record?.bytesInOutput ?? 0) > 0) shipped.add(sourceForInput(input));
  }

  return {
    loaded: files.filter((f) => shipped.has(f)),
    shaken: files.filter((f) => !shipped.has(f)),
    bundle: key,
    metafileMtimeMs,
  };
}
