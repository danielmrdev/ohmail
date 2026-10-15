import { describe, expect, it } from "vitest";
import { draftContentRevision } from "../src/draft-revision.js";

/**
 * EVERY MEMBER OF THE REVISION, ONE AT A TIME.
 *
 * The digest decides whether a send goes or is refused, so a member left out of it is a change a
 * second window can make that this product will deliver under somebody else's press. The cases
 * below are one per member; a member dropped from the canonicalization reddens exactly one.
 */
const ROW = {
  mailboxId: "mbx-1",
  inReplyToMessageId: null as string | null,
  subject: "the invoice",
  body: "Here is the invoice you asked for.",
  html: null as string | null,
  to: [{ name: null, address: "chosen@example.com" }] as unknown,
  cc: [] as unknown,
  bcc: [] as unknown,
};

const rev = (over: Partial<typeof ROW> = {}): string => draftContentRevision({ ...ROW, ...over });

describe("the draft revision moves when the message does", () => {
  it("is stable for an unchanged row", () => {
    expect(rev()).toBe(rev());
    expect(rev()).toMatch(/^[0-9a-f]{64}$/);
  });

  const moves: Array<[string, Partial<typeof ROW>]> = [
    ["the sending identity", { mailboxId: "mbx-2" }],
    ["the reply target", { inReplyToMessageId: "msg-9" }],
    ["the subject", { subject: "the invoice (corrected)" }],
    ["the plain body", { body: "scratch notes — do not send" }],
    ["the rich body", { html: "<p>Approved</p>" }],
    ["a To recipient", { to: [{ name: null, address: "someone-else@example.com" }] }],
    ["a recipient's display name", { to: [{ name: "Not Them", address: "chosen@example.com" }] }],
    ["a second To recipient", { to: [{ name: null, address: "chosen@example.com" }, { name: null, address: "plus@example.com" }] }],
    ["a Cc recipient", { cc: [{ name: null, address: "cc@example.com" }] }],
    ["a Bcc recipient", { bcc: [{ name: null, address: "blind@example.com" }] }],
  ];
  for (const [what, over] of moves) {
    it(`moves when ${what} changes`, () => {
      expect(rev(over), `${what} is not in the revision — a second window can change it and the send goes`)
        .not.toBe(rev());
    });
  }

  /**
   * The recipients are digested as TUPLES, never as the stored object: jsonb does not preserve key
   * order, so stringifying the column would make the revision a fact about the storage engine and
   * a round trip through Postgres could refuse a send nobody touched.
   */
  it("does not depend on the key order of a stored address", () => {
    const a = rev({ to: [{ name: "Them", address: "chosen@example.com" }] });
    const b = rev({ to: [{ address: "chosen@example.com", name: "Them" } as never] });
    expect(b).toBe(a);
  });

  /**
   * The two halves of a rich draft are separate members. Collapsing them made a PLAIN draft whose
   * body is the literal text `<p>Approved</p>` hash the same as a RICH one whose markup is that —
   * the mistake `sendContentFingerprint` records having made, kept out of this one.
   */
  it("tells a plain body apart from the same characters as markup", () => {
    expect(rev({ body: "<p>Approved</p>", html: null }))
      .not.toBe(rev({ body: "Approved", html: "<p>Approved</p>" }));
  });
});
