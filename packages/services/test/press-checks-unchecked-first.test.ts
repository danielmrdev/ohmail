import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { folderState, messages } from "@trafficflow/db";
import type { ClassifierPort, ClassifierResult } from "@trafficflow/core";
import { ScreenerService } from "../src/index.js";
import { makeCtx, seedMessage, FakeAdapter } from "./helpers.js";

/**
 * A PERSON'S DOMAIN PRESS CHECKS WHAT IT WOULD MOVE (mail 0148), through the real fact. Rows from
 * before the column, which the backfill has not reached, are read by the fact before the press moves
 * them: another address's unchecked "PostFinance" claim is marked and stays at the Screener, and an
 * ordinary unchecked row from a third address goes with the domain.
 */
const YES: ClassifierResult = { destination: "INBOX", confidence: 0.92, rationale: "looks like a real person", spam: false };
const classifier: ClassifierPort = { async classify() { return YES; } };
const PHISH = "Bitte bestätigen: Reaktivierung Ihrer PostFinance Karte erforderlich";

describe("a domain press over rows the check never reached", () => {
  it("checks them first: another address's claim stays, marked, and the rest moves with the domain", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const pressed = await seedMessage(db, accountId, mailboxId, { from: "anna@firma.example", fromName: "Anna Keller" });
    const clean = await seedMessage(db, accountId, mailboxId, { from: "dora@firma.example", fromName: "Dora Huber" });
    const claim = await seedMessage(db, accountId, mailboxId, { from: "eve@firma.example", fromName: "PostFinance", subject: PHISH });
    const row = async (id: string) => (await db.select({ desired: folderState.desiredFolder, check: messages.senderCheck, brand: messages.senderCheckBrand })
      .from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id)).where(eq(messages.id, id)))[0]!;
    expect((await row(claim)).check).toBeNull();

    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier });
    await svc.decide(ctx, pressed, { decision: "yes", scope: "domain" });

    expect(await row(pressed)).toMatchObject({ desired: "INBOX", check: "none" });
    expect(await row(clean)).toMatchObject({ desired: "INBOX", check: "none" });
    expect(await row(claim)).toEqual({ desired: "ohmail/Screener", check: "impersonation", brand: "PostFinance" });
  });
});
