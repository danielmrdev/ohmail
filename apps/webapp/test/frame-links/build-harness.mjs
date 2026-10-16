#!/usr/bin/env node
/**
 * Bundle `harness.ts` into `build/frame-links/` — the ignored build tree, never under `src` (an
 * esbuild bundle carries every module's absolute path). `next-intl` resolves to `use-intl`
 * through the editor-feel shim, as the desktop resolves it.
 *
 *   node apps/webapp/test/frame-links/build-harness.mjs [--out <dir>]   → prints the out dir
 *
 * `--out` (or FRAME_LINKS_OUT) builds a mutation arm's bundle beside, never over, the real one.
 */
import { build } from "esbuild";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const argOut = process.argv.indexOf("--out");
const out = resolve(repo, argOut >= 0 ? process.argv[argOut + 1] : (process.env.FRAME_LINKS_OUT ?? "build/frame-links"));
const useIntl = resolve(repo, "apps/desktop/node_modules/use-intl");
if (!existsSync(useIntl)) {
  console.error(`build-harness: ${useIntl} is absent — install the workspace's dependencies first`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [resolve(here, "harness.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  jsx: "automatic",
  outfile: resolve(out, "harness.js"),
  alias: { "next-intl": resolve(here, "../editor-feel/intl-shim.mjs"), "use-intl": useIntl },
  define: { "process.env.NODE_ENV": '"development"' },
  loader: { ".json": "json", ".css": "css", ".woff2": "file", ".woff": "file", ".svg": "file", ".png": "file" },
  logLevel: "warning",
});

writeFileSync(
  resolve(out, "harness.html"),
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>frame-links harness</title></head>
<body>
<p><a id="parent-control" href="https://control.test/parent" target="_blank" rel="noopener">parent control</a></p>
<div id="mail"></div><script src="./harness.js"></script></body></html>
`,
);
console.log(out);
