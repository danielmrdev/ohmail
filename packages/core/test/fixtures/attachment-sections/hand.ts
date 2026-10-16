import { createHash } from "node:crypto";

/**
 * The shapes the generator never makes: every transfer encoding a file arrives in, the boundary
 * shapes a byte locator could misread, an LF-only source, the rfc822 variants and both kinds of
 * root. Each names its outcome: `ok`, every file matched; `locator_refuses`, every file keeps
 * mailparser's id; `mailparser_differs`, mailparser stored bytes no section holds; and
 * `door_decodes_otherwise`, matched at ingest while the door's driver decodes the file otherwise.
 * Synthetic: example.com and example.org only; the files are deterministic bytes, never real mail.
 */

const bytes = (label: string, n: number): Buffer => {
  const out = Buffer.alloc(n);
  let h = createHash("sha256").update(label).digest();
  for (let i = 0; i < n; i += 32) { h.copy(out, i, 0, Math.min(32, n - i)); h = createHash("sha256").update(h).digest(); }
  return out;
};
const wrap = (s: string, width: number): string => s.replace(new RegExp(`.{1,${width}}`, "g"), (l) => `${l}\r\n`);
const head = (id: string): string => [
  "From: Alice <alice@example.com>", "To: Bob <bob@example.org>", `Subject: hand ${id}`,
  "Date: Wed, 30 Sep 2026 12:00:00 +0000", `Message-ID: <hand-${id}@sections.test>`, "MIME-Version: 1.0",
].join("\r\n");
const mixed = (b: string, parts: string[], close = true): string =>
  [`Content-Type: multipart/mixed; boundary="${b}"`, "", ...parts.map((p) => `--${b}\r\n${p}`), ...(close ? [`--${b}--`, ""] : [])].join("\r\n");
const text = (body: string): string => ["Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
const file = (type: string, name: string, cte: string, body: string, disp = "attachment"): string =>
  [`Content-Type: ${type}; name="${name}"`, `Content-Transfer-Encoding: ${cte}`, `Content-Disposition: ${disp}; filename="${name}"`, "", body].join("\r\n");
const b64 = (buf: Buffer, width = 76): string => wrap(buf.toString("base64"), width);
const rfc822 = (disp: string | null, inner: string, cte = "7bit"): string =>
  ["Content-Type: message/rfc822", `Content-Transfer-Encoding: ${cte}`, ...(disp ? [`Content-Disposition: ${disp}`] : []), "", inner].join("\r\n");

export type HandOutcome = "ok" | "locator_refuses" | "mailparser_differs" | "door_decodes_otherwise";

interface Hand { raw: Buffer; outcome: HandOutcome; what: string }

const crlf = (s: string): Buffer => Buffer.from(s, "utf8");

const PDF = bytes("hand-pdf", 1500);
const PNG = bytes("hand-png", 640);
const perLinePadded = Array.from({ length: 12 }, (_, i) => bytes(`hand-pad-${i}`, 56).toString("base64")).join("\r\n");

export const HAND_FIXTURES: Record<string, Hand> = {
  "txt-7bit": { outcome: "ok", what: "a text/plain file, 7bit", raw: crlf(`${head("txt-7bit")}\r\n${mixed("H1", [
    text("see the notes\r\n"), file("text/plain", "notes.txt", "7bit", "line one\r\nline two\r\n"),
  ])}`) },
  "csv-8bit": { outcome: "ok", what: "a text/csv file, 8bit UTF-8", raw: crlf(`${head("csv-8bit")}\r\n${mixed("H2", [
    text("table attached\r\n"), file("text/csv; charset=utf-8", "prices.csv", "8bit", "name,price\r\ncafé,3.50\r\nthé,2.80\r\n"),
  ])}`) },
  "ics-binary": { outcome: "ok", what: "a text/calendar invitation, binary", raw: crlf(`${head("ics-binary")}\r\n${mixed("H3", [
    text("an invitation\r\n"),
    file("text/calendar; method=REQUEST; charset=utf-8", "invite.ics", "binary",
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:Réunion\r\nDTSTART:20261002T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"),
  ])}`) },
  "vcf-qp": { outcome: "ok", what: "a text/vcard file, quoted-printable with soft breaks and trailing space", raw: crlf(`${head("vcf-qp")}\r\n${mixed("H4", [
    text("contact card\r\n"),
    file("text/vcard; charset=utf-8", "card.vcf", "quoted-printable",
      "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ren\x3dC3\x3dA9 Example  \r\nNOTE:a note long enough to be soft-=\r\nwrapped by the encoder\r\nEND:VCARD\r\n"),
  ])}`) },
  "txt-qp-tail": { outcome: "ok", what: "a quoted-printable file ending in a soft break", raw: crlf(`${head("txt-qp-tail")}\r\n${mixed("H5", [
    text("see attached\r\n"), file("text/plain; charset=utf-8", "tail.txt", "quoted-printable", "no final newline here="),
  ])}`) },
  "b64-64col": { outcome: "ok", what: "base64 wrapped at 64 columns", raw: crlf(`${head("b64-64col")}\r\n${mixed("H6", [
    text("report\r\n"), file("application/pdf", "report.pdf", "base64", b64(PDF, 64)),
  ])}`) },
  "b64-unwrapped": { outcome: "ok", what: "base64 on one unwrapped line", raw: crlf(`${head("b64-unwrapped")}\r\n${mixed("H7", [
    text("report\r\n"), file("application/pdf", "wide.pdf", "base64", `${bytes("hand-wide", 3000).toString("base64")}\r\n`),
  ])}`) },
  "b64-unpadded": { outcome: "ok", what: "base64 with its padding stripped", raw: crlf(`${head("b64-unpadded")}\r\n${mixed("H8", [
    text("report\r\n"), file("application/octet-stream", "raw.bin", "base64", b64(bytes("hand-unpadded", 1000)).replace(/=/g, "")),
  ])}`) },
  "b64-line-padded": { outcome: "door_decodes_otherwise", what: "base64 where every line is padded on its own (the door's libbase64 1.3.0 reads it otherwise)", raw: crlf(`${head("b64-line-padded")}\r\n${mixed("H9", [
    text("segments\r\n"), file("application/octet-stream", "segments.bin", "base64", `${perLinePadded}\r\n`),
  ])}`) },
  "uuencode": { outcome: "ok", what: "an x-uuencode file, passed through on every side", raw: crlf(`${head("uuencode")}\r\n${mixed("H10", [
    text("old client\r\n"),
    file("application/octet-stream", "old.bin", "x-uuencode", "begin 644 old.bin\r\n#86)C\r\n`\r\nend\r\n"),
  ])}`) },
  "boundary-midline": { outcome: "ok", what: "the boundary string inside a line, not at its start", raw: crlf(`${head("boundary-midline")}\r\n${mixed("H11", [
    text("the text mentions --H11 in the middle of a line\r\n"), file("application/pdf", "mid.pdf", "base64", b64(bytes("hand-mid", 500))),
  ])}`) },
  "boundary-prefix-line": { outcome: "locator_refuses", what: "a body line starting with the boundary and more after it", raw: crlf(`${head("boundary-prefix-line")}\r\n${mixed("H12", [
    file("text/plain", "trap.txt", "7bit", "first line\r\n--H12 is not a delimiter to every reader\r\nlast line\r\n"),
    file("application/pdf", "after.pdf", "base64", b64(bytes("hand-after", 500))),
  ])}`) },
  "missing-close": { outcome: "locator_refuses", what: "a multipart with no closing delimiter", raw: crlf(`${head("missing-close")}\r\n${mixed("H13", [
    text("unterminated\r\n"), file("application/pdf", "open.pdf", "base64", b64(bytes("hand-open", 500))),
  ], false)}`) },
  "nested-identical": { outcome: "locator_refuses", what: "an inner multipart reusing the outer boundary", raw: crlf(`${head("nested-identical")}\r\n${mixed("H14", [
    text("outer\r\n"),
    mixed("H14", [text("inner\r\n"), file("application/pdf", "inner.pdf", "base64", b64(bytes("hand-inner", 500)))]),
    file("image/png", "outer.png", "base64", b64(bytes("hand-outer", 300))),
  ])}`) },
  "lf-only": { outcome: "ok", what: "a source with bare LF line endings", raw: Buffer.from(`${head("lf-only")}\r\n${mixed("H15", [
    text("bare line feeds\r\n"),
    file("application/pdf", "lf.pdf", "base64", b64(bytes("hand-lf", 700))),
    file("text/plain", "lf.txt", "7bit", "one\r\ntwo\r\n"),
  ])}`.replace(/\r\n/g, "\n"), "utf8") },
  "rfc822-base64": { outcome: "ok", what: "a message/rfc822 sent base64-encoded: its inside is opaque, the rest is cut", raw: crlf(`${head("rfc822-base64")}\r\n${mixed("H16", [
    text("forwarded as base64\r\n"),
    rfc822("attachment", b64(Buffer.from(`${head("rfc822-base64-inner")}\r\n${file("application/pdf", "in.pdf", "base64", b64(PDF))}`)), "base64"),
  ])}`) },
  "rfc822-no-disposition": { outcome: "ok", what: "a message/rfc822 with no disposition, single-part body", raw: crlf(`${head("rfc822-nodisp")}\r\n${mixed("H17", [
    text("forwarded\r\n"), rfc822(null, `${head("rfc822-nodisp-inner")}\r\n${file("application/pdf", "nd.pdf", "base64", b64(PDF))}`),
  ])}`) },
  "rfc822-inline-png": { outcome: "ok", what: "an inline 7bit message/rfc822 whose body is one png", raw: crlf(`${head("rfc822-inline-png")}\r\n${mixed("H18", [
    text("see the picture\r\n"),
    rfc822("inline", `${head("rfc822-inline-png-inner")}\r\n${file("image/png", "pic.png", "base64", b64(PNG))}`),
  ])}`) },
  "rfc822-in-rfc822": { outcome: "mailparser_differs", what: "an inline rfc822 inside an inline rfc822 whose body is a png (mailparser reads the outer delimiter into it)", raw: crlf(`${head("rfc822-in-rfc822")}\r\n${mixed("H19", [
    text("twice wrapped\r\n"),
    rfc822("inline", `${head("rfc822-outer-inner")}\r\n${rfc822("inline", `${head("rfc822-inmost")}\r\n${file("image/png", "deep.png", "base64", b64(bytes("hand-deep", 400)))}`)}`),
  ])}`) },
  "rfc822-root": { outcome: "ok", what: "a message whose root is a message/rfc822", raw: crlf(`${head("rfc822-root")}\r\n${rfc822(null,
    `${head("rfc822-root-inner")}\r\n${mixed("H20", [text("inner\r\n"), file("application/pdf", "root.pdf", "base64", b64(bytes("hand-root", 600)))])}`)}`) },
  "root-csv": { outcome: "ok", what: "a single-part root that is a 7bit file", raw: crlf(`${head("root-csv")}\r\n${file("text/csv", "only.csv", "7bit", "a,b\r\n1,2\r\n")}`) },
  "same-logo-twice": { outcome: "ok", what: "the same picture attached twice", raw: crlf(`${head("same-logo-twice")}\r\n${mixed("H21", [
    text("twice\r\n"), file("image/png", "logo.png", "base64", b64(PNG)), file("image/png", "logo.png", "base64", b64(PNG)),
  ])}`) },
  "octet-named-pdf": { outcome: "ok", what: "application/octet-stream named .pdf", raw: crlf(`${head("octet-named-pdf")}\r\n${mixed("H22", [
    text("typed by name\r\n"), file("application/octet-stream", "typed.pdf", "base64", b64(bytes("hand-typed", 900))),
  ])}`) },
  "empty-file": { outcome: "ok", what: "an attachment with no bytes", raw: crlf(`${head("empty-file")}\r\n${mixed("H23", [
    text("empty file attached\r\n"), file("application/octet-stream", "empty.bin", "base64", ""),
  ])}`) },
  "latin1-body": { outcome: "ok", what: "an inline latin-1 body the driver converts, beside a file", raw: Buffer.concat([
    crlf(`${head("latin1-body")}\r\nContent-Type: multipart/mixed; boundary="H24"\r\n\r\n--H24\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\nCaf`),
    Buffer.from([0xe9]),
    crlf(` au lait\r\n--H24\r\n${file("application/pdf", "menu.pdf", "base64", b64(bytes("hand-menu", 500)))}\r\n--H24--\r\n`),
  ]) },
};
