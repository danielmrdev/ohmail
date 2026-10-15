/**
 * ONE SCANNER FOR EVERY PRIVATE CENSUS THAT BLANKS COMMENTS BEFORE WALKING BRACKETS.
 *
 * The two regexes every census used cannot tell a comment from a comment-shaped string: a glob
 * inside backticks in a line comment opened a block the pair closed 36 lines below, and the walk
 * under it ran to the end of the file, reporting every later write as covered. Strings and regex
 * literals are blanked for the same walk and positions are preserved, so file:line stays true.
 * Published with the test set, by exact name: any published test may import it, and the
 * import-closure gate refuses an importer only of a module the payload does not carry.
 */
/**
 * TWO READINGS, because they answer two questions.
 *
 * `withoutComments` blanks COMMENTS ONLY: a census searching a block for an identifier must keep
 * string bodies, or a column name inside a `sql` template disappears and the finding changes.
 * `withoutCommentsAndLiterals` blanks the bodies too, which is what a bracket WALK needs. Both use
 * the same scan, so both know a `//` inside a string is not a comment.
 */
export function withoutComments(src) {
  return scanBlank(src, false);
}

/** Comments, strings, templates and regex literals blanked to spaces, positions preserved. */
export function withoutCommentsAndLiterals(src) {
  return scanBlank(src, true);
}

/**
 * `#` COMMENTS BLANKED, for a shell script or a workflow, positions preserved. A `#` opens one at
 * a line's start or after whitespace, outside quotes: `$#`, `${#x}` and `a#b` are words. A single
 * quote takes no escape, a double quote a backslash, and a quote ends at its line's end too, so a
 * YAML `don't` cannot swallow the file. Not a shell parser: a heredoc body reads as script.
 */
export function withoutHashComments(src) {
  const out = src.split("");
  let quote = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\n") { quote = ""; continue; }
    if (quote) {
      if (quote === '"' && c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "#" && (i === 0 || /\s/.test(src[i - 1]))) {
      while (i < src.length && src[i] !== "\n") out[i++] = " ";
      i--;
    }
  }
  return out.join("");
}

/* A `/` after one of these words opens a regex; after any other word or number it divides. */
const REGEX_AFTER = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await"]);
const WORD = /[A-Za-z0-9_$]/;

/**
 * ONE PASS, AND THE THREE PLACES A TWO-STATE READER WENT WRONG: a `/` inside a regex CLASS does not
 * end the regex (a bare one in `[A-Za-z0-9+/=]` lost a function body, 2026-09-24); a `/` after
 * `return` opens one; a template's `${…}` is CODE, read as code, with only its text blanked. The
 * `${` and its `}` are blanked with the text, so a bracket walk sees what it saw before.
 */
function scanBlank(src, blankLiterals) {
  const out = src.split("");
  const blank = (i) => { if (src[i] !== "\n") out[i] = " "; };
  const lit = (i) => { if (blankLiterals) blank(i); };
  let prev = "";        // the previous significant character
  let word = "";        // the word that ended at `prev`, when one did
  const subs = [];      // one brace depth per open `${…}`
  let i = 0;
  // Template text from `i`: true at a `${` (consumed), false at the closing backtick (consumed).
  const templateText = () => {
    while (i < src.length) {
      if (src[i] === "\\") { lit(i); lit(i + 1); i += 2; continue; }
      if (src[i] === "`") { i++; return false; }
      if (src[i] === "$" && src[i + 1] === "{") { lit(i); lit(i + 1); i += 2; subs.push(0); return true; }
      lit(i); i++;
    }
    return false;
  };
  const afterTemplate = (inSub) => { prev = inSub ? "{" : "`"; word = ""; };
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") blank(i++);
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      while (i < stop) blank(i++);
      continue;
    }
    if (c === "`") { i++; afterTemplate(templateText()); continue; }
    if (c === '"' || c === "'") {
      i++;                                    // the opening quote stays
      while (i < src.length) {
        if (src[i] === "\\") { lit(i); lit(i + 1); i += 2; continue; }
        if (src[i] === c) { i++; break; }     // the closing quote stays
        lit(i); i++;
      }
      prev = c; word = "";
      continue;
    }
    if (subs.length && c === "}" && subs[subs.length - 1] === 0) {
      subs.pop(); lit(i); i++; afterTemplate(templateText()); continue;
    }
    if (subs.length && c === "{") subs[subs.length - 1]++;
    if (subs.length && c === "}") subs[subs.length - 1]--;
    if (c === "/" && (prev === "" || /[(,=:[!&|?{};+\-*%~^<>]/.test(prev) || REGEX_AFTER.has(word))) {
      i++;                                    // a regex literal, by what precedes it
      let inClass = false;
      while (i < src.length && src[i] !== "\n") {
        if (src[i] === "\\") { lit(i); lit(i + 1); i += 2; continue; }
        if (inClass) { if (src[i] === "]") inClass = false; }
        else if (src[i] === "[") inClass = true;
        else if (src[i] === "/") { i++; break; }
        lit(i); i++;
      }
      prev = "/"; word = "";
      continue;
    }
    if (WORD.test(c)) {
      let j = i;
      while (j < src.length && WORD.test(src[j])) j++;
      word = src.slice(i, j); prev = src[j - 1]; i = j;
      continue;
    }
    if (!/\s/.test(c)) { prev = c; word = ""; }
    i++;
  }
  return out.join("");
}

/**
 * The span between a bracket and its match, exclusive, with whether it CLOSED.
 *
 * A runaway is the failure this whole module exists to stop, so it is returned rather than
 * silently clamped: a caller that treats `closed: false` as an ordinary span is choosing to, in
 * one visible place.
 */
export function bracketSpan(src, open, o = "(", c = ")") {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === o) depth++;
    else if (src[j] === c) { depth--; if (depth === 0) return { start: open + 1, end: j, closed: true }; }
  }
  return { start: open + 1, end: src.length, closed: false };
}

/** `bracketSpan` as the `[start, end]` pair the censuses already pass around. */
export function span(src, open, o = "(", c = ")") {
  const s = bracketSpan(src, open, o, c);
  return [s.start, s.end];
}

/** 1-based line number of an index, for a census that reports `file:line`. */
export function lineOf(src, at) {
  return src.slice(0, at).split("\n").length;
}
