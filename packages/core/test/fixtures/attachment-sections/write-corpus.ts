import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SECTION_CORPUS } from "./corpus.js";

/* Writes the corpus as `<group>/<name>.eml` under the directory named on the command line, for the
   kit recorder (`record-sections.mjs`), which reads files and cannot import TypeScript. Run with tsx. */
const out = process.argv[2];
if (!out) { process.stderr.write("usage: tsx write-corpus.ts <dir>\n"); process.exit(2); }
for (const e of SECTION_CORPUS) {
  mkdirSync(join(out, e.group), { recursive: true });
  writeFileSync(join(out, e.group, `${e.name}.eml`), e.raw);
}
process.stdout.write(`WROTE ${SECTION_CORPUS.length} fixtures to ${out}\n`);
