import { describe, it, expect } from "vitest";
import { redactForModel, screenOutboundText } from "../src/sensitive.js";

/**
 * THE ACTIVATION PATH FOR THE SHORT-ENCODING PASSES — the case they were written for, and the one
 * case they could not run in.
 *
 * `sensitive.short-code.test.ts` covers what `redactShortEncodedRuns` REMOVES. This file covers
 * whether it ever gets to. `redactForModel` opens with
 *
 *     const screen = screenOutboundText(subject, snippet);
 *     if (screen.safe) return { subject, snippet, redacted: false };
 *
 * so every pass in the redactor is downstream of the screen's verdict. The screen asked three
 * questions — vocabulary on the plain text, vocabulary on whatever `decodeEmbedded` could decode,
 * credential SHAPE on the plain text — and `decodeEmbedded` matches base64 only from sixteen
 * characters up, plus quoted-printable. Short base64, percent escapes and numeric entities, the
 * three forms `redactShortEncodedRuns` exists for, were matched by nothing in the screen.
 *
 * The consequence is the shape the short-code file already names once and did not close: the
 * passes could tidy a payload that was going to be redacted anyway, and could do nothing about a
 * GENERICALLY FRAMED message whose only sensitive content is the encoded run. `Fwd: see below`
 * with a body that decodes to a live code screened `safe`, and the unredacted text went to the
 * model. Two additions close it — credential shape on decoded representations, and a
 * `hasShortEncodedCredential` arm sharing the redactor's own patterns.
 *
 * WATCHED RED, each restored:
 *  · deleting the `hasShortEncodedCredential` arm from the screen → all four generic-framing
 *    cases fail, each returning `redacted: false` with the code still in the text;
 *  · the false-positive block below fails if the arm over-fires, which is the reason it is here:
 *    an over-eager screen redacts ordinary commerce mail and the product stops working.
 *
 * ── WHAT THIS DOES NOT CLOSE, STATED SO NOBODY READS IT AS CLOSED ────────────────────────────
 *
 * A BARE CODE WITH NO FRAMING, in a form something upstream has already decoded, still screens
 * `safe`. `=34=38=32=39=31=33` is the shortest demonstration: quoted-printable is decoded by
 * `decodeEmbedded`, the result is `482913`, and `credentialShapeIn` does not fire on a bare
 * numeric run — deliberately, because an order number and a one-time code are the same six
 * digits, and the false-positive block below is what that costs if it changes.
 *
 * A `credentialShapeIn` call on decoded representations was written for exactly this and then
 * REMOVED, because it changed no outcome on any payload that could be constructed for it: with
 * and without the branch, every probe returned the identical verdict. A branch whose comment says
 * a hole is closed while the hole stays open is worse than the hole, so what stands here is the
 * arm that was measured to bite, and this paragraph is the rest of the finding.
 */
describe("screenOutboundText activates the short-encoding passes on generic framing", () => {
  // A generic subject with NO authentication vocabulary anywhere. Vocabulary is what fired the
  // screen before, so every case here has to be carried by the encoded run alone.
  const GENERIC = "Fwd: see below";

  it("short base64 below decodeEmbedded's floor: `NDgyOTEz` is `482913`", () => {
    const snippet = "here you go: NDgyOTEz thanks";
    expect(screenOutboundText(GENERIC, snippet).safe,
      "the screen must fail, or the redactor never runs").toBe(false);
    const out = redactForModel(GENERIC, snippet);
    expect(out.redacted).toBe(true);
    expect(out.snippet).not.toContain("NDgyOTEz");
    expect(out.snippet).toContain("[REDACTED]");
  });

  it("percent escapes: `%34%38%32%39%31%33` is `482913`", () => {
    const snippet = "ref %34%38%32%39%31%33 ok";
    expect(screenOutboundText(GENERIC, snippet).safe).toBe(false);
    const out = redactForModel(GENERIC, snippet);
    expect(out.redacted).toBe(true);
    expect(out.snippet).not.toContain("%34%38%32%39%31%33");
  });

  it("numeric HTML entities: `&#52;&#56;&#50;&#57;&#49;&#51;` is `482913`", () => {
    const snippet = "see &#52;&#56;&#50;&#57;&#49;&#51; below";
    expect(screenOutboundText(GENERIC, snippet).safe).toBe(false);
    const out = redactForModel(GENERIC, snippet);
    expect(out.redacted).toBe(true);
    expect(out.snippet).not.toContain("&#52;&#56;&#50;&#57;&#49;&#51;");
  });

  it("the code in the SUBJECT is caught too — both fields are screened as one payload", () => {
    const out = redactForModel("Fwd: NDgyOTEz", "no context at all");
    expect(out.redacted).toBe(true);
    expect(out.subject).not.toContain("NDgyOTEz");
  });

  /**
   * The other half, and the one that makes the first half worth having. A screen that fails
   * everything redacts everything, and the product's whole job on this path is to let a model
   * read ordinary mail. Each of these carries a run that LOOKS encoded and decodes to nothing a
   * credential could be — or does not decode at all.
   */
  describe("and does not fire on ordinary mail", () => {
    for (const [name, subject, snippet] of [
      ["an order number", "Your order has shipped", "Order 4829134 is on its way"],
      ["a tracking code", "Delivery update", "Tracking: 1Z999AA10123456784"],
      ["a URL with a path", "Newsletter", "Read more at https://example.com/posts/2026/august"],
      ["a percent sign in prose", "Sale", "Everything is 30% off until Friday, 20% on sale items"],
      ["an ampersand entity", "Terms", "Fish &amp; chips &amp; more &amp; more"],
      ["a plain sentence", "Hello", "Just checking in about the meeting on Thursday"],
    ] as const) {
      it(name, () => {
        const out = redactForModel(subject, snippet);
        expect(out.redacted, `${name} must reach the model unchanged`).toBe(false);
        expect(out.subject).toBe(subject);
        expect(out.snippet).toBe(snippet);
      });
    }
  });
});
