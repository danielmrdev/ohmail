import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, folderState, mailboxes, messageBodies, messages } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { screenUnscreened, unscreenedSummary, type ServiceContext } from "../src/mail.js";

/**
 * SCREEN N LEAVES A PLACE SOMEBODY DECIDED, as the organize decision's walk does, through the one
 * predicate both scopes ask: an answer the gate admitted for itself alone, and a letter the person
 * filed into the INBOX, are neither counted nor screened. Undecided mail of the same senders' kind
 * still is. Run in both projects (PGlite here, `pnpm test:sqlite`).
 */

const OHBOX = "INBOX";
const GATE = "ohmail/Screener";
const NOW = new Date("2026-10-10T09:00:00.000Z");
const ARRIVED = new Date("2026-10-01T08:00:00.000Z");

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `uod-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `uod-${accountId.slice(0, 8)}@example.test`, organizerRole: "organizer",
  }).returning();
  let n = 0;
  const letter = async (from: string, placed: { setBy: "us" | "external"; decidedAt: Date | null }): Promise<string> => {
    const i = n++;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `uod:${randomUUID()}`, subject: `Note ${i}`,
      fromAddress: from, date: ARRIVED, createdAt: ARRIVED, unread: false, nativeLocator: { folder: OHBOX, ref: `1:${i}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: OHBOX, observedFolder: OHBOX, lastSetBy: placed.setBy,
      reconcileStatus: "reconciled", conflict: false, decidedAt: placed.decidedAt,
    });
    return m!.id;
  };
  const ctx: ServiceContext = {
    db: db as unknown as ServiceContext["db"], accountId, userId: null, now: () => NOW, requestId: `uod-${randomUUID().slice(0, 8)}`,
  };
  const desired = async (id: string) =>
    (await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;
  return { db, accountId, ctx, letter, desired };
}

describe("Screen N leaves a place somebody decided", () => {
  it("counts the undecided letter and neither the admitted answer nor the person's own filing", async () => {
    const w = await world();
    await w.letter("stranger@x.test", { setBy: "external", decidedAt: null });
    await w.letter("answerer@x.test", { setBy: "us", decidedAt: new Date("2026-10-02T08:00:00.000Z") });
    await w.letter("filed@x.test", { setBy: "external", decidedAt: new Date("2026-10-03T08:00:00.000Z") });
    const summary = await unscreenedSummary(w.db as never, w.accountId);
    expect(summary.groups.map((g) => g.address)).toEqual(["stranger@x.test"]);
    expect(summary.total).toBe(1);
  });

  it("the press screens only the undecided letter", async () => {
    const w = await world();
    const open = await w.letter("stranger@x.test", { setBy: "external", decidedAt: null });
    const answer = await w.letter("answerer@x.test", { setBy: "us", decidedAt: new Date("2026-10-02T08:00:00.000Z") });
    const pressed = await screenUnscreened(w.ctx);
    expect(pressed.total).toBe(1);
    expect([await w.desired(open), await w.desired(answer)]).toEqual([GATE, OHBOX]);
  });
});
