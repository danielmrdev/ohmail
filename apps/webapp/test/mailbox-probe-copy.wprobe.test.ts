import { describe, it, expect } from "vitest";
import messages from "../messages/en.json";
import { ApiError } from "../app/api-client";
import { probeReasonOf, probeTlsOf, sameVanityParent } from "../app/(product)/mailbox/MailboxSection";

/**
 * **THE CONNECT FORM SAYS WHICH OF THE FOUR THINGS FAILED.**
 *
 * `POST /mailboxes` used to store whatever was typed and answer 201, so a mistyped host and an
 * Apple ID password where an app-specific one is required were the same event on this screen:
 * nothing. Both arrived minutes later as a sync error, and until that change that error said the
 * mailbox had rejected the password even when it was a connection problem.
 *
 * The route now refuses with `mailbox_probe_failed` and a `details.reason` drawn from the SAME
 * seven-value taxonomy the worker's classifier emits. This file holds the two halves of the pane's
 * side of that: the reason is only trusted when it is recognised, and every member of the closed
 * set has a sentence that is genuinely its own.
 */

const M = messages.mailboxes as unknown as Record<string, string>;

const probeError = (details: unknown): ApiError =>
  new ApiError(400, "mailbox_probe_failed", "server sentence", details);

describe("the connect form's failure copy", () => {
  it("reads the reason from a probe refusal", () => {
    expect(probeReasonOf(probeError({ reason: "auth" }))).toBe("auth");
    expect(probeReasonOf(probeError({ reason: "connect" }))).toBe("connect");
    expect(probeReasonOf(probeError({ reason: "tls" }))).toBe("tls");
    expect(probeReasonOf(probeError({ reason: "timeout" }))).toBe("timeout");
  });

  /**
   * FALLING BACK TO THE SERVER'S SENTENCE IS THE POINT, not a defensive shrug.
   *
   * A newer API that adds a taxonomy member would hand this pane a reason it has no key for, and
   * `t()` on a missing key renders the key PATH — the pane would print `mailboxes.probe_quota` at
   * somebody. Returning null instead means the caller uses `messageOf(err)`, which is the server's
   * own sentence about the actual failure and is therefore always true.
   */
  it("refuses to trust a reason it does not recognise, so the server's own words are used", () => {
    expect(probeReasonOf(probeError({ reason: "quota" }))).toBeNull();
    expect(probeReasonOf(probeError({ reason: 7 }))).toBeNull();
    expect(probeReasonOf(probeError(null))).toBeNull();
    expect(probeReasonOf(probeError({}))).toBeNull();
  });

  it("does not claim a probe reason for a different refusal", () => {
    // Everything else `POST /mailboxes` can answer with — the entitlement gate, the duplicate
    // index, an expired step-up — must keep its own copy path.
    expect(probeReasonOf(new ApiError(402, "no_subscription", "x", { reason: "auth" }))).toBeNull();
    expect(probeReasonOf(new ApiError(409, "mailbox_exists", "x"))).toBeNull();
    expect(probeReasonOf(new Error("boom"))).toBeNull();
    expect(probeReasonOf(null)).toBeNull();
  });

  it("every member of the closed taxonomy has a sentence", () => {
    for (const reason of ["auth", "connect", "tls", "timeout", "storage", "sync", "unknown"]) {
      expect(M[`probe_${reason}`], reason).toBeTruthy();
    }
  });

  /**
   * THE WHOLE POINT OF THE SLICE, AS AN ASSERTION. A mistyped host and a rejected password may
   * not produce the same words — that conflation is what the probe exists to end, and it is the one
   * an earlier change had to unpick one screen later.
   */
  it("the four causes a user can act on say four different things", () => {
    const four = ["auth", "connect", "tls", "timeout"].map((r) => M[`probe_${r}`]!);
    expect(new Set(four).size).toBe(4);
    // And each names its own cause rather than a shared shrug.
    expect(M.probe_auth!.toLowerCase()).toContain("password");
    expect(M.probe_connect!.toLowerCase()).toContain("reach");
    expect(M.probe_tls!.toLowerCase()).toContain("certificate");
    expect(M.probe_timeout!.toLowerCase()).toContain("time");
  });

  /**
   * `err_*` IS A SYNC FAILURE AND `probe_*` IS NOT, and neither may borrow the other's words.
   * Nothing has been stored when a probe fails: there is no mailbox, there was no sync, and
   * "Sync failed" would be a false sentence shipped by the deploy that removes one.
   */
  it("no probe sentence claims a sync happened", () => {
    for (const reason of ["auth", "connect", "tls", "timeout", "storage", "sync", "unknown"]) {
      expect(M[`probe_${reason}`]!.toLowerCase(), reason).not.toContain("sync");
    }
  });
});

/**
 * THE TLS REFUSAL IN DETAIL — `details.tls`, which turned one certificate sentence into a
 * taxonomy the user can act on, plus the two AFFORDANCES it can arm: the canonical-host
 * correction (the vanity-CNAME shape the first real external mailbox failed on) and the
 * plaintext opt-in for a server the probe proved has no TLS at all.
 */
describe("probeTlsOf — reading the detail, and only the detail", () => {
  it("parses a hostname mismatch with its suggestion, and knows which transport to blame", () => {
    expect(probeTlsOf(probeError({
      reason: "tls", transport: "smtp",
      tls: { kind: "hostname_mismatch", certHost: "mail.provider.example", expectedHost: "smtp.vanity.example", suggestedHost: "smtp.provider.business" },
    }))).toEqual({
      kind: "hostname_mismatch", transport: "smtp",
      certHost: "mail.provider.example", expectedHost: "smtp.vanity.example", suggestedHost: "smtp.provider.business",
    });
    // Transport defaults to imap — every pre-SMTP-probe server omits it.
    expect(probeTlsOf(probeError({ reason: "tls", tls: { kind: "tls_unavailable" } }))?.transport).toBe("imap");
  });

  it("refuses a kind it does not recognise, exactly as probeReasonOf refuses a reason", () => {
    expect(probeTlsOf(probeError({ reason: "tls", tls: { kind: "quantum" } }))).toBeNull();
    expect(probeTlsOf(probeError({ reason: "tls", tls: "hostname_mismatch" }))).toBeNull();
    expect(probeTlsOf(probeError({ reason: "tls" }))).toBeNull();
    expect(probeTlsOf(new ApiError(409, "mailbox_exists", "x", { tls: { kind: "expired" } }))).toBeNull();
  });

  it("every TLS kind with copy of its own has a sentence that keeps the no-password-sent guarantee", () => {
    for (const key of [
      "probe_tls_hostname", "probe_tls_hostname_suggest", "probe_tls_expired",
      "probe_tls_not_yet_valid", "probe_tls_self_signed", "probe_tls_untrusted", "probe_tls_unavailable",
    ]) {
      expect(M[key], key).toBeTruthy();
      expect(M[key]!.toLowerCase(), key).toContain("before sending the password");
    }
    // The two dynamic sentences really are parameterised — a hardcoded host pair here would be
    // a lie about somebody's actual server.
    expect(M.probe_tls_hostname).toContain("{certHost}");
    expect(M.probe_tls_hostname).toContain("{expectedHost}");
    expect(M.probe_tls_hostname_suggest).toContain("{suggestedHost}");
    expect(M.probe_tls_hostname_suggest).toContain("{protocol}");
    // And the consent affordance has its two lines, warning first-person plain.
    expect(M.useSuggestedHost).toContain("{host}");
    expect(M.insecureConsentLabel).toBeTruthy();
    expect(M.insecureConsentWarning!.toLowerCase()).toContain("unencrypted");
  });
});

describe("sameVanityParent — when one press may fix both host fields", () => {
  it("the vanity pair moves together; unrelated names do not", () => {
    expect(sameVanityParent("mail.vanity.example", "smtp.vanity.example")).toBe(true);
    expect(sameVanityParent("mail.example.com", "smtp.other.example")).toBe(false);
    // The trap the first-label rule exists for: a shared public suffix is NOT a shared parent.
    expect(sameVanityParent("mail.foo.co.uk", "smtp.bar.co.uk")).toBe(false);
    // A bare parent (nothing left after the first label) can never vouch for anything.
    expect(sameVanityParent("localhost", "localhost")).toBe(false);
    expect(sameVanityParent("", "")).toBe(false);
  });
});
