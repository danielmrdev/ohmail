import { describe, expect, it } from "vitest";
import * as barrel from "../src/index.js";
import { forwardSubject, replySubject } from "../src/mutations.js";

/**
 * ═══ THE FORWARD SUBJECT, AND THE BARREL THAT HAS TO CARRY IT ═════════════════════════
 *
 * Two separate things are guarded here, and the second one is the reason this file exists at all.
 *
 * ── 1. THE PREFIX ───────────────────────────────────────────────────────────────────────────
 *
 * `SendService` builds the outgoing message with `subject: d.subject` — the draft row's subject,
 * verbatim, with no prefix of its own. So the client is authoritative for the `Fwd:` and a forward
 * whose subject was left bare goes out looking like a fresh message. Same normalisation rule as
 * `replySubject`: case-insensitive, leading run collapsed to one, `Fw:` and `Fwd:` both stripped
 * because both are in wide use and both mean the same thing.
 *
 * ── 2. THE BARREL ──────────────────────────────────────────────────────────────────────────
 *
 * `apps/webapp` imports from `@ohmail/client-engine`, which resolves to `src/index.ts` and NOT to
 * the module a symbol is declared in. A type or function that exists in `types.ts`/`mutations.ts`
 * but is absent from that barrel does not exist as far as every consumer is concerned — which is
 * exactly how the compose surface shipped importing `ComposeAttachment` from a barrel that never
 * named it, in a state where the package's own tests were all green because they import from
 * `../src/*.js` directly. So these assertions read the BARREL, deliberately, and would not catch
 * anything if they imported the source modules the way the rest of this suite does.
 */
describe("forwardSubject — Fwd: exactly once", () => {
  it("prefixes a bare subject", () => {
    expect(forwardSubject("Invoice 4417")).toBe("Fwd: Invoice 4417");
  });

  it("collapses an existing prefix rather than stacking a second one", () => {
    expect(forwardSubject("Fwd: Invoice 4417")).toBe("Fwd: Invoice 4417");
    expect(forwardSubject("Fwd: Fwd: Invoice 4417")).toBe("Fwd: Invoice 4417");
  });

  it("is case-insensitive and accepts the `Fw:` form other clients write", () => {
    // The chain that motivates this: our Fwd: → an Outlook FW: → back to us. A case-sensitive
    // strip yields `Fwd: FW: Invoice`, which is what the second exchange looks like without it.
    expect(forwardSubject("FWD: Invoice 4417")).toBe("Fwd: Invoice 4417");
    expect(forwardSubject("Fw: Invoice 4417")).toBe("Fwd: Invoice 4417");
    expect(forwardSubject("FW: fwd:  Invoice 4417")).toBe("Fwd: Invoice 4417");
  });

  it("leaves a subject that merely CONTAINS the prefix alone", () => {
    expect(forwardSubject("Re: the fw: convention")).toBe("Fwd: Re: the fw: convention");
  });

  it("degrades to a bare prefix on an empty subject, exactly as replySubject does", () => {
    expect(forwardSubject("")).toBe("Fwd:");
    expect(forwardSubject("   ")).toBe("Fwd:");
    expect(replySubject("")).toBe("Re:");
  });

  it("does not touch a Re: prefix — a forward of a reply keeps the reply's subject", () => {
    // The two prefixes are independent: forwarding an answer is a forward OF "Re: x", not a
    // rewrite of it, and stripping the Re: would misreport what the recipient is being shown.
    expect(forwardSubject("Re: Invoice 4417")).toBe("Fwd: Re: Invoice 4417");
  });
});

describe("the barrel names what the compose surface imports from it", () => {
  it("exports forwardSubject and sentOverlayMessage as values", () => {
    expect(typeof barrel.forwardSubject).toBe("function");
    // the overlay builder. Exported for the same reason: it is the one place the provisional Sent
    // row's shape is decided, and a second implementation in a shell would drift from the
    // reconcile-by-`messageIdHeader` that retires it.
    expect(typeof barrel.sentOverlayMessage).toBe("function");
  });

  it("the barrel's forwardSubject IS the implementation, not a re-declaration", () => {
    expect(barrel.forwardSubject).toBe(forwardSubject);
  });

  /**
   * `ComposeAttachment` is a TYPE, so there is nothing to assert at runtime — a type-only export
   * leaves no trace in the compiled module. Its guard is the type annotation below, which fails
   * `tsc` if the barrel stops naming it. It bites in `apps/webapp` rather than here, because
   * `apps/webapp`'s tsconfig includes every `.ts` under the app and therefore typechecks its own
   * tests, while this package's tsconfig includes `src` only — see `compose-forward.test.ts` for
   * the live guard.
   */
  it("documents where the ComposeAttachment guard lives", () => {
    expect(Object.keys(barrel)).toContain("forwardSubject");
  });
});
