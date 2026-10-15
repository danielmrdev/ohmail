import { createHash } from "node:crypto";

/**
 * Eight multipart shapes, byte-identical to the ones read against Dovecot 2.3.21 on 2026-09-30
 * (`NESTED_FIXTURE_SHA256` pins each). Every leaf carries distinct deterministic bytes, so a part
 * fetched by section is identified by its sha256. Synthetic: example.com/example.org only.
 */

const bytes = (label: string, n: number): Buffer => {
  const out = Buffer.alloc(n);
  let h = createHash("sha256").update(label).digest();
  for (let i = 0; i < n; i += 32) {
    h.copy(out, i, 0, Math.min(32, n - i));
    h = createHash("sha256").update(h).digest();
  }
  return out;
};
const b64 = (buf: Buffer) => buf.toString("base64").replace(/.{1,76}/g, (l) => `${l}\r\n`);
const leaf = (type: string, name: string, label: string, n: number, extra: string[] = []) => [
  `Content-Type: ${type}; name="${name}"`,
  "Content-Transfer-Encoding: base64",
  ...extra,
  `Content-Disposition: ${extra.some((e) => e.startsWith("Content-ID")) ? "inline" : "attachment"}; filename="${name}"`,
  "",
  b64(bytes(label, n)),
].join("\r\n");
const text = (sub: string, body: string) => [`Content-Type: text/${sub}; charset=utf-8`, "", body, ""].join("\r\n");
const multi = (sub: string, boundary: string, parts: string[]) => [
  `Content-Type: multipart/${sub}; boundary="${boundary}"`, "",
  ...parts.map((p) => `--${boundary}\r\n${p}`), `--${boundary}--`, "",
].join("\r\n");
const head = (id: string, subject: string) => [
  "From: Alice <alice@example.com>", "To: Bob <bob@example.org>", `Subject: ${subject}`,
  "Date: Wed, 30 Sep 2026 12:00:00 +0000", `Message-ID: <${id}@deps026.test>`, "MIME-Version: 1.0",
].join("\r\n");
const message = (id: string, subject: string, body: string) => `${head(id, subject)}\r\n${body}`;
const rfc822 = (name: string, inner: string) => [
  `Content-Type: message/rfc822; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, "", inner,
].join("\r\n");

const SOURCES = {
  // mixed > [alternative > (plain, related > (html, cid png)), pdf, rfc822 > mixed > (plain, bin), jpg]
  f1: message("f1", "F" + "1 nested", multi("mixed", "A" + "1", [
    multi("alternative", "B" + "1", [
      text("plain", "plain body"),
      multi("related", "C" + "1", [
        text("html", '<p>html <img src="cid:pic1@deps026"></p>'),
        leaf("image/png", "pic1.png", "f1-png", 700, ["Content-ID: <pic1@deps026>"]),
      ]),
    ]),
    leaf("application/pdf", "report.pdf", "f1-pdf", 1500),
    rfc822("forwarded.eml", message("f1-inner", "inner", multi("mixed", "D" + "1", [
      text("plain", "inner text"), leaf("application/octet-stream", "inner.bin", "f1-inner-bin", 900),
    ]))),
    leaf("image/jpeg", "photo.jpg", "f1-jpg", 1100),
  ])),
  // sibling multiparts — mixed > [alternative > (plain, html), mixed > (pdf, zip), png]
  f2: message("f2", "F" + "2 siblings", multi("mixed", "A" + "2", [
    multi("alternative", "B" + "2", [text("plain", "p"), text("html", "<p>h</p>")]),
    multi("mixed", "E2", [leaf("application/pdf", "a.pdf", "f2-pdf", 800), leaf("application/zip", "b.zip", "f2-zip", 600)]),
    leaf("image/png", "c.png", "f2-png", 500),
  ])),
  // Outlook — related at the root > [alternative > (plain, html), cid png, cid gif]
  f3: message("f3", "F" + "3 related root", multi("related", "R" + "3", [
    multi("alternative", "B" + "3", [text("plain", "p"), text("html", '<img src="cid:a@x"><img src="cid:b@x">')]),
    leaf("image/png", "a.png", "f3-png", 400, ["Content-ID: <a@x>"]),
    leaf("image/gif", "b.gif", "f3-gif", 300, ["Content-ID: <b@x>"]),
  ])),
  // mixed > [plain, rfc822 (single), rfc822 > mixed > (plain, csv)]
  f4: message("f4", "F" + "4 two rfc822", multi("mixed", "A" + "4", [
    text("plain", "top"),
    rfc822("one.eml", message("f4-one", "one", text("plain", "single-part inner"))),
    rfc822("two.eml", message("f4-two", "two", multi("mixed", "G" + "4", [text("plain", "inner"), leaf("text/csv", "x.csv", "f4-csv", 350)]))),
  ])),
  // mixed > [alternative, pdf, mixed > (docx, alternative), xlsx]
  f5: message("f5", "F" + "5 deep siblings", multi("mixed", "A" + "5", [
    multi("alternative", "B" + "5", [text("plain", "p"), text("html", "<p>h</p>")]),
    leaf("application/pdf", "one.pdf", "f5-pdf", 450),
    multi("mixed", "E5", [
      leaf("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "two.docx", "f5-docx", 520),
      multi("alternative", "H5", [text("plain", "p2"), text("html", "<p>h2</p>")]),
    ]),
    leaf("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "three.xlsx", "f5-xlsx", 610),
  ])),
  // a single-part attachment message (partId null; fetchPart falls back to "1")
  f6: `${head("f6", "F" + "6 single part")}\r\n${leaf("application/pdf", "only.pdf", "f6-pdf", 777)}`,
  // an INLINE message/rfc822 (no disposition) whose body is multipart with its own attachment
  f7: message("f7", "F" + "7 inline rfc822", multi("mixed", "A" + "7", [
    text("plain", "see below"),
    ["Content-Type: message/rfc822", "", message("f7-inner", "inner", multi("mixed", "D" + "7", [
      text("plain", "inner"), leaf("application/pdf", "deep.pdf", "f7-pdf", 640),
    ]))].join("\r\n"),
    leaf("image/png", "after.png", "f7-png", 330),
  ])),
  // signed > [mixed > (alternative, mixed > (pdf)), p7s]
  f8: message("f8", "F" + "8 signed siblings", multi('signed; protocol="application/pkcs7-signature"; micalg=sha-256', "S" + "8", [
    multi("mixed", "A" + "8", [
      multi("alternative", "B" + "8", [text("plain", "p"), text("html", "<p>h</p>")]),
      multi("mixed", "E8", [leaf("application/pdf", "signed-a.pdf", "f8-pdf", 560)]),
    ]),
    leaf("application/pkcs7-signature", "smime.p7s", "f8-sig", 256),
  ])),
} as const;

export type NestedFixture = keyof typeof SOURCES;

export const NESTED_FIXTURES = Object.fromEntries(
  Object.entries(SOURCES).map(([k, v]) => [k, Buffer.from(v.replace(/\r?\n/g, "\r\n"))]),
) as Record<NestedFixture, Buffer>;

/** sha256 of each `.eml` the Dovecot read was made over. */
export const NESTED_FIXTURE_SHA256: Record<NestedFixture, string> = {
  f1: "718b77bebc3bdd6cc1c057bf0199ec70b3958d89b80c04ba2f127621189a4dca",
  f2: "1e9da673ceee2b1df53f77be5e32f54eba1569190b53351dca179fc3c0a60c89",
  f3: "25e21fdb823605dbef444eabbef693e3291fa538342a4159dc8ecf131c34c568",
  f4: "24a114a37e69a796e8bb10c498b996a173dfb496a6b8cf8e58e4ff39779d5048",
  f5: "6b4592e2f3313529fb4f62c5d336b8103e8f59e32ff01c0cf11259a33fac0fca",
  f6: "2267ec35be966ec75f07e839e1ff5dc096841005c3934f27ebbedc4f67ab176a",
  f7: "b93a5eea17bd51ecfd30b6d526c2caa96fb4c9793218786d30ab3c885480ebd0",
  f8: "d8278a0158b2692fd221223c9cb0b17a2f3eb0c4a99da47079646c00d23e1612",
};
