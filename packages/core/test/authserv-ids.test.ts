import { describe, it, expect } from "vitest";
import { providerAuthservIds } from "../src/authserv-ids.js";
import { NO_TRUSTED_AUTHSERV_IDS } from "../src/rules.js";
import { planChange } from "../src/pipeline.js";
import { FakeRepo } from "./fakes.js";
import type { Change } from "../src/ports.js";

/**
 * FORGED `From` MUST NOT INHERIT CONSENT ON A KNOWN-PROVIDER MAILBOX.
 *
 * `authVerdictFromHeaders` has been correct since that change, and it protected nothing: every
 * production site resolved `trustedAuthservIds` to the empty set, which short-circuits every
 * message to `"unavailable"`, so the demote-only branch could never fire and `evaluateRules`
 * decided purely on the CLAIMED `From`. `providerAuthservIds` is the population — IMAP host →
 * the provider's own authserv-id — and this file holds both halves of the claim:
 *
 *  · the resolver answers the right strings for the providers we name, and refuses to guess
 *    for everything else;
 *  · fed into `planChange`, the populated set actually screens a forged known-contact `From`
 *    that the empty set admits. The second half is asserted in BOTH directions on purpose —
 *    the admitting branch is the mutation (`NO_TRUSTED_AUTHSERV_IDS` back at a wiring site),
 *    written out here so the difference the wiring makes is a test, not an argument.
 */

describe("providerAuthservIds", () => {
  it("Gmail hosts resolve to Google's authserv-id", () => {
    expect([...providerAuthservIds("imap.gmail.com")]).toEqual(["mx.google.com"]);
    expect([...providerAuthservIds("imap.googlemail.com")]).toEqual(["mx.google.com"]);
  });

  it("Microsoft hosts resolve to Microsoft's authserv-id", () => {
    expect([...providerAuthservIds("outlook.office365.com")]).toEqual(["mx.microsoft.com"]);
    expect([...providerAuthservIds("imap-mail.outlook.com")]).toEqual(["mx.microsoft.com"]);
  });

  it("normalizes case, surrounding space and one trailing dot — an FQDN is one identity", () => {
    expect([...providerAuthservIds(" IMAP.Gmail.COM. ")]).toEqual(["mx.google.com"]);
  });

  it("REFUSES TO GUESS: unknown, empty and absent hosts all answer the empty set", () => {
    // The self-hosted tail. An invented trusted position for a server nobody vouches for would
    // believe headers a sender can type — `"unavailable"` (demote nothing) is the honest answer.
    expect(providerAuthservIds("mail.selfhosted.example").size).toBe(0);
    expect(providerAuthservIds("smtp.gmail.com").size).toBe(0); // an SMTP host is not an IMAP host
    expect(providerAuthservIds("")).toBe(NO_TRUSTED_AUTHSERV_IDS);
    expect(providerAuthservIds(null)).toBe(NO_TRUSTED_AUTHSERV_IDS);
    expect(providerAuthservIds(undefined)).toBe(NO_TRUSTED_AUTHSERV_IDS);
  });

  it("does not match on suffix — a sender-registered lookalike host resolves to nothing", () => {
    expect(providerAuthservIds("imap.gmail.com.attacker.example").size).toBe(0);
    expect(providerAuthservIds("ximap.gmail.com").size).toBe(0);
  });
});

/** A message claiming a KNOWN contact's address, carrying Gmail's own report that DMARC failed. */
function forgedFromKnownContact(): Change {
  const raw = Buffer.from([
    "Message-ID: <forged-1@attacker.example>",
    "From: friend@known.example",
    "To: mila@lichtgrat.example",
    // Gmail's own position, exactly as Gmail stamps it: authserv-id first, then the verdicts.
    "Authentication-Results: mx.google.com; dkim=fail header.d=known.example; dmarc=fail header.from=known.example",
    "Subject: hello again",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "It's me. Definitely me.",
  ].join("\r\n"));
  return { type: "create", locator: { folder: "INBOX", ref: "1:77" }, raw };
}

describe("the resolver's output, fed to planChange (the wiring, in both directions)", () => {
  async function desiredWith(trusted: ReadonlySet<string>): Promise<string | undefined> {
    const repo = new FakeRepo();
    repo.senders = new Set(["friend@known.example"]);
    const plan = await planChange(forgedFromKnownContact(), {
      repo, accountId: "acct-1", mailboxId: "mb-1", trustedAuthservIds: trusted,
    });
    return plan.new?.desired;
  }

  it("a Gmail-provider mailbox SCREENS a forged known-contact From whose DMARC failed", async () => {
    expect(await desiredWith(providerAuthservIds("imap.gmail.com"))).toBe("ohmail/Screener");
  });

  it("…and the EMPTY set admits the same forgery to the Ohbox — the exact pre-fix defect", async () => {
    // This is the mutation, kept green on purpose: wire any production site back to
    // `NO_TRUSTED_AUTHSERV_IDS` and this is the routing it gets. A stranger claiming a known
    // contact's address reaches the Ohbox with zero user action.
    expect(await desiredWith(NO_TRUSTED_AUTHSERV_IDS)).toBe("INBOX");
  });

  it("an unknown provider's mailbox routes exactly like the empty set — populated trust never widens", async () => {
    expect(await desiredWith(providerAuthservIds("mail.selfhosted.example"))).toBe("INBOX");
  });
});
