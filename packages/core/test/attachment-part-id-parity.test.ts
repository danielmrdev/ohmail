import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeMime } from "../src/mime.js";
import { NESTED_FIXTURES, NESTED_FIXTURE_SHA256, type NestedFixture } from "./fixtures/nested-parts.js";

/**
 * A stored `part_id` is the IMAP section the download asks for, so it must BE the server's section.
 * `imap` is Dovecot 2.3.21's section for each file (2026-09-30: the fixture APPENDed, BODYSTRUCTURE
 * walked, each section fetched and matched to the file by sha256); `mp3918` is what mailparser
 * 3.9.18 numbered it, which fetched another part's bytes or none on three of the fixtures. GreenMail is not
 * an oracle here: it served the parent node for nested sections. `null` is a single-part message,
 * fetched as section 1.
 */
const EXPECTED: Record<NestedFixture, Array<{ file: string; imap: string | null; mp3918: string | null }>> = {
  f1: [
    { file: "pic1.png", imap: "1.2.2", mp3918: "1.2.2" },
    { file: "report.pdf", imap: "2", mp3918: "2" },
    { file: "forwarded.eml", imap: "3", mp3918: "3" },
    { file: "photo.jpg", imap: "4", mp3918: "4" },
  ],
  f2: [
    { file: "a.pdf", imap: "2.1", mp3918: "2.2.1" },
    { file: "b.zip", imap: "2.2", mp3918: "2.2.2" },
    { file: "c.png", imap: "3", mp3918: "3" },
  ],
  f3: [
    { file: "a.png", imap: "2", mp3918: "2" },
    { file: "b.gif", imap: "3", mp3918: "3" },
  ],
  f4: [
    { file: "one.eml", imap: "2", mp3918: "2" },
    { file: "two.eml", imap: "3", mp3918: "3" },
  ],
  f5: [
    { file: "one.pdf", imap: "2", mp3918: "2" },
    { file: "two.docx", imap: "3.1", mp3918: "3.2.1" },
    { file: "three.xlsx", imap: "4", mp3918: "4" },
  ],
  f6: [{ file: "only.pdf", imap: null, mp3918: null }],
  f7: [
    { file: "message/rfc822", imap: "2", mp3918: "2" },
    { file: "after.png", imap: "3", mp3918: "3" },
  ],
  f8: [
    { file: "signed-a.pdf", imap: "1.2.1", mp3918: "1.2.2.1" },
    { file: "smime.p7s", imap: "2", mp3918: "2" },
  ],
};

describe("a stored attachment part id is the server's IMAP section", () => {
  it("the fixtures are the bytes the Dovecot read was made over", () => {
    for (const [k, raw] of Object.entries(NESTED_FIXTURES)) {
      expect(createHash("sha256").update(raw).digest("hex"), k).toBe(NESTED_FIXTURE_SHA256[k as NestedFixture]);
    }
  });

  for (const key of Object.keys(EXPECTED) as NestedFixture[]) {
    it(`${key}: every file's partId equals its Dovecot section`, async () => {
      const parsed = await normalizeMime(NESTED_FIXTURES[key]);
      const got = parsed.attachments.map((a) => ({ file: a.filename ?? a.contentType, partId: a.partId }));
      expect(got).toEqual(EXPECTED[key].map((e) => ({ file: e.file, partId: e.imap })));
      // Where 3.9.18 numbered it otherwise, the stored id is no longer that one.
      for (const e of EXPECTED[key].filter((x) => x.mp3918 !== x.imap)) {
        expect(got.find((g) => g.file === e.file)?.partId, `${key} ${e.file}`).not.toBe(e.mp3918);
      }
    });
  }

  it("the 3.9.18 column differs from IMAP on exactly f2, f5 and f8", () => {
    const differs = (Object.keys(EXPECTED) as NestedFixture[])
      .filter((k) => EXPECTED[k].some((e) => e.mp3918 !== e.imap));
    expect(differs).toEqual(["f2", "f5", "f8"]);
  });
});
