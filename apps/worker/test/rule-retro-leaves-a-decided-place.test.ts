import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, folderState, mailboxes, messages, rules } from "@trafficflow/db";
import { ruleRetroPass } from "../src/rule-retro.js";

/** The explicit empty trust set - an unlisted provider's mailbox; the auth demotion never fires. */
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();

/**
 * A RULE ABOUT A SENDER NEVER MOVES A LETTER WHOSE PLACE SOMEBODY DECIDED (`folder_state.decided_at`):
 * the person's own move (a decision once moved 42 earlier letters out of News) and an
 * answer the gate admitted for itself alone (screening the stranger out would have
 * taken the answer with it). Their undecided mail still moves: the decision does what it names.
 */

const OHBOX = "INBOX";
const NEWS = "ohmail/News";
const SCREENED = "ohmail/Screened";
const GATE = "ohmail/Screener";
const STRANGER = "b+r31x@answers.example";

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `decided-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
  }).returning();
  const letter = async (folder: string, decidedAt: Date | null): Promise<string> => {
    const dedup = `mid:${randomUUID()}`;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
      subject: "the north elevation", fromAddress: STRANGER, nativeLocator: { folder, ref: "1:1" },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: folder, observedFolder: folder, lastSetBy: "us",
      reconcileStatus: "reconciled", conflict: false, decidedAt,
    });
    return m!.id;
  };
  const decide = async (destination: string) => {
    await db.insert(rules).values({
      accountId, kind: "sender", match: STRANGER, destination, provenance: "promoted", enabled: true,
      retroRequestedAt: new Date("2026-10-10T06:50:00Z"), personDecidedAt: new Date("2026-10-10T06:50:00Z"),
    });
    return ruleRetroPass(db as never, { accountId, trustedAuthservIdsFor: NONE }, new Date("2026-10-10T06:51:00Z"));
  };
  const at = async (id: string) => (await db.select({ d: folderState.desiredFolder }).from(folderState)
    .where(eq(folderState.messageId, id)))[0]!.d;
  return { letter, decide, at };
}

describe("the retro leaves a place somebody decided", () => {
  it("screening the stranger out moves neither their admitted answer nor a letter the person filed", async () => {
    const w = await world();
    const answer = await w.letter(OHBOX, new Date("2026-10-10T06:42:45Z"));
    const filed = await w.letter(NEWS, new Date("2026-10-09T08:00:00Z"));
    const undecided = await w.letter(OHBOX, null);
    const res = await w.decide(SCREENED);
    expect([await w.at(answer), await w.at(filed)]).toEqual([OHBOX, NEWS]);
    // CONTROL: the decision still moves what it names, the sender's undecided mail.
    expect(await w.at(undecided)).toBe(SCREENED);
    expect(res.moved).toBe(1);
  });

  it("CONTROL: a letter put back at the gate waits for this decision, and the decision moves it", async () => {
    const w = await world();
    const back = await w.letter(GATE, new Date("2026-10-09T08:00:00Z"));
    await w.decide(NEWS);
    expect(await w.at(back)).toBe(NEWS);
  });

  it("CONTROL: an admission into the Ohbox moves undecided mail filed elsewhere", async () => {
    const w = await world();
    const news = await w.letter(NEWS, null);
    await w.decide(OHBOX);
    expect(await w.at(news)).toBe(OHBOX);
  });
});
