import { describe, it, expect } from "vitest";
import { normalizeMime, countRealFiles, isRealFile, invitationWithoutEvent, itipReplyByHeaders } from "../src/mime.js";
import { isCalendarMime, CALENDAR_FALLBACK_FILENAME } from "../src/ics.js";

/**
 * ═══ A MEETING INVITATION'S CALENDAR PART IS A FILE THE READER CAN DOWNLOAD ═════════════════
 *
 * The wire shape every calendar producer sends: the invite rides as a `text/calendar` MIME part
 * with NO Content-Disposition and usually NO filename — Outlook and Google both nest it as the
 * third child of `multipart/alternative`, beside the text and html renditions of the same
 * invitation. It is not "content the body already shows" (the html is prose about the meeting,
 * the ics is the machine-readable event), so it must surface exactly as a named attachment
 * does: listed, paperclip-counted, downloadable.
 *
 * This holds TODAY because mailparser's `textTypes` is exactly `['text/plain','text/html']`
 * (mail-parser.js:164) and anything else becomes an attachment node whatever its disposition
 * says (:618-624). That is a fact about a dependency's internals, not a term of our contract —
 * which is precisely why this guard exists: a mailparser upgrade that starts treating
 * `text/calendar` as body text would silently erase every meeting invite from the attachment
 * strip, and nothing else in this repo would notice. Verified against the live corpus
 * (2026-08-14): 646 stored `text/calendar` parts, 305 of them nameless, all `inline = false`,
 * every carrying message `has_attachments = true`.
 */

/** Outlook/Google wire shape: the invite as an UNNAMED, UNDISPOSED text/calendar alternative. */
const MEETING_EML = [
  "Message-ID: <Meeting-77@Example.com>",
  "From: Tobias Example <tobias@example.com>",
  "To: mila@lichtgrat.example",
  "Subject: Neue vorgeschlagene Zeit: STUDIO KICKOFF",
  'Content-Type: multipart/alternative; boundary="ALT"',
  "",
  "--ALT",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Tobias schlägt eine neue Zeit vor.",
  "",
  "--ALT",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Tobias schlägt eine neue Zeit vor.</p>",
  "",
  "--ALT",
  'Content-Type: text/calendar; charset="utf-8"; method=COUNTER',
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from(
    [
      "BEGIN:VCALENDAR",
      "METHOD:COUNTER",
      "BEGIN:VEVENT",
      "SUMMARY:STUDIO KICKOFF",
      "DTSTART:20260819T120000Z",
      "DTEND:20260819T130000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"),
  ).toString("base64"),
  "",
  "--ALT--",
  "",
].join("\r\n");

/** The other calendar shape: a real named .ics with an explicit attachment disposition. */
const NAMED_ICS_EML = [
  "Message-ID: <Reply-12@Example.com>",
  "From: Mila <mila@example.com>",
  "To: mila@lichtgrat.example",
  "Subject: Event accepted: Sync",
  'Content-Type: multipart/mixed; boundary="MIX"',
  "",
  "--MIX",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Accepted.",
  "",
  "--MIX",
  'Content-Type: text/calendar; charset="utf-8"; method=REPLY',
  'Content-Disposition: attachment; filename="iCal-Reply.ics"',
  "",
  "BEGIN:VCALENDAR",
  "METHOD:REPLY",
  "BEGIN:VEVENT",
  "DTSTART:20260713T120000Z",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
  "--MIX--",
  "",
].join("\r\n");

describe("the undisposed text/calendar alternative part (the Outlook/Google invite shape)", () => {
  it("is listed as a downloadable attachment and counts toward the paperclip", async () => {
    const msg = await normalizeMime(MEETING_EML);
    const calendar = msg.attachments.filter((a) => isCalendarMime(a.contentType));
    expect(calendar).toHaveLength(1);
    const part = calendar[0]!;
    // No disposition and no name on the wire — and still a real file, never an inline part.
    expect(part.filename).toBeNull();
    expect(part.inline).toBe(false);
    expect(isRealFile(part)).toBe(true);
    expect(part.partId).not.toBeNull(); // the IMAP locator the on-demand byte fetch needs
    expect(msg.hasAttachments).toBe(true);
    expect(countRealFiles(msg.attachments)).toBe(1);
  });

  it("keeps the text and html renditions as the body, not as attachments", async () => {
    const msg = await normalizeMime(MEETING_EML);
    expect(msg.textBody).toContain("neue Zeit");
    expect(msg.htmlBody).toContain("<p>");
    expect(msg.attachments).toHaveLength(1);
  });
});

describe("the named, disposed .ics (the Apple/Gmail reply shape)", () => {
  it("is unchanged by the calendar handling: named, listed, counted", async () => {
    const msg = await normalizeMime(NAMED_ICS_EML);
    const calendar = msg.attachments.filter((a) => isCalendarMime(a.contentType));
    expect(calendar).toHaveLength(1);
    expect(calendar[0]!.filename).toBe("iCal-Reply.ics");
    expect(calendar[0]!.inline).toBe(false);
    expect(msg.hasAttachments).toBe(true);
  });
});

describe("the nameless-part fallback name", () => {
  it("is the shared constant both the engine strip and the server naming read", () => {
    // The VALUE is the contract: engine `toAttachmentItem` and the server's `uniqueName`
    // both fall back to it for a nameless calendar part, so the tile, the download and a
    // zip entry all name one file. Each writer has its own guard; this pins the word itself.
    expect(CALENDAR_FALLBACK_FILENAME).toBe("invite.ics");
  });
});

/**
 * The Outlook Web Access shape the 2026-09-16 incident turned on: the sender's mail system sent
 * the event as a LINK, so there is no calendar part at all and the body is OWA's boilerplate
 * about the invitation. Single-part `text/html`, `X-MS-Has-Attach` present and EMPTY, and
 * `Content-class` the one positive signal that this is a meeting message.
 */
const OWA_LINK_INVITE_EML = [
  "Message-ID: <OWA-1@Example.com>",
  "From: A Colleague <colleague@example.com>",
  "To: mila@lichtgrat.example",
  "Subject: Austausch \"Single Source of Truth\"",
  "Content-class: urn:content-classes:calendarmessage",
  "X-MS-Has-Attach: ",
  'Content-Type: text/html; charset="utf-8"',
  "",
  "<p>Microsoft Outlook Web Access: <a href=\"https://example.com/owa/x\">open</a></p>",
  "",
].join("\r\n");

/** RFC 6047's single-part iTIP shape: the whole message IS the calendar object. */
const TOP_LEVEL_REPLY_EML = [
  "Message-ID: <Top-1@Example.com>",
  "From: Mila <mila@example.com>",
  "To: colleague@example.com",
  "Subject: Accepted: Austausch",
  'Content-Type: text/calendar; charset="utf-8"; method=REPLY',
  "",
  "BEGIN:VCALENDAR",
  "METHOD:REPLY",
  "BEGIN:VEVENT",
  "DTSTART:20260916T100000Z",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

describe("invitationWithoutEvent — an invitation we cannot show says so", () => {
  it("is TRUE for the OWA link invitation: it declares itself calendar mail and carries no part", async () => {
    const msg = await normalizeMime(OWA_LINK_INVITE_EML);
    // The premise, asserted rather than assumed — this fixture really has no calendar part.
    expect(msg.attachments).toHaveLength(0);
    expect(msg.headers["content-class"]).toEqual(["urn:content-classes:calendarmessage"]);
    expect(invitationWithoutEvent(msg)).toBe(true);
  });

  it("is FALSE for MEETING_EML — the card renders, so there is nothing to say", async () => {
    const msg = await normalizeMime(MEETING_EML);
    // The positive control on the other arm: this message HAS the part the card is built from.
    expect(msg.attachments.filter((a) => isCalendarMime(a.contentType))).toHaveLength(1);
    expect(invitationWithoutEvent(msg)).toBe(false);
  });

  it("is FALSE for ordinary mail that makes no calendar claim", async () => {
    const plain = [
      "Message-ID: <Plain-1@Example.com>",
      "From: A <a@example.com>",
      "To: mila@lichtgrat.example",
      "Subject: lunch",
      'Content-Type: text/html; charset="utf-8"',
      "",
      "<p>Thursday?</p>",
      "",
    ].join("\r\n");
    expect(invitationWithoutEvent(await normalizeMime(plain))).toBe(false);
  });
});

describe("itipReplyByHeaders — the stored facts that say REPLY", () => {
  it("is TRUE for a top-level Content-Type carrying method=REPLY", async () => {
    expect(itipReplyByHeaders(await normalizeMime(TOP_LEVEL_REPLY_EML))).toBe(true);
  });

  it("is FALSE for a REQUEST, which is an invitation and not an acknowledgement", async () => {
    const msg = await normalizeMime(TOP_LEVEL_REPLY_EML.replace(/method=REPLY/, "method=REQUEST"));
    expect(itipReplyByHeaders(msg)).toBe(false);
  });

  /**
   * ITIP-METHOD-HAS-NO-STORED-HOME, closed. `NAMED_ICS_EML` IS an iTIP reply whose method lives on
   * its calendar PART; the part's stored type now keeps it (`text/calendar; method=REPLY`), so the
   * stored facts answer where only the subject arm could before.
   */
  it("is TRUE for a multipart reply whose method is on the PART, and the part keeps it", async () => {
    const msg = await normalizeMime(NAMED_ICS_EML);
    const cal = msg.attachments.filter((a) => isCalendarMime(a.contentType));
    expect(cal.map((a) => a.contentType)).toEqual(["text/calendar; method=REPLY"]);
    expect(itipReplyByHeaders(msg)).toBe(true);
  });

  it("CONTROL: the same reply as a REQUEST on the part is not an acknowledgement", async () => {
    const msg = await normalizeMime(NAMED_ICS_EML.replace(/method=REPLY/i, "method=REQUEST"));
    expect(itipReplyByHeaders(msg)).toBe(false);
  });

  it("a method that is not a token is not kept, and a non-calendar part never gains one", async () => {
    const odd = await normalizeMime(NAMED_ICS_EML.replace(/method=REPLY/i, 'method="RE PLY;x"'));
    expect(odd.attachments.filter((a) => isCalendarMime(a.contentType)).map((a) => a.contentType)).toEqual(["text/calendar"]);
  });
});
