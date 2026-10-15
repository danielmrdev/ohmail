import type { NormalizedMessage, AttachmentMeta } from "../../src/types.js";
import type { IndeterminateReason, SensitivityCategory } from "../../src/sensitive.js";

/**
 * THE FAIL-CLOSED CORPUS — every case here must end with `flags.no_ai === true`.
 *
 * the project's design notes. Before 2026-08-03 `classifySensitivity` had two outcomes and
 * "no pattern matched" WAS "ordinary", so every case below reached the model. A review's three
 * Critical findings are reproduced verbatim and the rest are
 * the classes those findings generalise to.
 *
 * Two kinds of expectation, and the difference matters:
 *
 *   `sensitive`      we RECOGNISED the mail. Routed to the account holder, body stored redacted,
 *                    `no_forward`/`priority` set. The better outcome.
 *   `indeterminate`  we could not support the claim that it is ordinary. Withheld from the model
 *                    and from the KB, routed by rules, body NOT redacted and NOT re-routed.
 *
 * Both satisfy the "Sensitive mail" invariant; neither is allowed to be `ordinary`. What is NOT allowed is for a
 * case to change from `sensitive` to `indeterminate` silently, because that is coverage being
 * lost — so each case pins which one it is.
 *
 * `raw` cases go through `normalizeMime`, which is the only honest way to test the second finding: the
 * review reproduced it "through the repository MIME normalizer", and a hand-built `NormalizedMessage`
 * would let the test assume the very part layout that was in question.
 */

export interface WithheldCase {
  id: string;
  /** The class this case stands for — read as the corpus's table of contents. */
  why: string;
  /** A raw RFC822 message, normalised by `mime.ts` before the detector sees it. */
  raw?: string;
  /** Or a direct `NormalizedMessage` patch, for shapes that need no MIME structure. */
  patch?: Partial<NormalizedMessage>;
  expect: "sensitive" | "indeterminate";
  category?: SensitivityCategory;
  /** At least this reason must be present. Others may be. */
  reason?: IndeterminateReason;
}

export function normalized(patch: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    canonical: { messageIdHeader: null, bodyHash: "x" },
    subject: "", from: { name: null, address: "no-reply@service.invalid" }, to: [],
    date: null, headers: {}, textBody: "", htmlBody: null,
    hasAttachments: (patch.attachments ?? []).length > 0,
    attachments: [],
    ...patch,
  };
}

const att = (filename: string | null, contentType: string): AttachmentMeta =>
  ({ filename, contentType, sizeBytes: 2048, partId: "2", contentId: null, inline: false });

const ZWSP = "​";

/** A `multipart/alternative` whose two parts disagree — the exact shape. */
function multipart(plain: string, html: string, subject: string): string {
  const b = "b0undary-x1c2";
  return [
    "Message-ID: <x1c2@service.invalid>",
    "From: Atlas Identity <no-reply@atlas-identity.invalid>",
    "To: ohmail@lichtgrat.example",
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${b}"`,
    "",
    `--${b}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    plain,
    `--${b}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
    `--${b}--`,
    "",
  ].join("\r\n");
}

function simple(subject: string, body: string, extra: string[] = []): string {
  return [
    "Message-ID: <plain@service.invalid>",
    "From: Atlas Identity <no-reply@atlas-identity.invalid>",
    "To: ohmail@lichtgrat.example",
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    ...extra,
    "",
    body,
    "",
  ].join("\r\n");
}

export const WITHHELD: WithheldCase[] = [
  // ══ The review's own examples, verbatim ═══════════════════════════════════════════════════
  {
    id: "japanese login code",
    why: "'a Japanese login-code message'. Script the Latin vocabulary cannot reach.",
    patch: { subject: "ログインコードのお知らせ", textBody: "認証コードは 482913 です。10分間有効です。" },
    expect: "sensitive", category: "otp",
  },
  {
    id: "Your PIN",
    why: "English `Your PIN`. The word `code` never appears.",
    patch: { subject: "Your PIN", textBody: "Keep this to yourself." },
    expect: "sensitive", category: "otp",
  },
  {
    id: "verification number",
    why: "`482913 is your verification number` / body `Enter 482913 in the app`.",
    patch: { subject: "482913 is your verification number", textBody: "Enter 482913 in the app." },
    expect: "sensitive", category: "otp",
  },
  {
    id: "unframed code only",
    why: "The same body with NO framing anywhere — the residue the vocabulary cannot claim.",
    patch: { subject: "Atlas", textBody: "Enter 482913 in the app." },
    expect: "indeterminate", reason: "credential_shape",
  },

  // ══ MIME alternatives, through the real normalizer ════════════════════════════════
  {
    id: "divergent multipart/alternative",
    why: "Reproduced end to end: plain part is ONLY the bearer URL, HTML part labels it "
      + "'Your magic sign-in link'. The plain part is what becomes the model snippet.",
    raw: multipart(
      "https://accounts.example.com/session?t=SECRET-LOGIN-TOKEN",
      '<html><body><p>Your magic sign-in link</p>'
      + '<a href="https://accounts.example.com/session?t=SECRET-LOGIN-TOKEN">Continue</a></body></html>',
      "Atlas Identity",
    ),
    expect: "sensitive", category: "verification",
  },
  {
    id: "bearer URL with no HTML to explain it",
    why: "The same plain part alone. Nothing states what the link does, so nothing can be claimed.",
    patch: { subject: "Atlas Identity", textBody: "https://accounts.example.com/session?t=SECRET-LOGIN-TOKEN" },
    expect: "indeterminate", reason: "auth_url_token",
  },
  {
    id: "HTML-only OTP, empty text part",
    why: "A sender who ships no plain alternative at all.",
    raw: [
      "Message-ID: <htmlonly@service.invalid>",
      "From: Atlas <no-reply@atlas-identity.invalid>",
      "To: ohmail@lichtgrat.example",
      "Subject: Atlas",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html><body><h1>Your verification code</h1><p>482913</p></body></html>",
      "",
    ].join("\r\n"),
    expect: "sensitive", category: "otp",
  },
  {
    id: "attachment filename carries the credential",
    why: "Attachment filenames are an uninspected surface.",
    patch: {
      subject: "Documents", textBody: "See attached.", hasAttachments: true,
      attachments: [att("verification-code-482913.pdf", "application/pdf")],
    },
    expect: "sensitive", category: "otp",
  },
  {
    id: "attached message/rfc822",
    why: "An attached forward whose inner body holds the code. DEFERRED — the bytes are "
      + "not in NormalizedMessage — so it must fail closed rather than be judged.",
    patch: {
      subject: "FYI", textBody: "Forwarding this on.", hasAttachments: true,
      attachments: [att("Your verification code.eml", "message/rfc822")],
    },
    expect: "sensitive", category: "otp",   // the FILENAME already says it; see /f for the blind case
  },
  {
    id: "attached message/rfc822 with a neutral filename",
    why: "The same attachment with nothing in its name. We are blind to the inner message.",
    patch: {
      subject: "FYI", textBody: "Forwarding this on.", hasAttachments: true,
      attachments: [att("attachment-1.eml", "message/rfc822")],
    },
    expect: "indeterminate", reason: "nested_message",
  },

  // ══ reversible encodings and invisible characters ═════════════════════════════════
  {
    id: "nested base64 block",
    why: "Verbatim payload: a quoted `Content-Transfer-Encoding: base64` part inside the "
      + "body. Decoded LOCALLY here, so the outcome is recognition and not merely refusal.",
    patch: {
      subject: "Fwd: notice",
      textBody: "---------- Forwarded message ----------\nContent-Transfer-Encoding: base64\n\n"
        + "WW91ciB2ZXJpZmljYXRpb24gY29kZSBpcyA0ODI5MTMu",
    },
    expect: "sensitive", category: "otp",
  },
  {
    id: "quoted-printable inside the body",
    why: "Verbatim: `Your verificati=6Fn c=6Fde is 482913=2E`.",
    patch: { subject: "Fwd", textBody: "Your verificati=6Fn c=6Fde is 482913=2E" },
    expect: "sensitive", category: "otp",
  },
  {
    id: "zero-width split",
    why: "Verbatim: `ver<U+200B>ification co<U+200B>de is 482913`.",
    patch: { subject: "Atlas", textBody: `ver${ZWSP}ification co${ZWSP}de is 482913` },
    expect: "sensitive", category: "otp",
  },
  {
    id: "declared encoding we cannot decode",
    why: "A block the sender labels as an encoded transfer and which will not decode to text. "
      + "Not readable ⇒ not judgeable.",
    patch: {
      subject: "Fwd: notice",
      textBody: "Content-Transfer-Encoding: base64\n\n"
        + "//////////7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+",
    },
    expect: "indeterminate", reason: "encoded_block",
  },
  {
    id: "homoglyph small capital",
    why: "`ᴠerification` — U+1D20, which NFKC does not fold.",
    patch: { subject: "Your ᴠerification code", textBody: "482913" },
    expect: "sensitive", category: "otp",
  },
  {
    id: "soft-hyphen split",
    why: "`veri\\u00ADfication` — the shape an HTML hyphenation hint produces and an attacker reuses.",
    patch: { subject: "Your veri­fication code", textBody: "482913" },
    expect: "sensitive", category: "otp",
  },
  {
    id: "HTML numeric entity",
    why: "`&#118;erification` never reaches the matcher unless entities are decoded first.",
    patch: { subject: "Atlas", htmlBody: "<p>Your &#118;erification code is 482913</p>" },
    expect: "sensitive", category: "otp",
  },
  {
    id: "mixed-script word, nothing matched",
    why: "Cyrillic е inside a Latin word. Hiding is evident even though no vocabulary fired.",
    patch: { subject: "Hеllo thеrе", textBody: "A short note about nothing in particular." },
    expect: "indeterminate", reason: "obfuscated_text",
  },

  // ══ Non-Latin scripts — recognised where we hold vocabulary, withheld where we do not ══════
  {
    id: "script/ja ordinary",
    why: "Ordinary Japanese mail. We hold no Japanese vocabulary beyond authentication, so the "
      + "NEGATIVE answer is not ours to give.",
    patch: { subject: "先日の打ち合わせについて", textBody: "お世話になっております。来週の予定を確認させてください。" },
    expect: "indeterminate", reason: "unsupported_script",
  },
  {
    id: "script/zh otp",
    why: "Chinese 验证码.",
    patch: { subject: "您的验证码", textBody: "验证码：482913，10分钟内有效。" },
    expect: "sensitive", category: "otp",
  },
  {
    id: "script/ar otp",
    why: "Arabic رمز التحقق.",
    patch: { subject: "رمز التحقق الخاص بك", textBody: "رمز التحقق هو 482913" },
    expect: "sensitive", category: "otp",
  },
  {
    id: "script/ru otp",
    why: "Cyrillic код подтверждения.",
    patch: { subject: "Код подтверждения", textBody: "Ваш код подтверждения: 482913" },
    expect: "sensitive", category: "otp",
  },
  {
    id: "script/he otp",
    why: "Hebrew קוד אימות.",
    patch: { subject: "קוד אימות", textBody: "קוד אימות שלך: 482913" },
    expect: "sensitive", category: "otp",
  },
  {
    id: "script/ko otp",
    why: "Korean 인증번호.",
    patch: { subject: "인증번호 안내", textBody: "인증번호는 482913 입니다." },
    expect: "sensitive", category: "otp",
  },
  {
    id: "script/el otp",
    why: "Greek κωδικός επαλήθευσης — and Greek letters are also confusables, so the fold must "
      + "not destroy the Greek vocabulary before it is matched.",
    patch: { subject: "Κωδικός επαλήθευσης", textBody: "Ο κωδικός σας είναι 482913" },
    expect: "sensitive", category: "otp",
  },
  {
    id: "script/th otp",
    why: "Thai รหัสยืนยัน.",
    patch: { subject: "รหัสยืนยัน", textBody: "รหัสยืนยันของคุณคือ 482913" },
    expect: "sensitive", category: "otp",
  },
  {
    id: "script/ar ordinary",
    why: "Ordinary Arabic mail — withheld for the same reason as the Japanese one.",
    patch: { subject: "بخصوص الاجتماع", textBody: "مرحبا، أرجو تأكيد موعد الأسبوع القادم." },
    expect: "indeterminate", reason: "unsupported_script",
  },

  // ══ Latin script, language we do not hold ═════════════════════════════════════════════════
  {
    id: "lang/tr otp",
    why: "Turkish doğrulama kodu — covered additively.",
    patch: { subject: "Doğrulama kodunuz", textBody: "Doğrulama kodu: 482913" },
    expect: "sensitive", category: "otp",
  },
  {
    id: "lang/pl otp",
    why: "Polish kod weryfikacyjny.",
    patch: { subject: "Kod weryfikacyjny", textBody: "Twój kod weryfikacyjny to 482913" },
    expect: "sensitive", category: "otp",
  },
  {
    id: "lang/vi otp",
    why: "Vietnamese mã xác minh — Latin script, so rule 1 would never have fired.",
    patch: { subject: "Mã xác minh", textBody: "Mã xác minh của bạn là 482913" },
    expect: "sensitive", category: "otp",
  },
  {
    id: "lang/fi ordinary",
    why: "Ordinary Finnish. Latin script, no function word of the five we hold — so the language "
      + "probe, not the script census, is what withholds it.",
    patch: {
      subject: "Kokouksen siirtäminen ensi viikolle",
      textBody: "Hei, ehdotan että siirretään tapaaminen ensi viikon keskiviikolle. "
        + "Kerro jos sopii sinulle paremmin torstaina, järjestän mielelläni uudelleen.",
    },
    expect: "indeterminate", reason: "unrecognised_language",
  },

  // ══ Quoted and forwarded threads ══════════════════════════════════════════════════════════
  {
    id: "thread/quoted reply",
    why: "A reply whose quoted tail contains the earlier sensitive message — and it sits beyond "
      + "the 200-character model snippet, so only a full-body scan finds it.",
    raw: simple(
      "Re: Tuesday's walkthrough",
      "Thanks — that works.\n\n"
      + "On Tue, Atlas Identity wrote:\n"
      + `${"> Nothing important in this line at all, just padding to push the quote past the snippet cap. ".repeat(3)}\n`
      + "> Your verification code is 482913.\n> It expires in 10 minutes.\n",
    ),
    expect: "sensitive", category: "otp",
  },
  {
    id: "thread/forwarded",
    why: "An inline forward with the original headers pasted in.",
    raw: simple(
      "Fwd: Confirm your sign-in",
      "FYI\n\n-------- Forwarded message --------\nFrom: Atlas Identity <security@atlas-identity.invalid>\n"
      + "Subject: Confirm your sign-in\n\nUse 482913 to sign in.\n",
    ),
    expect: "sensitive", category: "otp",
  },

  // ══ Credential shapes with no framing word ════════════════════════════════════════════════
  {
    id: "shape/body is only a token",
    why: "Ordinary mail is never shaped like this.",
    patch: { subject: "Atlas", textBody: "482913" },
    expect: "indeterminate", reason: "credential_shape",
  },
  {
    id: "shape/trailer framing",
    why: "The framing follows the token instead of preceding it.",
    patch: { subject: "Atlas", textBody: "4829 13 — do not share this with anyone." },
    expect: "indeterminate", reason: "credential_shape",
  },
  {
    id: "shape/grouped code with an imperative",
    why: "`type 123-456` — grouped, which is how providers make a code readable.",
    patch: { subject: "Atlas", textBody: "Please type 123-456 on the next screen." },
    expect: "indeterminate", reason: "credential_shape",
  },

  // ══ Structural unknowns ═══════════════════════════════════════════════════════════════════
  {
    id: "structural/nothing visible",
    why: "An HTML part that yields no text at all. We judged nothing, so we claim nothing.",
    patch: { subject: "", textBody: "", htmlBody: "<html><body><div></div></body></html>" },
    expect: "indeterminate", reason: "no_visible_text",
  },
  {
    id: "structural/over the scan cap",
    why: "A body larger than we are willing to scan. A short read must not be a clean bill.",
    patch: { subject: "Long", textBody: `${"the quick brown fox jumps over the lazy dog. ".repeat(4_000)}` },
    expect: "indeterminate", reason: "scan_truncated",
  },
  {
    id: "structural/alternatives describe different things",
    why: "Neither part matched, but they are not the same message — so we do not know which one "
      + "the user is reading.",
    patch: {
      textBody: "Invoice 2291 is attached for your records. Payment terms are thirty days from "
        + "the date shown. Bank details have not changed since the previous statement and remain "
        + "as printed on the reverse. Please contact accounts with any query about the totals.",
      htmlBody: "<p>Winter build field report: timber arrived Thursday, samples were laid out "
        + "against the north elevation, and the colour reading changed completely under overcast "
        + "light. Two of them are close enough to matter. Photographs follow next week once the "
        + "scaffold comes down and the render has cured properly.</p>",
      subject: "Atlas",
    },
    expect: "indeterminate", reason: "alternatives_disagree",
  },
];

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * THE PRECISION CLASS THE CORPUS ABOVE STRUCTURALLY CANNOT SEE
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Ordinary one-word subjects. Every one of these was withheld from AI until 2026-08-03, because
 * `TOKEN_ONLY`'s third alternative was `[A-Za-z0-9]{6,10}` and `subject` is a representation:
 * **25 of these 30 matched.**
 *
 * The reason the fixture table above never caught it is worth keeping: its own cases use digit
 * tokens, and the shared fixture subject is `"Atlas"` — five characters, coincidentally one below
 * the six-character floor. The corpus was blind by an accident of spelling.
 *
 * These are subjects a real mailbox contains, not adversarial input. `Hi` and `Hello` are here
 * deliberately as the below-floor controls that were always fine.
 */
export const ORDINARY_ONE_WORD_SUBJECTS = [
  "Question", "Invoice", "Reminder", "Welcome", "Receipt", "Hello", "Hi", "Update", "Meeting",
  "Payment", "Newsletter", "Confirmed", "Thanks", "Congrats", "Urgent", "Feedback", "Report",
  "Agenda", "Notes", "Booking", "Delivery", "Refund", "Interview", "Offer", "Contract",
  "Schedule", "Invite", "Survey", "Ticket", "Résumé",
] as const;

/**
 * Credential shapes that must STILL be withheld after the narrowing. Invariant #1 is the reason
 * this list exists as a peer of the one above: a precision fix is only acceptable if the positive
 * class is provably untouched, so both directions are asserted from one place.
 *
 * The first four reach `TOKEN_ONLY`'s digit-run alternative, the next two its split-digit
 * alternative, and the last three the MIXED alphanumeric alternative that replaced the
 * word-matching one.
 */
export const CREDENTIAL_SHAPES = [
  "123456", "8391", "000000", "12345678",
  "839 201", "839-201",
  "A" + "1B2C3", "8FJ2KD", "2FA9X1",
] as const;

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * NON-ASCII DIGITS. The five scripts NFKC does NOT fold, plus one it does.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * A six-digit code per script. `fullwidth` is included specifically to pin the half that NFKC
 * already handled — if someone later removes the digit fold, the five below go red and fullwidth
 * stays green, which localises the breakage instead of just reporting it.
 *
 * These are `indeterminate`/`credential_shape`, not `sensitive`: there is no vocabulary in a body
 * that is only a number, which is exactly why the shape rule has to be the thing that catches it.
 */
export const NON_ASCII_DIGIT_CODES: ReadonlyArray<readonly [script: string, code: string]> = [
  ["arabic-indic", "٠١٢٣٤٥"],
  ["ext-arabic-indic", "۰۱۲۳۴۵"],
  ["devanagari", "०१२३४५"],
  ["bengali", "০১২৩৪৫"],
  ["thai", "๐๑๒๓๔๕"],
  ["fullwidth (NFKC already folded this one)", "１２３４５６"],
];

/**
 * The framed variants, asserted `sensitive` rather than merely withheld — because VOCABULARY owns
 * these, not shape. Pinned so that a later "simplification" of the union cannot quietly demote a
 * positively-identified OTP into the fail-closed bucket and call it equivalent.
 */
export const FRAMED_NON_ASCII_CODES: ReadonlyArray<readonly [label: string, subject: string, body: string]> = [
  ["arabic vocabulary + arabic digits", "", "رمز التحقق ٠١٢٣٤٥"],
  ["english cue + fullwidth digits", "Your verification code", "Your code is １２３４５６"],
  ["english cue + arabic-indic digits", "Your verification code", "Your code is ٠١٢٣٤٥"],
];

/**
 * Strings the digit fold and the verdict must BOTH leave alone. This list is not decoration: a
 * back-walk implementation of the fold folded ASCII `9` to `0`, silently rewriting every message in
 * the system, and `€49.90` → `€40.00` is the only reason it was caught. A transform's test set must
 * contain inputs it is supposed to leave untouched.
 */
export const ORDINARY_NUMERIC_TEXT = [
  "€49.90", "2026-08-03", "+41 79 999 99 99", "v1.9.9", "99 problems", "Invoice 2291 attached",
] as const;

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * THE LANGUAGE-INDEPENDENT NUMERIC BACKSTOP + STORED REDACTION
 *
 * A verification pass reproduced these as REAL leaks against the live detector: each was
 * `verdict=ordinary`, `no_ai=false`, its code sent to the classifier and stored raw. The digit
 * backstop (`UNFRAMED_CODE`/`TOKEN_ONLY`) only fired on English framing or a token-only body, the
 * `unsupported_script` reason needs ≥4 non-Latin letters, and the language probe needs ≥12 words —
 * so a code framed in German, Polish, Dutch or Turkish prose fell straight through. German is the
 * product's home market.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

export interface LeakCase {
  id: string;
  subject: string;
  body: string;
  /** `sensitive` where new vocabulary owns it; `indeterminate` where only the shape backstop does. */
  expect: "sensitive" | "indeterminate";
}

/** The exact leak corpus the verification named. Every one MUST end `no_ai=true`. */
export const B24_LEAKS: LeakCase[] = [
  { id: "de/Einmalkennwort", subject: "Mitteilung", body: "Ihr Einmalkennwort lautet 771922.", expect: "indeterminate" },
  { id: "de/TAN", subject: "Freigabe", body: "Ihre TAN lautet 481920.", expect: "indeterminate" },
  { id: "de/Sicherheitsschlüssel", subject: "Info", body: "Ihr Sicherheitsschlüssel: 662311", expect: "indeterminate" },
  { id: "de/persönlicher Schlüssel", subject: "Info", body: "Guten Tag, Ihr persönlicher Schlüssel 553412 ist bereit.", expect: "indeterminate" },
  { id: "de/Code spaced 2-2-2", subject: "Info", body: "Ihr Code: 44 12 90", expect: "indeterminate" },
  { id: "pl/kod jednorazowy", subject: "Info", body: "Twój kod jednorazowy to 559214, wygaśnie za 10 minut.", expect: "indeterminate" },
  { id: "nl/toegangscode", subject: "Info", body: "Uw toegangscode is 220417, deel deze met niemand.", expect: "indeterminate" },
  { id: "tr/tek seferlik kod", subject: "Bilgi", body: "Giriş için tek seferlik kodunuz 903112.", expect: "indeterminate" },
  // The one leak with NO code — a sign-in alert. A numeric backstop structurally cannot catch it,
  // so it is owned by the Portuguese security-alert vocabulary added in the same slice.
  { id: "pt/sign-in alert (no code)", subject: "Alerta",
    body: "Detectámos um novo início de sessão na sua conta a partir de um dispositivo desconhecido. Se não foi você, proteja a sua conta.",
    expect: "sensitive" },
];

/**
 * The negatives the backstop must NOT touch — the precision half. Order numbers, invoice numbers,
 * prices, tracking numbers, ISO dates and a bare year in prose all carry a 4–8-digit run and must
 * stay `verdict=ordinary` with an empty reason set. `order code 4821` is the sharpest: it carries
 * the generic word "code" next to a 4-digit run, and is ordinary only because "code" is
 * commerce-qualified.
 */
export const B24_NEGATIVES: Array<readonly [id: string, subject: string, body: string]> = [
  ["order #", "Shipping", "Your order #482913 has shipped"],
  ["invoice + iso date", "Invoice", "Invoice 100245 due 2026-08-30"],
  ["price with decimal", "Total", "Total: 129.99"],
  ["tracking number", "Parcel", "Your tracking number is 1Z999AA10123456784."],
  ["iso date", "Notes", "Meeting scheduled for 2026-08-30 at noon."],
  ["four-digit year in prose", "Plans", "See you in 2026, looking forward to it."],
  ["commerce: order code 4821", "Re: your order", "your order code 4821 is ready for pickup"],
  ["commerce: booking reference", "Re: your order", "your booking reference is 84213"],
  ["commerce: invoice number", "Re: your order", "the invoice number is 22910"],
  ["promo code, no digit run", "Sale", "Use code SPRING20 at checkout."],
  ["area code, 3 digits", "Notice", "Our area code is now 044 — please update your records."],
  ["phone grouped, no cue", "Delivery", "Call 044 512 8890 if the slot slips."],
];

/**
 * More non-English / edge OTP shapes tried adversarially AFTER the fix. Every one must end
 * `no_ai=true` (sensitive OR indeterminate). Kept so a later narrowing of the cue set has to
 * account for them.
 */
export const B24_ADVERSARIAL: Array<readonly [id: string, subject: string, body: string]> = [
  ["cs/ověřovací kód", "Info", "Váš ověřovací kód je 553201."],
  ["hu/belépési kódja", "Info", "Az Ön belépési kódja 553201."],
  ["ro/cod de acces", "Info", "Codul dumneavoastră de acces este 553201."],
  ["de/dashed 3-3", "Info", "Ihr Code lautet 553-201."],
  ["de/code in a longer sentence", "Hallo", "Hallo Max, wie besprochen ist Ihr Kennwort 553201 ab sofort gültig, bitte notieren."],
  ["sv/lösenord", "Info", "Ditt lösenord är 553201 tills vidare."],
  ["fi/salasanasi (suffix)", "Info", "Kertakäyttöinen salasanasi on 553201."],
  ["nl/wachtwoord", "Info", "Uw wachtwoord is 553201, wijzig het direct."],
  ["cs/spaced 3-3 with accented cue", "Info", "Váš kód: 553 201"],
];
