/**
 * THE ANSWERS THE JSON MEMBERS OWE, written once so the two runs cannot drift.
 *
 * `json-merge-dialect.test.ts` asks both stores these questions through the seam;
 * `dialect-json-real-pg.pg.test.ts` asks real Postgres the same ones and, beside them, whether the
 * spellings these replaced answered identically. A table copied into each file would be two tables
 * the day one of them is corrected.
 */

/** A shallow merge: the patch's top-level keys win, the document's others survive. */
export const MERGE_CASES: readonly {
  what: string;
  document: string | null;
  patch: string;
  expected: Record<string, unknown>;
}[] = [
  { what: "flat, overlapping and new keys",
    document: '{"host":"a","port":1}', patch: '{"host":"b","user":"u"}',
    expected: { host: "b", port: 1, user: "u" } },
  // The case `json_patch` gets wrong: RFC 7396 merges into the nested object instead of replacing
  // it, so a stale sub-key survives a block that was meant to be rewritten whole.
  { what: "a nested object is REPLACED, not merged into",
    document: '{"oauth":{"a":1,"b":2},"host":"h"}', patch: '{"oauth":{"a":9}}',
    expected: { oauth: { a: 9 }, host: "h" } },
  // The other case it gets wrong: RFC 7396 DELETES a key whose patch value is null.
  { what: "a null in the patch SETS null, it does not delete the key",
    document: '{"host":"h"}', patch: '{"host":null}', expected: { host: null } },
  { what: "a NULL document reads as the empty object",
    document: null, patch: '{"host":"h","secure":true}',
    expected: { host: "h", secure: true } },
  { what: "an empty patch changes nothing",
    document: '{"host":"h"}', patch: "{}", expected: { host: "h" } },
  { what: "both empty",
    document: "{}", patch: "{}", expected: {} },
  { what: "arrays are values, replaced whole",
    document: '{"a":[1,2]}', patch: '{"a":[3],"b":[4,{"c":5}]}',
    expected: { a: [3], b: [4, { c: 5 }] } },
  // A key holding `.` or `[` is an ordinary key and a different PATH — the device arm addresses it
  // through `fullkey`, which is why this one is here rather than in a comment.
  { what: "a key that looks like a path is still a key",
    document: '{"a.b":1,"x[0]":2}', patch: '{"a.b":9}',
    expected: { "a.b": 9, "x[0]": 2 } },
];

/** Is the value at this key an array? A missing key and a non-array are both `false`. */
export const IS_ARRAY_CASES: readonly {
  what: string; document: string; key: string; isArray: boolean;
}[] = [
  { what: "an array", document: '{"auto-submitted":["auto-replied"]}', key: "auto-submitted", isArray: true },
  { what: "an empty array", document: '{"auto-submitted":[]}', key: "auto-submitted", isArray: true },
  { what: "a string", document: '{"auto-submitted":"auto-replied"}', key: "auto-submitted", isArray: false },
  { what: "an object", document: '{"auto-submitted":{"a":1}}', key: "auto-submitted", isArray: false },
  { what: "a JSON null", document: '{"auto-submitted":null}', key: "auto-submitted", isArray: false },
  { what: "an absent key", document: "{}", key: "auto-submitted", isArray: false },
  { what: "a key holding a dot", document: '{"a.b":[1]}', key: "a.b", isArray: true },
];

/**
 * The STRING elements of one key's array, in order — the filter the away-responder arms depend on.
 *
 * A non-string member is dropped rather than rendered: `["auto-submitted": [5]]` is not machine-
 * sent, and a text-flattening reader would have turned that `5` into `'5'` and fired the arm.
 */
export const ELEMENT_CASES: readonly {
  what: string; document: string; key: string; strings: readonly string[];
}[] = [
  { what: "one string", document: '{"h":["no"]}', key: "h", strings: ["no"] },
  { what: "strings in order", document: '{"h":["a","b"]}', key: "h", strings: ["a", "b"] },
  { what: "numbers are not strings", document: '{"h":[5,"a",true,null]}', key: "h", strings: ["a"] },
  { what: "a nested array is not a string", document: '{"h":[["a"],"b"]}', key: "h", strings: ["b"] },
  { what: "an empty array", document: '{"h":[]}', key: "h", strings: [] },
];

/**
 * THE TWO SPELLINGS THE AWAY-RESPONDER ARMS LOST, and the answers both have to give.
 *
 * `blank` is the `auto-submitted` arm: the server asked `!~* '^[[:space:]]*no[[:space:]]*$'`, the
 * port asks `lower(trim(v)) <> 'no'`. `precedence` is the other: `~* 'bulk|auto_?reply|junk|list'`
 * against five substring searches. Every value here is answered by both spellings on real
 * Postgres in `dialect-json-real-pg.pg.test.ts`; the NBSP row is the residual the pair keeps.
 */
export const FOLD_CASES: readonly {
  value: string; notNo: boolean; precedence: boolean;
}[] = [
  { value: "no", notNo: false, precedence: false },
  { value: "No", notNo: false, precedence: false },
  { value: "NO", notNo: false, precedence: false },
  { value: " no ", notNo: false, precedence: false },
  { value: "\tno\n", notNo: false, precedence: false },
  // WRITTEN AS AN ESCAPE, never as a literal byte: this is the documented residual, and a
  // reader has to be able to SEE that the padding is not ASCII whitespace. `trim()` strips it
  // in TypeScript, neither SQL spelling strips it, so both answer "machine-sent" here.
  { value: "\u00a0no\u00a0", notNo: true, precedence: false },
  { value: "nope", notNo: true, precedence: false },
  { value: "n o", notNo: true, precedence: false },
  { value: "", notNo: true, precedence: false },
  { value: "   ", notNo: true, precedence: false },
  { value: "auto-replied", notNo: true, precedence: false },
  { value: "bulk", notNo: true, precedence: true },
  { value: "BULK", notNo: true, precedence: true },
  { value: "list", notNo: true, precedence: true },
  { value: "Junk", notNo: true, precedence: true },
  { value: "autoreply", notNo: true, precedence: true },
  { value: "auto_reply", notNo: true, precedence: true },
  { value: "AUTO_REPLY", notNo: true, precedence: true },
  // The wildcard trap: `_` matches any one character in LIKE, so a LIKE-based port of
  // `auto_?reply` would have said true here and the regex says false.
  { value: "autoXreply", notNo: true, precedence: false },
  { value: "auto-reply", notNo: true, precedence: false },
];
