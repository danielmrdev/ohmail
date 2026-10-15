import { bracketSpan, lineOf, withoutComments, withoutCommentsAndLiterals } from "./source-scan.mjs";

/**
 * THE PRESS READERS OF ONE SOURCE FILE — every CALL of `mutate(` or `dispatch(` whose result's
 * `status` is compared with a literal in the code that follows it, up to the end of the innermost
 * block holding the call. Definitions (`mutate(m) {`, `async dispatch(…): …`) are not calls.
 * Each site says whether that window carries a `"superseded"` arm and whether it reads the result
 * through `pressVerdict`. Comments are blanked first, string bodies kept for the literal reads.
 */
export function pressReaderSites(src) {
  const bare = withoutCommentsAndLiterals(src);
  const text = withoutComments(src);
  const sites = [];
  const call = /(?<![\w$])(?:mutate|dispatch)\s*\(/g;
  for (let m = call.exec(bare); m !== null; m = call.exec(bare)) {
    const open = m.index + m[0].length - 1;
    const args = bracketSpan(bare, open);
    if (!args.closed) continue;
    const after = bare.slice(args.end + 1).trimStart();
    if (after.startsWith("{") || after.startsWith(":")) continue;
    const before = bare.slice(Math.max(0, m.index - 16), m.index);
    if (/(?:function|async|get|set)\s+$/.test(before)) continue;
    const end = enclosingBlockEnd(bare, m.index);
    const window = text.slice(m.index, end);
    if (!/\bstatus\s*[!=]==?\s*["']/.test(window)) continue;
    sites.push({
      line: lineOf(src, m.index),
      superseded: /["']superseded["']/.test(window),
      viaVerdict: /\bpressVerdict\b/.test(window),
    });
  }
  return sites;
}

/** The index of the `}` closing the innermost `{` block that holds `at`, or the file's end. */
function enclosingBlockEnd(bare, at) {
  let depth = 0;
  for (let i = at; i < bare.length; i++) {
    if (bare[i] === "{") depth++;
    else if (bare[i] === "}") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return bare.length;
}
