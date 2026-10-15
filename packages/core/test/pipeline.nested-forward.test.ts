import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, messages, messageBodies, attachments as attachmentsTable } from "@trafficflow/db";
import { planChange, commitChange, UNMETERED_STORAGE_CAP } from "../src/pipeline.js";
import { carryDialect } from "@trafficflow/db/dialect";
import { makeDrizzleRepo } from "../src/adapters/drizzle-repo.js";

/**
 * THE APPLE-MAIL NESTED FORWARD, PINNED THROUGH THE REAL STORE (owner report, 2026-08-21).
 *
 * A real message — a German forward with a PDF flyer — was reported unopenable on the desktop
 * while webmail rendered it. The investigation cleared the parse and the store (the reporter's
 * local mirror held it byte-for-byte), but the diagnosis surfaced how little of this SHAPE the
 * suite pinned end to end: the pipeline tests drive `FakeRepo`, and the one store both desktop
 * doors actually write is Drizzle-on-PGlite. This test is the structural repro, kept as a
 * guard: the same MIME features as the reported message, synthetic content, through
 * `planChange`/`commitChange` into the real schema, read back through the same tables the
 * local API serves.
 *
 * The features, each one a thing some parser or store has historically mangled:
 *   · `multipart/alternative` whose SECOND alternative is `multipart/mixed` — text at part 1,
 *     html at 2.1, a large base64 PDF at 2.2, a trailing us-ascii html doc at 2.3
 *     (Apple Mail's forward-with-attachment shape, so the stored html is TWO whole `<html>`
 *     documents concatenated with `<br/>`);
 *   · an RFC 2047 utf-8 subject FOLDED MID-WORD across two encoded words;
 *   · quoted-printable ISO umlauts in text and html, and Apple's U+FFFC object-replacement
 *     character closing the text part;
 *   · a `References` header naming a remailer id (threading joins the original's conversation);
 *   · `bodyHash`/snippet/attachment metadata all derived, none of it tripping the 256 KiB html
 *     cap or the storage counter.
 */

const CRLF = "\r\n";
const ALT = "Apple-Mail=_1A2B3C4D-0000-4445-8DBC-4B8A2627F4E6";
const MIX = "Apple-Mail=_9F8E7D6C-1111-4E68-8ACA-231BD04E343D";

function qp(s: string): string {
  const bytes = Buffer.from(s, "utf8");
  let out = "";
  let lineLen = 0;
  for (const b of bytes) {
    let tok: string;
    if (b === 0x0a) { out += CRLF; lineLen = 0; continue; }
    if (b === 0x0d) continue;
    if ((b >= 33 && b <= 126 && b !== 61) || b === 32 || b === 9) tok = String.fromCharCode(b);
    else tok = "=" + b.toString(16).toUpperCase().padStart(2, "0");
    if (lineLen + tok.length > 72) { out += "=" + CRLF; lineLen = 0; }
    out += tok; lineLen += tok.length;
  }
  return out;
}

function buildNestedForward(): Buffer {
  const textBody = [
    "Lieber Tester", "",
    "wenn ihr noch etwas Programm sucht………….", "",
    "herzliche Grüsse und bis bald, wanda", "",
    "> Anfang der weitergeleiteten Nachricht:",
    "> Von: Berta Beispiel <berta@example-gmx.test>",
    "> Betreff: Erinnerung und Ansage fürs Zürifäscht 2026",
    "> Liebe Freunde, hier eine Erinnerung für das Festival in Musterstadt.",
    "\u{FFFC}",
  ].join("\n");

  const html1 = `<html><head><meta http-equiv="content-type" content="text/html; charset=utf-8"></head><body>Lieber Tester<div>wenn ihr noch etwas Programm sucht………….</div><blockquote type="cite"><div>Betreff: <b>Erinnerung und Ansage fürs Zürifäscht 2026</b></div><div>${"lorem ipsum dolor sit amet ".repeat(120)}</div></blockquote></body></html>`;
  const html2 = `<html><head><meta http-equiv="content-type" content="text/html; charset=us-ascii"></head><body><div><blockquote type="cite"><div></div></blockquote><br></div></body></html>`;

  // Megabytes of deterministic pseudo-PDF bytes — the reported attachment's size class.
  const pdfSize = 2_181_311;
  const pdf = Buffer.alloc(pdfSize);
  pdf.write("%PDF-1.4\n", 0, "latin1");
  let seed = 0x12345678;
  for (let i = 10; i < pdfSize; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    pdf[i] = seed & 0xff;
  }
  const pdfB64 = pdf.toString("base64").replace(/(.{76})/g, `$1${CRLF}`);

  return Buffer.from([
    `From: w-test <w-test@example-blue.test>`,
    `Message-Id: <${"F"}418D7BF-2A12-4E68-8ACA-231BD04AAAAA@example-blue.test>`,
    `Content-Type: multipart/alternative;`,
    `\tboundary="${ALT}"`,
    `Mime-Version: 1.0 (Mac OS X Mail 16.0 \\(3731.700.6.1.21\\))`,
    // The FOLDED encoded-word subject, split mid-word exactly as Apple Mail folds it.
    `Subject: =?utf-8?Q?Fwd=3A_Erinnerung_und_Ansage_f\x3dC3\x3dBCrs_Z\x3dC3\x3dBCrif\x3dC3\x3dA4scht_?=`,
    ` =?utf-8?Q?2026?=`,
    `Date: Tue, 18 Aug 2026 23:33:53 +0200`,
    `References: <trinity-a0004c55-a1d3-4e6f-9b23-000000000000-1787036031534@trinity-msg-rest-gmx-gmx-live-b98598d44-pvwdj>`,
    `To: Reader Person <reader@example.test>`,
    ``,
    ``,
    `--${ALT}`,
    `Content-Transfer-Encoding: quoted-printable`,
    `Content-Type: text/plain;`,
    `\tcharset=utf-8`,
    ``,
    qp(textBody),
    `--${ALT}`,
    `Content-Type: multipart/mixed;`,
    `\tboundary="${MIX}"`,
    ``,
    ``,
    `--${MIX}`,
    `Content-Transfer-Encoding: quoted-printable`,
    `Content-Type: text/html;`,
    `\tcharset=utf-8`,
    ``,
    qp(html1),
    `--${MIX}`,
    `Content-Disposition: attachment;`,
    `\tfilename=Test_Flyer_A5_Musterfest.pdf`,
    `Content-Type: application/pdf;`,
    `\tname="Test_Flyer_A5_Musterfest.pdf"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    pdfB64,
    `--${MIX}`,
    `Content-Transfer-Encoding: 7bit`,
    `Content-Type: text/html;`,
    `\tcharset=us-ascii`,
    ``,
    html2,
    ``,
    `--${MIX}--`,
    ``,
    `--${ALT}--`,
  ].join(CRLF));
}

describe("the nested Apple-Mail forward lands whole in the real store", () => {
  it("ingests through plan/commit on PGlite and reads back complete", async () => {
    const acct = "00000000-0000-0000-0000-00000000f00d";
    const db = await makeTestDb();
    const [mb] = await db.insert(mailboxes).values({
      accountId: acct, provider: "imap", address: "reader@example.test",
    }).returning();
    const repo = makeDrizzleRepo(db as never);

    const raw = buildNestedForward();
    const change = { type: "create" as const, locator: { folder: "INBOX", ref: "1485948999:22128" }, raw };
    const plan = await planChange(change, { repo, accountId: acct, mailboxId: mb!.id });
    const res = await (db as never as { transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> })
      .transaction(async (tx) => commitChange(plan, {
        storageCap: UNMETERED_STORAGE_CAP,
        // Carried: the driver's transaction object has no dialect brand of its own, and the thread
        // merge inside commit composes a locking statement through the seam.
        repo: makeDrizzleRepo(carryDialect(db, tx as object) as never), accountId: acct, mailboxId: mb!.id,
      }));
    expect(res.outcome).toBe("new");

    const [m] = await db.select().from(messages).where(eq(messages.accountId, acct));
    // The folded encoded words decode into ONE subject — no lost half, no stray space inside
    // the word the fold split.
    expect(m!.subject).toBe("Fwd: Erinnerung und Ansage fürs Zürifäscht 2026");
    expect(m!.fromName).toBe("w-test");
    // The snippet derives from the TEXT alternative, umlauts intact, and never the html.
    expect(m!.snippet).toContain("Lieber Tester");
    expect(m!.snippet).toContain("sucht………");
    // Never the html alternative: the text part is the snippet's source, so markup would mean
    // the derivation switched parts. (A literal `<` alone is legitimate — the quoted forward's
    // own `<address>` brackets live in the text.)
    expect(m!.snippet).not.toContain("<html");
    expect(m!.snippet).not.toContain("<div");
    // One real file: the PDF at part 2.2. The two html parts are BODY, not attachments.
    expect(m!.hasAttachments).toBe(true);
    expect(m!.attachmentCount).toBe(1);

    const [b] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, m!.id));
    // The text alternative, whole, closed by Apple's object-replacement character.
    expect(b!.text).toContain("Anfang der weitergeleiteten Nachricht");
    expect(b!.text.trimEnd().endsWith("\u{FFFC}")).toBe(true);
    // BOTH html parts of the mixed alternative are stored — the Apple forward's body is two
    // whole documents, and dropping the second would truncate the quoted original's close.
    expect((b!.html!.match(/<html/g) ?? []).length).toBe(2);
    expect(b!.html!).toContain("Zürifäscht");
    // Under the 256 KiB cap: the PDF's megabytes are parts, never body bytes (`keepCidLinks`).
    expect(Buffer.byteLength(b!.html!, "utf8")).toBeLessThan(262_144);

    const atts = await db.select().from(attachmentsTable).where(eq(attachmentsTable.messageId, m!.id));
    expect(atts).toHaveLength(1);
    expect(atts[0]).toMatchObject({
      filename: "Test_Flyer_A5_Musterfest.pdf",
      contentType: "application/pdf",
      sizeBytes: 2_181_311,
      partId: "2.2",
      inline: false,
    });
  }, 30_000);
});
