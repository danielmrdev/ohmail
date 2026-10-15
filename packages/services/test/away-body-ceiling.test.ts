import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { awayResponders } from "@trafficflow/db";
import { DRAFT_BODY_MAX_BYTES } from "@trafficflow/core/mail";
import { AwayResponderService, ServiceError } from "../src/index.js";
import { makeCtx } from "./helpers.js";

/**
 * ── THE AWAY NOTICE'S BODY IS BOUNDED AT THE WRITE DOOR ────────────────────────────────────
 *
 * It was type-checked and nothing else: `validNullableText` asked whether the value was a string
 * and stored it. What made that a hole rather than a missing nicety is where the value goes — the
 * row is stored once and then placed in an `OutboundMessage` the worker sends over SMTP to every
 * eligible correspondent for as long as the responder is on. The request door's ceiling bounds ONE
 * PUT; this value is sent again per correspondent, so one request bought unbounded outbound bytes.
 *
 * The ceiling is `DRAFT_BODY_MAX_BYTES` and not a number of its own: it is the same KIND of value
 * — a plain body this product sends as mail — and that constant's own docblock says why two
 * ceilings on one kind of value are a second number to keep true.
 */

const away = new AwayResponderService();

/** A body of exactly `bytes` ASCII bytes. */
const ascii = (bytes: number): string => "x".repeat(bytes);

describe("PUT /away-responder — the body's byte ceiling", () => {
  /** THE POSITIVE CONTROL, at the ceiling exactly: a ceiling that refuses its own number is a bug. */
  it("stores a body AT the ceiling", async () => {
    const w = await makeCtx();
    const body = ascii(DRAFT_BODY_MAX_BYTES);

    await away.put(w.ctx, { enabled: true, body, audience: "everyone" });

    const [row] = await w.db.select().from(awayResponders)
      .where(eq(awayResponders.accountId, w.accountId));
    // A one-word verdict: a failed assertion that pretty-prints a quarter-megabyte body would
    // take the reporter with it.
    expect(row?.body?.length).toBe(DRAFT_BODY_MAX_BYTES);
  });

  it("refuses one byte past it, and writes nothing", async () => {
    const w = await makeCtx();
    await away.put(w.ctx, { enabled: true, body: "Away until Monday.", audience: "everyone" });

    const err = await away
      .put(w.ctx, { enabled: true, body: ascii(DRAFT_BODY_MAX_BYTES + 1), audience: "everyone" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe("body_too_large");
    expect((err as ServiceError).httpStatus).toBe(413);
    // THE REFUSAL IS A REFUSAL: the row a person had is still theirs, not half-replaced.
    const [row] = await w.db.select().from(awayResponders)
      .where(eq(awayResponders.accountId, w.accountId));
    expect(row?.body).toBe("Away until Monday.");
  });

  /**
   * BYTES, NOT CHARACTERS. A `.length` ceiling admits three times the bytes for a body somebody
   * writes in a non-Latin script, which is the shape where "we bounded it" is true of the number
   * nobody is paying and false of the one they are.
   */
  it("counts UTF-8 bytes, so a multi-byte body past the ceiling is refused too", async () => {
    const w = await makeCtx();
    // Three bytes each, so a third of the ceiling in characters is the whole ceiling in bytes.
    const chars = Math.floor(DRAFT_BODY_MAX_BYTES / 3) + 1;

    const err = await away
      .put(w.ctx, { enabled: true, body: "電".repeat(chars), audience: "everyone" })
      .catch((e: unknown) => e);

    expect((err as ServiceError)?.code).toBe("body_too_large");
  });

  /** An ordinary notice is stored exactly as it was. */
  it("stores an ordinary notice unchanged", async () => {
    const w = await makeCtx();
    await away.put(w.ctx, { enabled: true, body: "Back on Monday.", audience: "everyone" });
    const [row] = await w.db.select().from(awayResponders)
      .where(eq(awayResponders.accountId, w.accountId));
    expect(row?.body).toBe("Back on Monday.");
  });

  /** `null` still means "no body" — the ceiling did not turn an absent value into a refusal. */
  it("still accepts a null body", async () => {
    const w = await makeCtx();
    await away.put(w.ctx, { enabled: false, body: null, audience: "everyone" });
    const [row] = await w.db.select().from(awayResponders)
      .where(eq(awayResponders.accountId, w.accountId));
    expect(row?.body).toBe(null);
  });
});
