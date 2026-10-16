import { describe, it, expect } from "vitest";
import {
  redactForModel, redactSensitiveText, screenOutboundText, classifySensitivity,
} from "../src/sensitive.js";
import {
  SCREENING_PREFIX, SensitivePayloadRefusal, buildScreeningParams, classifyUserPayload,
} from "../src/ai/classify.js";
import type { ClassifierInput } from "../src/classifier-port.js";

/**
 * **AI-OPEN — the ruling of 2026-08-08, as guards.**
 *
 * The "Sensitive mail" invariant, amended: *"there is not one single [message] for AI to not read justified… scan
 * everything and remove the exceptions; if someone wants to use ai, they can, if not, they
 * won't."* What is withheld from a model is the credential VALUE; the subject matter is not.
 *
 * Three properties have to hold together, and each is satisfiable alone by a defect — which is
 * why they are pinned as a set:
 *
 *  1. A credential-bearing payload REACHES the model on a user-requested path (the ruling).
 *  2. The credential VALUE is not in it (the redaction).
 *  3. An ordinary payload is byte-identical to what it was before any of this existed (the
 *     anti-vacuity half, and the one that protects the rest of the Screener).
 *
 * Every test here has been mutated and watched red. Where the mutation is not obvious the test
 * says which one.
 */

const CLIENT = { messages: { async create() { return { content: "{}" }; } } };

function input(subject: string, snippet: string, extra: Partial<ClassifierInput> = {}): ClassifierInput {
  return { from: { name: null, address: "x@y.invalid" }, subject, snippet, headersDigest: "", ...extra };
}

describe("redactForModel — the value goes, the subject matter stays", () => {
  it("blanks a framed one-time code out of BOTH fields, and keeps the words", () => {
    const out = redactForModel("Your sign-in code", "Use 482913 to sign in.");
    expect(out.redacted).toBe(true);
    expect(`${out.subject}\n${out.snippet}`).not.toContain("482913");
    expect(out.snippet).toContain("[REDACTED]");
    // The half the ruling is about: that this message CONCERNS signing in is not a secret, and
    // it is exactly what the user paid the model to notice. A redaction that took the words too
    // would leave the model guessing from an address.
    expect(out.subject).toContain("sign-in code");
    expect(out.snippet).toContain("to sign in");
  });

  it("blanks the token tail of an authentication URL", () => {
    // The class that was 107 of the reporting account's 163 hard stayers.
    const out = redactForModel("Atlas", "https://accounts.example.com/session?t=SECRET-LOGIN-TOKEN");
    expect(out.redacted).toBe(true);
    expect(out.snippet).not.toContain("SECRET-LOGIN-TOKEN");
    expect(out.snippet).toContain("[REDACTED]");
  });

  it("blanks a reset link hidden behind an ESP CLICK-TRACKER — the hole the live scan found", () => {
    // MEASURED on the live account, 2026-08-08, before this shipped: a password-reset mail whose
    // link was `http://url4821.mailer.test/ls/click?upn=<base64 of the real URL>`. `/ls/click` is
    // not an authentication marker and `upn` is not an authentication parameter, so
    // `redactAuthUrls` missed it entirely and the magic link would have gone to the model intact.
    // It did not matter under the old policy because the whole message was withheld on the words
    // "Reset password"; opening that path is what made the wrapper load-bearing.
    //
    // MUTATION: drop `redactUrlTails` from `redactForModel` ⇒ red on the first assertion.
    const out = redactForModel(
      "Reset password",
      "Let's get your password reset: http://url4821.mailer.test/ls/click?upn=u001.HI0QrxI9QRZx-1Y4w2XAOHGskq1fCQrAabE9gbRCxGzPnFZrZufQeITjkKEnhj0",
    );
    expect(out.snippet).not.toContain("HI0QrxI9QRZx");
    expect(out.snippet).toContain("[REDACTED]");
    // THE HOST SURVIVES. It is the single most useful routing signal in the payload and it is not
    // a secret; blanking it would protect nothing and make the suggestion worse.
    expect(out.snippet).toContain("url4821.mailer.test");
    expect(out.subject).toBe("Reset password");
  });

  it("the model path may redact MORE than storage, never less", () => {
    // The asymmetry stated as a property. `classifySensitivity`'s output is pinned by a corpus and
    // is what a person reads in their own client, so the click-tracker widening is deliberately
    // confined to the model path. This pins the DIRECTION: whatever storage blanks, the model path
    // blanks too.
    const body = "Reset: http://t.example.com/ls/click?upn=AbCdEf0123456789XyZ and code 482913";
    const stored = redactSensitiveText(body);
    const sent = redactForModel("Reset your password", body).snippet;
    expect(stored).not.toContain("482913");
    expect(sent).not.toContain("482913");
    // …and the model path went further on the wrapped token.
    expect(stored).toContain("AbCdEf0123456789XyZ");
    expect(sent).not.toContain("AbCdEf0123456789XyZ");
  });

  it("LEAVES ORDINARY MAIL ALONE — byte-identical, and this is the load-bearing half", () => {
    // `CODE` matches `[A-Z0-9]{6,10}` and any 4-8 digit run, so an UNCONDITIONAL redaction would
    // blank `NEWSLETTER`, `WELCOME`, every order number and every year range in the Screener —
    // degrading every suggestion in the product to protect the few senders that carry a
    // credential. The condition is `screenOutboundText`, per payload.
    //
    // MUTATION: make `redactForModel` redact unconditionally ⇒ this goes red on the first
    // assertion while every other test in this file stays green. That asymmetry is the point.
    const cases: Array<[string, string]> = [
      ["Order 4429117 shipped", "Your parcel left the depot on Tuesday."],
      ["NEWSLETTER — issue 42", "Read on: https://example.invalid/issues/42"],
      ["Invoice 2026-0814", "Total CHF 1290.00, due 30 days."],
      ["Re: Slot doppelt gebucht", "Kannst du dir das kurz anschauen?"],
    ];
    for (const [subject, snippet] of cases) {
      const out = redactForModel(subject, snippet);
      expect(out.redacted, `${subject} was needlessly redacted`).toBe(false);
      expect(out.subject).toBe(subject);
      expect(out.snippet).toBe(snippet);
    }
  });

  it("redaction is the MODEL gate ONLY — the stored body is never redacted", () => {
    // The ruling once turned on stored-body == model-payload (one representation, not two). Body
    // redaction AT REST is now removed: `classifySensitivity` produces no redacted body at all —
    // the reader sees their own code in full — and the ONLY place a credential is stripped is
    // `redactForModel`, on the way to a model.
    const body = "Your verification code is 482913. It expires in 10 minutes.";
    const stored = classifySensitivity({
      from: { name: null, address: "x@y.invalid" },
      subject: "Your verification code", textBody: body, htmlBody: null, headers: {},
    } as never);
    expect(stored.sensitive).toBe(true);
    expect(stored.flags.no_ai).toBe(true);
    // The result carries no redacted-body field any more — storage is not a redaction site.
    expect("redactedTextBody" in stored).toBe(false);
    expect("storeRedactedBody" in stored).toBe(false);
    // The model payload is still stripped, by the surviving transform.
    const forModel = redactForModel("Your verification code", body);
    expect(forModel.redacted).toBe(true);
    expect(forModel.snippet).not.toContain("482913");
    expect(forModel.snippet).toBe(redactSensitiveText(body));
  });

  it("does NOT report a residue, because there is no residual refusal to feed", () => {
    // Redaction removes values; the detector also fires on authentication VOCABULARY, which
    // redaction cannot remove because words are not values. A "did it come out clean" gate would
    // therefore refuse every password reset and every "verify your email" — the exception the
    // ruling removed, under a new name. This pins that the surviving screen is NOT consulted.
    const out = redactForModel("Reset your password", "Follow the link to reset your password.");
    expect(out.redacted).toBe(true);
    // Still unsafe after redaction — the words are the match — and still sendable.
    expect(screenOutboundText(out.subject, out.snippet).safe).toBe(false);
    expect(Object.keys(out).sort()).toEqual(["redacted", "snippet", "subject"]);
  });
});

describe("redactForModel — the ENCODED credential goes too, not only the plain one", () => {
  /**
   * `screenOutboundText` DECODES embedded base64/quoted-printable before judging — that is how a
   * credential inside a forwarded raw part gets the payload flagged at all. Before the encoded
   * pass, the redactor rewrote only the ORIGINAL bytes: `CODE`'s `\b` finds no boundary inside a
   * contiguous mixed-case base64 run, so the payload left `redacted: true` while carrying the
   * intact encoded credential — one trivial decode away from the plaintext the gate withholds.
   * The subject is stored RAW, so a blob there reached the model even more directly.
   *
   * Every test asserts BOTH forms absent — the encoded run AND its decoded credential string —
   * because either alone is satisfiable by a defect: keeping the blob satisfies the decoded
   * assertion (the digits never appear in the raw bytes), and echoing the decode satisfies the
   * encoded one.
   */
  const PLAIN = "Your one-time passcode is 482913. Do not share it.";
  const BLOB = Buffer.from(PLAIN, "utf8").toString("base64");

  it("premise: the embedded-base64 payload IS flagged — the detection this redaction leans on", () => {
    // If this goes red the tests below are vacuous: `redactForModel` only rewrites what the
    // screen flags, so a payload the screen stopped seeing would pass byte-identical.
    const screen = screenOutboundText("Fwd: see below", `Content-Transfer-Encoding: base64\n\n${BLOB}`);
    expect(screen.safe).toBe(false);
  });

  it("a base64-embedded passcode: NEITHER the blob NOR its decode reaches the payload", () => {
    // MUTATION: drop `redactEncodedRuns` from `clean` ⇒ red on the blob assertion — the blob
    // sails through `redactSensitiveText` untouched, exactly the defect this pins.
    const out = redactForModel("Fwd: see below", `Content-Transfer-Encoding: base64\n\n${BLOB}`);
    expect(out.redacted).toBe(true);
    const sent = `${out.subject}\n${out.snippet}`;
    expect(sent).not.toContain(BLOB);
    expect(sent).not.toContain("482913");
    // Categorical: no run of `decodeEmbedded`'s size survives at all, so there is nothing left
    // for any model to decode — not this blob, and not a fragment of it either.
    expect(sent).not.toMatch(/[A-Za-z0-9+/]{16,}/);
    // The words around the blob survive — the value goes, the subject matter stays.
    expect(out.subject).toContain("Fwd: see below");
  });

  it("the blob in the SUBJECT — the field stored raw — is blanked the same way", () => {
    const out = redactForModel(`Fwd: ${BLOB}`, "forwarding this to you");
    expect(out.redacted).toBe(true);
    const sent = `${out.subject}\n${out.snippet}`;
    expect(sent).not.toContain(BLOB);
    expect(sent).not.toContain("482913");
  });

  it("a QP-encoded passcode — the digits themselves as hex escapes — is blanked", () => {
    // `=34=38=32=39=31=33` decodes to `482913`. No digit appears in the raw bytes, so `CODE`
    // has nothing to match; the decoder is what flags it, and the encoded pass is what strips it.
    // MUTATION: drop the `QP_HEX_RUN` replace ⇒ red on the first assertion.
    const out = redactForModel(
      "Your verification code",
      "Content-Transfer-Encoding: quoted-printable\n\nYour code is =34=38=32=39=31=33, enter it now.",
    );
    const sent = `${out.subject}\n${out.snippet}`;
    expect(sent).not.toContain("=34=38");
    expect(sent).not.toContain("482913");
    expect(out.snippet).toContain("[REDACTED]");
    expect(out.snippet).toContain("enter it now");
  });

  it("a code split across a QP soft line break is made contiguous before the pattern reads it", () => {
    // `482=\n913` is two fragments, each below `CODE`'s four-digit floor; unfolded it is
    // `482913`, which `CODE` blanks whole.
    // MUTATION: drop the soft-break unfold from `clean` ⇒ red — `482` survives as a fragment.
    const out = redactForModel("Your sign-in code", "Use code 482=\n913 to sign in.");
    expect(out.snippet).not.toContain("482");
    expect(out.snippet).not.toMatch(/\d{2,}/);
    expect(out.snippet).toContain("to sign in");
  });

  it("ordinary mail with a long machine token is untouched — the encoded pass sits INSIDE the condition", () => {
    // A tracking-number-shaped run would be eaten by `B64_RUN` if the pass ran unconditionally.
    // The condition is `screenOutboundText`, per payload, same as every other redaction here.
    const subject = "Order shipped";
    const snippet = "Track it: parcel TN4829105573824617 arrives Tuesday.";
    expect(screenOutboundText(subject, snippet).safe).toBe(true);
    const out = redactForModel(subject, snippet);
    expect(out.redacted).toBe(false);
    expect(out.subject).toBe(subject);
    expect(out.snippet).toBe(snippet);
  });
});

describe("the outbound sink — absent means refuse, and that polarity is the guard", () => {
  it("an input with NO `outbound` field is refused, exactly as before the ruling", () => {
    // The automatic routing path never sets the field. It must stay refused, and the thousands of
    // tests in packages that do not typecheck their tests must keep exercising THIS branch.
    expect(() => classifyUserPayload(input("Your verification code", "Code 482913")))
      .toThrow(SensitivePayloadRefusal);
  });

  it("`outbound: \"refuse\"` written explicitly is refused too", () => {
    expect(() => classifyUserPayload(input("Your verification code", "Code 482913", { outbound: "refuse" })))
      .toThrow(SensitivePayloadRefusal);
  });

  it("`outbound: \"prescreened\"` is served — the caller redacted and said so", () => {
    const safe = redactForModel("Your sign-in code", "Use 482913 to sign in.");
    const payload = classifyUserPayload(input(safe.subject, safe.snippet, { outbound: "prescreened" }));
    expect(payload.subject).toContain("sign-in code");
    expect(`${payload.subject}\n${payload.snippet}`).not.toContain("482913");
  });

  it("`prescreened` is not a licence to send the RAW value — the caller is what redacts", () => {
    // Stated so nobody reads the flag as "sensitivity off". It is a declaration about work
    // already done; if a caller lies, the raw text goes out, which is why the flag lives beside
    // `redactForModel` at exactly one call site (`ScreenerService.suggest`) and why the guard
    // that matters is the one in `screener-ai.test.ts` asserting what the PORT received.
    const payload = classifyUserPayload(input("Your sign-in code", "Use 482913 to sign in.", { outbound: "prescreened" }));
    expect(payload.snippet).toContain("482913");
  });

  it("the screening request builder honours the same flag", () => {
    const safe = redactForModel("Your sign-in code", "Use 482913 to sign in.");
    expect(() => buildScreeningParams(input(safe.subject, safe.snippet), { client: CLIENT as never }))
      .toThrow(SensitivePayloadRefusal);
    const params = buildScreeningParams(
      input(safe.subject, safe.snippet, { outbound: "prescreened" }), { client: CLIENT as never },
    ) as { messages: Array<{ content: string }> };
    expect(params.messages[0]!.content).not.toContain("482913");
    expect(params.messages[0]!.content).toContain("sign-in code");
  });
});

describe("the screening question — the Ohbox bar raised in a report", () => {
  /**
   * These are CRITERIA assertions, not copy assertions, and the distinction is why each one names
   * a mechanism rather than a sentence. The prompt is prose and will be reworded; what may not
   * change without a decision is that it still tells the model these four things.
   *
   * Each was written against a measured failure on a live account, listed with it.
   */
  it("states that automated service mail is never the Ohbox, consequence or not", () => {
    // MEASURED: of the senders the model filed to INBOX, several were automated notifications, and the
    // rationales cited the old clause by name — "a service notification with a consequence if
    // ignored". An expired card and a nearly-full storage warning both landed at high confidence.
    expect(SCREENING_PREFIX).toMatch(/AUTOMATED SERVICE MAIL IS NEVER THE OHBOX/);
    // …and the specific reasoning that has to be blocked, not just the headline.
    expect(SCREENING_PREFIX).toMatch(/consequence/i);
    expect(SCREENING_PREFIX).toMatch(/who WROTE it/);
    // The old clause itself must be gone. This is the half a reword could silently restore.
    expect(SCREENING_PREFIX).not.toMatch(/service mail they personally have to\s*\n?\s*act on/);
  });

  it("names Reads as where automated notifications go, including the urgent-sounding ones", () => {
    // Without a stated home, "not INBOX" has five candidates and the model picks by tone.
    expect(SCREENING_PREFIX).toMatch(/ohmail\/News:[\s\S]*automated notification/);
    expect(SCREENING_PREFIX).toMatch(/urgent-sounding/);
  });

  it("allows Quarantine for bulk commercial mail nobody asked for, on a RELATIONSHIP test", () => {
    // The old text forbade it outright ("Being automated, promotional or unwanted is NOT
    // enough"), which is why a product newsletter arriving at an address that never subscribed
    // could never be called what it is. The prohibition is replaced by a test rather than
    // removed, because removing it is how every newsletter became spam the first time.
    expect(SCREENING_PREFIX).not.toMatch(/is NOT enough/);
    expect(SCREENING_PREFIX).toMatch(/the RELATIONSHIP/);
    expect(SCREENING_PREFIX).toMatch(/bulk, commercial, and unrequested/);
  });

  it("files a venue's own promotions to Screened rather than Reads", () => {
    // A hotel or restaurant mailing a past guest reads as service mail because the sender is a
    // place the person has been. It is a business selling to someone who is not its customer.
    expect(SCREENING_PREFIX).toMatch(/venue, hotel, restaurant or shop mailing its own promotions/);
    expect(SCREENING_PREFIX).toMatch(/being somewhere once is not a subscription/i);
  });
});

describe("the Screened/Quarantine boundary — the relationship ruling of 2026-08-08", () => {
  /**
   * CRITERIA assertions again, for the boundary the ruling moved. Each names the mechanism the
   * prompt must still carry, and each was written against a measured live answer — the rationale
   * the model actually returned is quoted with it.
   */
  it("gates Screened on a REAL PRIOR RELATIONSHIP rather than on the mail being legitimate", () => {
    // MEASURED: cold BD outreach came back `ohmail/Screened` 0.95 — "it's legitimate business
    // mail, just unwanted" — and a travel site's promo blast came back `ohmail/Screened` 0.95 as
    // "bulk commercial marketing you didn't request". Both were ruled spam.
    expect(SCREENING_PREFIX).toMatch(/ohmail\/Screened: unwanted mail from a business/);
    expect(SCREENING_PREFIX).toMatch(/REAL PRIOR RELATIONSHIP/);
    expect(SCREENING_PREFIX).toMatch(/customer, guest, client or member of/);
    // The contradicting clause must be GONE from the Screened bullet. It named the exact mail the
    // ruling moves, imperatively, while Quarantine claimed it only conditionally — and a model
    // resolving that contradiction takes the imperative branch.
    expect(SCREENING_PREFIX).not.toMatch(/cold sales approaches, unrequested promotions/);
  });

  it("sends UNSOLICITED COMMERCIAL mail to Quarantine, and says legitimacy does not rescue it", () => {
    // This is the sentence that overturns the rationale above. Without it the model has no reason
    // to stop treating "a real company wrote it" as a reason to spare the mail.
    expect(SCREENING_PREFIX).toMatch(/UNSOLICITED COMMERCIAL MAIL/);
    expect(SCREENING_PREFIX).toMatch(/cold sales or\s*\n?\s*business-development outreach from a stranger/);
    expect(SCREENING_PREFIX).toMatch(/real, registered,\s*\n?\s*reputable business does not rescue it/);
    expect(SCREENING_PREFIX).toMatch(/legitimacy is not permission/);
    // Quarantine states the outcome, it does not merely permit it. "Quarantine is available" is
    // what let the imperative Screened clause win.
    expect(SCREENING_PREFIX).not.toMatch(/Quarantine is available/);
  });

  it("makes the relationship provable FROM THE MESSAGE, which is all the model is given", () => {
    // The screening turn carries from/subject/snippet and an empty headersDigest, with no
    // few-shot: "has this person ever booked with them" is unanswerable. So the criterion is
    // evidence in the mail — the discriminator between a hotel writing to a named guest
    // (Screened) and a travel site's generic blast (Quarantine), both plausibly places the
    // person has spent money.
    expect(SCREENING_PREFIX).toMatch(/VISIBLE IN THIS MESSAGE/);
    expect(SCREENING_PREFIX).toMatch(/addresses them by name as a known customer or guest/);
    // …and the same operationalisation on Quarantine's side, which is otherwise equally
    // unanswerable and would rescue the blast.
    expect(SCREENING_PREFIX).toMatch(/shown by this message naming their own account/);
  });

  it("does not spend Receipts' own vocabulary on the two junk bullets", () => {
    // "Order", "booking" and "payment" are the words the RECEIPTS bullet is built from — "order
    // confirmations, invoices, payment and shipping notices, statements, booking
    // confirmations". The first draft of the relationship evidence spent three of them on the
    // two junk bullets ("names a stay, an order, a booking or an account of theirs";
    // "naming their account, their order or their subscription"), which is hygiene worth
    // keeping: bullets in a single block compete for the same words.
    //
    // **It is NOT a fix for the receipt regression, and saying so would be a false claim.**
    // A Google Cloud payment confirmation moved from ohmail/Receipts 0.99 to ohmail/News 0.98
    // when this calibration landed, and removing the vocabulary collision did not move it back —
    // measured over four live runs. The model's own rationale points somewhere else entirely
    // ("it's not from a person, so it belongs in Reads per your own Ohbox rule"), i.e. at the
    // automated-mail rule, not at these bullets. The deviation is reported rather than tuned
    // around; see the docblock in `classify-prompt.ts`.
    const junkBullets = SCREENING_PREFIX.slice(
      SCREENING_PREFIX.indexOf("- ohmail/Screened:"),
      SCREENING_PREFIX.indexOf("Set \"spam\" true"),
    );
    expect(junkBullets).not.toMatch(/\bbooking\b/i);
    // The NOUN, not the "in order to sell" adverbial the same bullet needs — a bare /\border\b/
    // fires on that and would make this guard unmaintainable rather than strict.
    expect(junkBullets).not.toMatch(/\b(?:an|their|the)\s+orders?\b/i);
    expect(junkBullets).not.toMatch(/\bpayment\b/i);
  });

  it("qualifies the personal-stranger clause by PURPOSE instead of deleting it", () => {
    // Deleting it re-opens a measured failure: a tightening of this bullet once pulled a real
    // person out of the Ohbox at 0.72 for lacking a relationship, taking the set 17/18 → 15/18.
    expect(SCREENING_PREFIX).toMatch(/personally about anything other\s*\n?\s*than selling is not junk/);
    expect(SCREENING_PREFIX).toMatch(/IN ORDER TO\s*\n?\s*SELL is/);
  });

  it("keeps RELATIONSHIP language out of the INBOX criteria", () => {
    // The failure mode this prevents: let the word escape into the person-to-person bullet and
    // the model starts demanding a relationship of PEOPLE, gutting "whether or not they have
    // met". Asserted structurally — the INBOX bullet is the text before the Reads bullet.
    const inboxBullet = SCREENING_PREFIX.slice(
      SCREENING_PREFIX.indexOf("- INBOX:"),
      SCREENING_PREFIX.indexOf("- ohmail/News:"),
    );
    expect(inboxBullet).toMatch(/whether or not they have met/);
    expect(inboxBullet).not.toMatch(/relationship/i);
  });

  it("memorises no sender — the criteria generalise, and the cache is shared besides", () => {
    // The two senders the ruling came from are on ONE account, and this constant is sent with
    // `cache_control:{type:"ephemeral"}` across all of them. Naming them here would be both
    // example-memorisation and one account's data on another account's request.
    expect(SCREENING_PREFIX).not.toMatch(/easemytrip|orbitprism|amrai|giants-software/i);
  });

  it("still carries NO account's words — the prefix is cached across accounts", () => {
    // The invariant the calibration must not break: this constant is sent with
    // `cache_control:{type:"ephemeral"}` and that cache is shared, so one account's bar embedded
    // here would be served on another's request. The instruction may name the field; never its
    // value.
    expect(SCREENING_PREFIX).toMatch(/If the user turn carries an "ohboxBar" field/);
    expect(SCREENING_PREFIX).not.toMatch(/Keep my Ohbox/);
    expect(SCREENING_PREFIX).not.toMatch(/mila|trafficflow/i);
  });
});
