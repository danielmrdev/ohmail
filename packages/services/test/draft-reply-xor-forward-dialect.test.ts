/**
 * A DRAFT ANSWERS ONE MESSAGE OR FORWARDS ONE, ON BOTH STORES. The rule is a CHECK in the server's
 * migration and in the device twin's, so a write site that bypasses the service is refused on the
 * phone as it is on the server. This file runs in both projects: the default one on Postgres and
 * `pnpm test:sqlite` on the store a phone carries, which the first case states.
 */
import { describe, expect, it } from "vitest";
import { drafts } from "@trafficflow/db";
import { dialectOf } from "@trafficflow/db/dialect";
import { makeCtx, seedMessage } from "./helpers.js";

async function world() {
  const w = await makeCtx();
  const answered = await seedMessage(w.db, w.accountId, w.mailboxId, { subject: "answered" });
  const forwarded = await seedMessage(w.db, w.accountId, w.mailboxId, { subject: "forwarded" });
  return { ...w, answered, forwarded };
}

const draftRow = (w: Awaited<ReturnType<typeof world>>, over: Record<string, string | null>) => ({
  accountId: w.accountId, mailboxId: w.mailboxId, subject: "s", body: "b",
  to: [], cc: [], bcc: [], status: "draft" as const, ...over,
});

describe("a draft answers one message or forwards one, on this store", () => {
  it("runs on the store this project claims", async () => {
    const w = await world();
    expect(process.env.OHMAIL_EXPECT_DIALECT, "this run declared no store").toBeDefined();
    expect(dialectOf(w.db), "the project's store is not the one it says").toBe(process.env.OHMAIL_EXPECT_DIALECT);
  });

  it("the database refuses a row that both answers and forwards", async () => {
    const w = await world();
    const err = await w.db.insert(drafts)
      .values(draftRow(w, { inReplyToMessageId: w.answered, forwardOfMessageId: w.forwarded }))
      .then(() => null, (e: unknown) => e);
    expect(err, "a row answering and forwarding was stored").not.toBeNull();
    const said = `${String((err as { message?: unknown }).message ?? "")} ${String((err as { cause?: { message?: unknown } }).cause?.message ?? "")} ${String((err as { code?: unknown }).code ?? "")}`;
    expect(said, "refused, but not by the rule").toMatch(/drafts_reply_xor_forward|CHECK constraint|23514/);
  });

  it("CONTROL: a row that answers, and a row that forwards, are each stored", async () => {
    const w = await world();
    await w.db.insert(drafts).values(draftRow(w, { inReplyToMessageId: w.answered }));
    await w.db.insert(drafts).values(draftRow(w, { forwardOfMessageId: w.forwarded }));
    const rows = await w.db.select({ r: drafts.inReplyToMessageId, f: drafts.forwardOfMessageId }).from(drafts);
    expect(rows.map((x) => [x.r, x.f]).sort()).toEqual([[w.answered, null], [null, w.forwarded]].sort());
  });
});
