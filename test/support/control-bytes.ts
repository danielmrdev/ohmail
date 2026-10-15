/**
 * The control-byte readers the two no-control-bytes guards share: the text kinds, the byte set
 * (every byte but tab, newline and carriage return), the walk and the offender line.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const TEXT = new Set([
  ".ts", ".tsx", ".mts", ".mjs", ".js", ".css", ".html", ".json", ".md", ".txt", ".sql",
  ".toml", ".yml", ".yaml", ".sh", ".svg", ".plist", ".nsh", ".rs", ".swift", ".kt", ".gradle",
  ".lock", ".gitignore", ".xml", ".patch",
]);
/** Every byte except tab (0x09), newline (0x0a) and carriage return (0x0d). */
export const FORBIDDEN = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;export function* walk(path: string): Generator<string> {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isFile()) { yield path; return; }
  for (const name of readdirSync(path)) {
    if (name === "node_modules" || name === "dist" || name === ".next" || name === "target") continue;
    yield* walk(join(path, name));
  }
}

/** `<path>:<line> byte 0x<hh> at offset <n>` for the first control byte in a file, if any. */
export function offenderIn(file: string, root: string): string | null {
  const text = readFileSync(file, "latin1");
  const m = FORBIDDEN.exec(text);
  if (!m) return null;
  const line = text.slice(0, m.index).split("\n").length;
  const hex = m[0].charCodeAt(0).toString(16).padStart(2, "0");
  return `${file.slice(root.length + 1)}:${line} byte 0x${hex} at offset ${m.index}`;
}
