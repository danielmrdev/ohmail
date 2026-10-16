import { describe, it, expect } from "vitest";
import { planChange, commitChange, UNMETERED_STORAGE_CAP } from "../src/pipeline.js";
import { normalizeMime } from "../src/mime.js";
import { FakeRepo, FakeAdapter } from "./fakes.js";
import type { Change, PipelineDeps } from "../src/ports.js";
import { providerAuthservIds } from "../src/authserv-ids.js";

/**
 * ═══ A BOUNCE FOR AN AWAY REPLY IS THE RESPONDER'S BUSINESS, NOT THE READER'S ══════════════
 *
 * ── THE FAILURE, MEASURED ────────────────────────────────────────────────────────────────
 *
 * A responder answered a correspondent; that address refuses mail; the delivery report came
 * back. `pipeline.ts`'s bounce arm corroborated it as this account's own — correctly, we did
 * send the thing that bounced — and filed it INBOX, where it read as a person's mail. The
 * reader has nothing to do with it: the responder already records the dead address on
 * `away_sender_state.undeliverable_at` and writes to it no more. So the one bounce the product
 * handles by itself is the one bounce it put in front of somebody.
 *
 * ── WHY THE DISCRIMINATOR IS THE MINTED ID AND NOT THE MARKER HEADER ─────────────────────
 *
 * A DSN quotes the failed message's headers, so `Auto-Submitted: auto-replied` is readable
 * straight out of the report — and it is a string the sender of the report writes. Routing on
 * it would let a stranger move their own mail out of `ohmail/Screener` and into a real pile,
 * which is a consent-gate bypass in the narrowing direction rather than the widening one, and
 * a bypass either way. The minted `<uuid@domain>` on `away_replies` is a value THIS account
 * generated and stored; a stranger cannot make one exist. Same join as
 * `markUndeliverableFromBounces`, deliberately: two encodings of "is this our away reply"
 * would disagree the first time one of them was touched.
 */

const CORRESPONDENT = "correspondent@elsewhere.example";
/** The id the away pass minted for the reply it sent, recorded on the ledger before it dialled. */
const MINTED = "<away-9f3b2c1d@lichtgrat.example>";
/** An ordinary message the PERSON sent, whose bounce must keep reaching them. */
const HAND_SENT = "<sent-42@lichtgrat.example>";

function bounce(opts: { quotes?: string; failed?: string } = {}): Buffer {
  const { quotes, failed } = opts;
  return Buffer.from([
    "Message-ID: <dsn-1@their-host.example>",
    "From: MAILER-DAEMON@their-host.example",
    "To: reader@lichtgrat.example",
    "Subject: Undelivered Mail Returned to Sender",
    ...(failed ? [`X-Failed-Recipients: ${failed}`] : []),
    'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "This is the mail system at their-host.example.",
    "Your message could not be delivered.",
    "",
    "--b1",
    "Content-Type: message/rfc822-headers",
    "",
    ...(quotes ? [`Message-ID: ${quotes}`] : []),
    "From: reader@lichtgrat.example",
    "Auto-Submitted: auto-replied",
    "Subject: Away from mail",
    "",
    "--b1--",
  ].join("\r\n"));
}

/** A message in the mirror carrying `id`, as the Sent copy of something this account sent. */
function sentCopy(id: string): Buffer {
  return Buffer.from([
    `Message-ID: ${id}`,
    "From: reader@lichtgrat.example",
    `To: ${CORRESPONDENT}`,
    "Subject: Away from mail",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "I am away until the 20th.",
  ].join("\r\n"));
}

function makeDeps(): PipelineDeps & { repo: FakeRepo; adapter: FakeAdapter } {
  return { repo: new FakeRepo(), adapter: new FakeAdapter(), accountId: "acct-1", mailboxId: "mb-1" };
}

const createChange = (folder: string, raw: Buffer, ref = "1:10"): Change =>
  ({ type: "create", locator: { folder, ref }, raw });

async function desiredFolderOf(
  raw: Buffer, d: ReturnType<typeof makeDeps>, ref = "1:11", trustedAuthservIds?: ReadonlySet<string>,
): Promise<string> {
  const plan = await planChange(createChange("INBOX", raw, ref), {
    repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, readerMode: false,
    ...(trustedAuthservIds ? { trustedAuthservIds } : {}),
  });
  const res = await commitChange(plan, {
    storageCap: UNMETERED_STORAGE_CAP,
    repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId,
  });
  return (await d.repo.getFolderState(res.messageId))!.desiredFolder;
}

/** A Sent copy as the server serves one: with its arrival, after the consent point. */
async function seedSent(d: ReturnType<typeof makeDeps>, id: string, ref: string): Promise<void> {
  const plan = await planChange(
    {
      type: "create", locator: { folder: "Sent", ref }, raw: sentCopy(id), ownAuthored: true,
      internalDate: new Date("2026-09-22T15:12:00.000Z"),
    },
    { repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, readerMode: false },
  );
  await commitChange(plan, {
    repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, storageCap: UNMETERED_STORAGE_CAP,
  });
}

describe("a delivery report for one of this account's own away replies", () => {
  it("is filed to ohmail/Receipts, out of the Ohbox, because the responder handles it", async () => {
    const d = makeDeps();
    d.repo.senders.add(CORRESPONDENT);
    await seedSent(d, MINTED, "2:1");
    d.repo.awayReplyMintedIds.add(MINTED.slice(1, -1).toLowerCase());

    expect(await desiredFolderOf(bounce({ quotes: MINTED, failed: CORRESPONDENT }), d))
      .toBe("ohmail/Receipts");
  });

  it("written by Exchange Online on a Microsoft mailbox, it still files to Receipts and records the dead address", async () => {
    // Microsoft writes the report under its own name ("Microsoft Outlook"): the mailbox's own
    // provider, so its brand in the name is the provider's report and not a claim.
    const d = makeDeps();
    const minted = MINTED.slice(1, -1).toLowerCase();
    d.repo.awayReplyMintedIds.add(minted);
    d.repo.awayReplySenderOf.set(minted, CORRESPONDENT);
    d.repo.awaySenders.add(CORRESPONDENT);
    const exchange = 'From: "Microsoft Outlook" <MicrosoftExchange5e1f0c2a9b8d4e7f8a6b3c2d1e0f9a8b@lichtgrat.example>';
    const raw = Buffer.from(bounce({ quotes: MINTED }).toString().replace("From: MAILER-DAEMON@their-host.example", exchange));
    expect(raw.toString(), "the fixture carries Microsoft's sender").toContain(exchange);
    expect(await desiredFolderOf(raw, d, "1:12", providerAuthservIds("outlook.office365.com"))).toBe("ohmail/Receipts");
    expect(d.repo.awayUndeliverable.has(CORRESPONDENT), "the responder stops writing to that address").toBe(true);
  });

  /** The away reply's report as another sender writes it, the ledger and the responder's row set. */
  const fromOf = (from: string, extra: string[] = []): Buffer =>
    Buffer.from(bounce({ quotes: MINTED }).toString()
      .replace("From: MAILER-DAEMON@their-host.example", [`From: ${from}`, ...extra].join("\r\n")));
  const ledgered = (): ReturnType<typeof makeDeps> => {
    const d = makeDeps();
    const minted = MINTED.slice(1, -1).toLowerCase();
    d.repo.awayReplyMintedIds.add(minted);
    d.repo.awayReplySenderOf.set(minted, CORRESPONDENT);
    d.repo.awaySenders.add(CORRESPONDENT);
    return d;
  };
  const TENANT = '"Microsoft Outlook" <MicrosoftExchange5e1f0c2a9b8d4e7f8a6b3c2d1e0f9a8b@lichtgrat.example>';
  const MICROSOFT = providerAuthservIds("outlook.office365.com");

  it("written by the organisation's own Exchange with no provider named, it files to Receipts and records the dead address", async () => {
    // The domain the reply was minted under is the mailbox address's (`mintMessageId`): the account's own.
    const d = ledgered();
    expect(await desiredFolderOf(fromOf(TENANT), d, "1:13")).toBe("ohmail/Receipts");
    expect(d.repo.awayUndeliverable.has(CORRESPONDENT)).toBe(true);
  });

  it("CONTROL: on a Microsoft mailbox, the report under ANOTHER brand's name is held and records nothing", async () => {
    const d = ledgered();
    const raw = fromOf('"PayPal" <service@paypal-notice.invalid>');
    expect(await desiredFolderOf(raw, d, "1:14", MICROSOFT)).toBe("ohmail/Screener");
    expect(d.repo.awayUndeliverable.has(CORRESPONDENT)).toBe(false);
  });

  it("CONTROL: on a Microsoft mailbox, the report that FAILED authentication is held and records nothing", async () => {
    const d = ledgered();
    const raw = fromOf(TENANT, ["Authentication-Results: mx.microsoft.com; dmarc=fail header.from=lichtgrat.example"]);
    expect(await desiredFolderOf(raw, d, "1:15", MICROSOFT)).toBe("ohmail/Screener");
    expect(d.repo.awayUndeliverable.has(CORRESPONDENT)).toBe(false);
  });

  it("under another company's name at the domain the reply was minted under, it keeps its fact and waits", async () => {
    const d = ledgered();
    const plan = await planChange(createChange("INBOX", fromOf('"PayPal" <service@lichtgrat.example>'), "1:17"), {
      repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, readerMode: false,
    });
    expect(plan.new?.senderCheck?.brand, "the Not PayPal warning stays").toBe("PayPal");
    const res = await commitChange(plan, {
      storageCap: UNMETERED_STORAGE_CAP, repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId,
    });
    expect((await d.repo.getFolderState(res.messageId))!.desiredFolder).toBe("ohmail/Screener");
    expect(d.repo.awayUndeliverable.has(CORRESPONDENT)).toBe(false);
  });

  it("CONTROL: an id the report cites at its own domain is no evidence of ours unless the ledger holds it", async () => {
    // Our minted id is cited, and so is one at the report's domain: that domain is still a stranger's.
    const d = ledgered();
    const raw = Buffer.from(fromOf('"Microsoft Outlook" <postmaster@evil.invalid>').toString()
      .replace("Auto-Submitted: auto-replied", "Auto-Submitted: auto-replied\r\nReferences: <x-1@evil.invalid>"));
    expect(raw.toString()).toContain("<x-1@evil.invalid>");
    expect(await desiredFolderOf(raw, d, "1:16")).toBe("ohmail/Screener");
    expect(d.repo.awayUndeliverable.has(CORRESPONDENT)).toBe(false);
  });

  it("no longer reaches the Ohbox even when the failed recipient is a known correspondent", async () => {
    const d = makeDeps();
    d.repo.senders.add(CORRESPONDENT);
    d.repo.awayReplyMintedIds.add(MINTED.slice(1, -1).toLowerCase());

    // No Sent copy at all, and `X-Failed-Recipients` naming a contact corroborates nothing any
    // more (a header the report's sender writes): the away arm alone decides, and it files away.
    expect(await desiredFolderOf(bounce({ quotes: MINTED, failed: CORRESPONDENT }), d))
      .not.toBe("INBOX");
  });
});

describe("every other delivery report keeps the behaviour it has today", () => {
  it("a bounce of mail the PERSON sent still reaches the Ohbox", async () => {
    const d = makeDeps();
    await seedSent(d, HAND_SENT, "2:2");

    // Nothing on the away ledger names this id, so the arm above must not fire.
    expect(await desiredFolderOf(bounce({ quotes: HAND_SENT }), d)).toBe("INBOX");
  });

  it("a report quoting a STRANGER's message still waits at the gate", async () => {
    const d = makeDeps();

    expect(await desiredFolderOf(bounce({ quotes: "<spammer-1@elsewhere.example>" }), d))
      .toBe("ohmail/Screener");
  });

  it("a QUARANTINED daemon stays quarantined — the user's decision outranks this arm", async () => {
    const d = makeDeps();
    d.repo.senders.add(CORRESPONDENT);
    d.repo.awayReplyMintedIds.add(MINTED.slice(1, -1).toLowerCase());
    d.repo.rules.push({
      id: "deny-1", kind: "sender", match: "mailer-daemon@their-host.example",
      destination: "ohmail/Quarantine", effect: "deny", priority: 100,
      provenance: "manual", enabled: true, subjectContains: null, bodyContains: null,
    });

    expect(
      await desiredFolderOf(bounce({ quotes: MINTED, failed: CORRESPONDENT }), d),
      "an explicit user denial was overridden by the away-bounce arm",
    ).toBe("ohmail/Quarantine");
  });

  it("the away marker in the quoted headers is NOT on its own enough to move mail", async () => {
    const d = makeDeps();

    // Same report, same `Auto-Submitted: auto-replied` in the quoted part, and no minted id on
    // this account's ledger. A stranger writes those bytes; they must buy nothing.
    expect(await desiredFolderOf(bounce({ quotes: MINTED, failed: "stranger@elsewhere.example" }), d))
      .toBe("ohmail/Screener");
  });
});

describe("the report is DSN-shaped in the first place", () => {
  it("normalises with the delivery-status content type the arm keys on", async () => {
    const msg = await normalizeMime(bounce({ quotes: MINTED }));
    expect((msg.headers["content-type"] ?? []).join(" ")).toContain("report-type=delivery-status");
  });
});
