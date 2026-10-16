#!/usr/bin/env node
/**
 * Bundle `harness.tsx` into `build/reader-frame/` (ignored; a bundle carries absolute paths). The
 * fixtures ride in as `__FIXTURES__`, so the page needs no server and no loader for `.html`.
 *
 *   node apps/webapp/test/reader-frame/build-harness.mjs [--out <dir>]   → prints the html path
 *
 * `--out` (or READER_FRAME_OUT) builds a mutation arm's bundle beside the tip's, never over it.
 */
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const argOut = process.argv.indexOf("--out");
const out = resolve(repo, argOut >= 0 ? process.argv[argOut + 1] : (process.env.READER_FRAME_OUT ?? "build/reader-frame"));
const useIntl = resolve(repo, "apps/desktop/node_modules/use-intl");
if (!existsSync(useIntl)) {
  console.error(`build-harness: ${useIntl} is absent — install the workspace's dependencies first`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const fixtures = Object.fromEntries(
  ["wp-report", "rigid", "rigid-abs"].map((n) => [n, readFileSync(resolve(here, `${n}.html`), "utf8")]),
);

await build({
  entryPoints: [resolve(here, "harness.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  jsx: "automatic",
  sourcemap: "inline",
  outfile: resolve(out, "harness.js"),
  alias: { "next-intl": resolve(here, "../editor-feel/intl-shim.mjs"), "use-intl": useIntl },
  banner: { js: "window.process = window.process || { env: {} };" },
  define: {
    "process.env.NODE_ENV": '"development"',
    "process.env.NEXT_PUBLIC_API_BASE": "undefined",
    __FIXTURES__: JSON.stringify(fixtures),
  },
  loader: { ".json": "json", ".css": "css", ".woff2": "file", ".woff": "file", ".svg": "file", ".png": "file" },
  logLevel: "warning",
});

writeFileSync(
  resolve(out, "harness.html"),
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>reader-frame harness</title>
<link rel="stylesheet" href="./harness.css">
<style>html, body { margin: 0; padding: 0; background: #fff; }</style></head>
<body><div id="pane" class="read-col"><div id="mount"></div></div><script src="./harness.js"></script></body></html>
`,
);
console.log(resolve(out, "harness.html"));
