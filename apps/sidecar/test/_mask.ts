/**
 * COMMENT- AND STRING-MASKING FOR THE PACKAGE'S SOURCE CENSUSES.
 *
 * Lifted out of `log-census.test.ts` when a second census needed it. It is a helper rather than an
 * export of that test file for one mechanical reason: importing a test module EXECUTES its suites,
 * so the connection census was running the log census's eleven cases as a side effect of borrowing
 * one function.
 *
 * One implementation, deliberately. Two maskers are two things that can disagree about what counts
 * as code, and a census that reads a comment as a call is a census that fails on its own
 * documentation — which is exactly what happened before this was applied.
 */
/**
 * Replace every comment with spaces, preserving offsets, and then blank the INTERIOR of every
 * string and template literal while keeping its quotes.
 *
 * The masked text is what every structural decision below is made on — brace depth, argument
 * commas, property positions — so a string containing `log(` or a `:` cannot be mistaken for code.
 * Names are then read back out of the unmasked (comment-stripped) text at the same offsets.
 *
 * Regex literals are tracked for one concrete reason: `client.ts:139` is
 * `/^[a-z][a-z0-9+.-]*:\/\//i`, whose last two characters are `/` `/`. Without regex tracking that
 * reads as a line comment and the rest of the line disappears.
 */
export function maskSource(src: string): { code: string; mask: string } {
  const code = src.split("");
  const mask = src.split("");
  const blank = (i: number, both: boolean): void => {
    if (src[i] !== "\n") {
      mask[i] = " ";
      if (both) code[i] = " ";
    }
  };
  /** The last character that was not whitespace and not part of a comment. */
  let prev = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      const block = src[i + 1] === "*";
      const end = block ? src.indexOf("*/", i + 2) : src.indexOf("\n", i);
      const stop = end === -1 ? src.length : block ? end + 2 : end;
      for (let j = i; j < stop; j++) blank(j, true);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { blank(i, false); blank(i + 1, false); i += 2; continue; }
        if (src[i] === ch) break;
        blank(i, false);
        i++;
      }
      prev = ch;
      i++;
      continue;
    }
    // A `/` here is division iff the previous token could end an expression.
    if (ch === "/" && !/[\w$)\]]/.test(prev)) {
      i++;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === "\\") { blank(i, false); blank(i + 1, false); i += 2; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) break;
        blank(i, false);
        i++;
      }
      prev = "/";
      i++;
      continue;
    }
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }
  return { code: code.join(""), mask: mask.join("") };
}
