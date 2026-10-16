import { describe, expect, it } from "vitest";
import { classifySensitivity } from "@trafficflow/core/mail";
import { messageRowToDTO } from "../src/dto/materialize.js";
import type { messages } from "@trafficflow/db";

/**
 * ══ WHAT `sensitivity.sensitive` MEANS ON THE WIRE, AND WHY IT IS NOT THE OTHER FOUR FLAGS ══
 *
 * The field looks like a summary and is not one. A client reads it as **"render no text at
 * all"**: `isProtectedMessage` (client-engine) keys on `sensitivity.sensitive` alone,
 * `OhmailEngine.hydrateBody` refuses to fetch a body for such a message, `MirrorStore` purges
 * any body it already held, and the reader surfaces render a redaction block instead of the
 * mail. So a message this field is wrong about is a message its owner cannot read.
 *
 * It WAS wrong about an entire class of message. The projection ORed all five flags —
 * `category !== null || noAi || noForward || noKb || priority` — and `no_ai`/`no_kb` are set for
 * the whole INDETERMINATE bucket as well, which is ordinary mail we declined to show a MODEL.
 * That makes the OR a strict superset of the categorised set, and every message in the
 * difference was marked unreadable. The surfaces then failed in the worst available way: the
 * engine makes no request for a protected message, so nothing ever writes a body record, and the
 * reader sat under "Loading the full message…" with no end and no control.
 *
 * ── THE CLASSIFIER IS THE ORACLE, NOT A LITERAL ─────────────────────────────────────────────
 *
 * The first test below drives `classifySensitivity` — core's own function, which contains the
 * one-line definition this projection has to agree with (`const sensitive = category !== null`)
 * — and asserts the DTO reproduces its answer. A test asserting `sensitive === false` against a
 * hand-written row would pass just as well if core changed its mind, which is precisely the
 * drift that produced the defect: two definitions of one word.
 */

type Row = typeof messages.$inferSelect;

/** A stored row, as the ingest pipeline persists one classifier verdict. */
function rowFrom(v: ReturnType<typeof classifySensitivity>): Row {
  return {
    id: "m1",
    accountId: "a1",
    mailboxId: "mb1",
    threadId: null,
    messageIdHeader: "<x@example.invalid>",
    subject: "s",
    fromAddress: "someone@example.invalid",
    toAddresses: [],
    ccAddresses: [],
    date: new Date("2026-08-07T09:46:52.000Z"),
    nativeLocator: { folder: "INBOX" },
    snippet: "snippet",
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivityCategory: v.category,
    noAi: v.flags.no_ai,
    noForward: v.flags.no_forward,
    noKb: v.flags.no_kb,
    priority: v.flags.priority,
    dedupKey: "d",
    bodyHash: null,
    authVerdict: null,
    lastReadAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Row;
}

const classify = (subject: string, textBody: string) =>
  classifySensitivity({
    subject,
    textBody,
    htmlBody: null,
    from: { name: null, address: "someone@example.invalid" },
    to: [],
    cc: [],
    date: new Date("2026-08-07T09:46:52.000Z"),
    messageId: "<x@example.invalid>",
    headers: {},
  } as never);

describe("the wire's `sensitive` is core's `sensitive`", () => {
  /**
   * ══ THE GUARD ══════════════════════════════════════════════════════════════════════════
   *
   * Mail that is WITHHELD FROM THE MODEL but carries no category is `indeterminate`: `no_ai` and
   * `no_kb` true, `category` null, `sensitive` false. It is ordinary mail and its owner must be
   * able to read it.
   *
   * WATCHED RED by restoring the OR:
   *   `sensitive: category !== null || m.noAi || m.noForward || m.noKb || m.priority`
   * Real failure text:
   *   AssertionError: mail withheld from the model was marked unreadable by its owner: expected
   *   true to be false
   */
  it("mail withheld from the MODEL is not mail withheld from its OWNER", () => {
    // Japanese: a script the scanner cannot read, so the classifier fails CLOSED and withholds
    // it from the model — `indeterminate [unsupported_script]`, `no_ai` true, category NULL.
    // This is a perfectly ordinary message to the person whose mailbox it is.
    //
    // CHOSEN BY PROBE, NOT BY GUESS. The first version of this test used a German business reply
    // about a login flow, which reads like the fail-closed case and classifies `ordinary` — so
    // the assertion below held for a message that was never withheld, and restoring the OR left
    // it green. The premise is asserted first for exactly that reason.
    const v = classify("お知らせ", "アカウントの確認をお願いします。");
    expect(v.verdict, "the premise moved: this fixture is no longer withheld").toBe("indeterminate");
    expect(v.flags.no_ai).toBe(true);
    expect(v.category).toBeNull();

    expect(
      messageRowToDTO(rowFrom(v), undefined, undefined, undefined).sensitivity.sensitive,
      "mail withheld from the model was marked unreadable by its owner",
    ).toBe(false);

    // The second spelling of the same bucket, so the guard does not rest on one reason.
    const token = classify("Update", "Klick hier: https://x.example/auth?token=abcdef1234567890abcdef");
    expect(token.verdict).toBe("indeterminate");
    expect(token.flags.no_ai).toBe(true);
    expect(
      messageRowToDTO(rowFrom(token), undefined, undefined, undefined).sensitivity.sensitive,
    ).toBe(false);
  });

  /**
   * THE OTHER SIDE, so this is a boundary and not a blanket `false`. A positively-classified
   * message — one core gives a CATEGORY — is `sensitive` on the wire, and the client's redaction
   * still runs for it.
   *
   * Mutation: `sensitive: false`. Real failure text:
   *   AssertionError: a positively-sensitive message stopped being protected: expected false to
   *   be true
   */
  it("a positively-classified message is still sensitive", () => {
    const v = classify("Your verification code", "Your verification code is 449201. It expires in 10 minutes.");
    expect(v.category, "the fixture stopped being classified").not.toBeNull();
    expect(
      messageRowToDTO(rowFrom(v), undefined, undefined, undefined).sensitivity.sensitive,
      "a positively-sensitive message stopped being protected",
    ).toBe(true);
  });

  /**
   * AND THE DROPPED FLAGS ARE STILL ON THE WIRE. Narrowing `sensitive` must not narrow what a
   * caller who genuinely means "was this withheld from a model" can read — that question has an
   * answer, and it is `no_ai` / `no_kb` by name.
   *
   * Mutation: stop projecting `no_ai`. Real failure text:
   *   AssertionError: the model-disclosure flags left the wire with the widened `sensitive`
   */
  it("the model-disclosure flags survive the narrowing", () => {
    const v = classify("Your verification code", "Your verification code is 449201. It expires in 10 minutes.");
    const dto = messageRowToDTO(rowFrom(v), undefined, undefined, undefined);
    expect(
      { no_ai: dto.sensitivity.no_ai, no_kb: dto.sensitivity.no_kb },
      "the model-disclosure flags left the wire with the widened `sensitive`",
    ).toEqual({ no_ai: v.flags.no_ai, no_kb: v.flags.no_kb });
    expect(dto.sensitivity.category).toBe(v.category);
  });
});
