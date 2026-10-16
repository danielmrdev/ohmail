import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, accountSettings, applyScreenerDecision, contacts, folderState, mailboxes, messages, routingDecisions,
  rules, SCREENER_SUGGESTION_PROVENANCE, SCREENER_SUGGESTION_STATUS, type Tx,
} from "@trafficflow/db";
import { runSyncCycle } from "../src/sync.js";
import { screenerAutoActPass, type ScreenerActConsent } from "../src/screener-auto-act.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A SENDER THE ACT ADMITTED HAS NOT CONSENTED TO A NAME CLAIMING A COMPANY (mail 0148, the act's
 * consent ruled NARROW): the act on suggestions admits a benign first mail and writes its
 * promoted sender rule; the same address's next mail calls itself PostFinance and is held at the
 * Screener, the fact on its row. CONTROL: a person's own Screener yes writes the person contact,
 * and the same claim is admitted, the fact riding. Through the real ingest and the real act.
 */
const SENDER = "kundendienst@karten-service.test";
const GIVEN: ScreenerActConsent = { stillGiven: async () => true };

async function world() {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `actc-${accountId.slice(0, 8)}` });
  // 'all_time', so the act's cutline admits a fixture message whose date nobody set.
  await db.insert(accountSettings).values({ accountId, screeningScope: "all_time" });
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@example.test` }).returning();
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } },
  );
  const sent: Array<{ from: string; subject: string; messageId: string }> = [];
  /** One message from SENDER under `name`, through a whole sync cycle; its row's place and fact. */
  const deliver = async (name: string, subject: string) => {
    sent.push({ from: `"${name}" <${SENDER}>`, subject, messageId: `m-${randomUUID()}@karten-service.test` });
    fleet.behave(mb!.id, { deliver: [...sent] });
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE, repo: makeDrizzleRepo(db as never), adapter, accountId,
      mailboxId: mb!.id, storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
    });
    const [row] = await db.select({ id: messages.id, check: messages.senderCheck, desired: folderState.desiredFolder })
      .from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(eq(messages.accountId, accountId), eq(messages.subject, subject)));
    return row!;
  };
  return { db, accountId, deliver };
}

describe("an admission the act made is no consent to a name claiming a company", () => {
  it("the act admits a benign first mail; the same address claiming PostFinance next is held", async () => {
    const w = await world();
    const first = await w.deliver("Anna Meier", "Ihre Bestellung");
    expect(first, "premise: a stranger's first mail is held").toMatchObject({ desired: "ohmail/Screener", check: "none" });
    await w.db.insert(routingDecisions).values({
      accountId: w.accountId, messageId: first.id, inputProvenance: SCREENER_SUGGESTION_PROVENANCE,
      destination: "INBOX", confidence: 0.95, rationale: "", spam: false, status: SCREENER_SUGGESTION_STATUS,
    });
    const act = await screenerAutoActPass(w.db, { accountId: w.accountId, consent: GIVEN });
    expect(act, "premise: the act admitted the sender").toMatchObject({ ran: true, filed: 1 });
    const written = await w.db.select({ provenance: rules.provenance }).from(rules).where(eq(rules.accountId, w.accountId));
    expect(written.map((r) => r.provenance)).toEqual(["promoted"]);

    const claim = await w.deliver("PostFinance", "Ihre Karte wird gesperrt");
    expect(claim).toMatchObject({ desired: "ohmail/Screener", check: "impersonation" });
  });

  it("CONTROL: a person's own Screener yes is consent, and the same claim is admitted with the fact", async () => {
    const w = await world();
    const first = await w.deliver("Anna Meier", "Ihre Bestellung");
    await (w.db as unknown as { transaction: (f: (tx: Tx) => Promise<unknown>) => Promise<unknown> }).transaction((tx) =>
      applyScreenerDecision(tx, {
        accountId: w.accountId, scope: "sender", address: SENDER, appliedFolder: "INBOX", decision: "yes",
        triggeringActionId: `screener:press:${first.id}`, now: new Date(), stampBaseline: false, applyRetro: true,
        overExisting: "converge", liftOverDomain: true, decidedBy: "person",
      }));
    const [contact] = await w.db.select({ source: contacts.source }).from(contacts)
      .where(and(eq(contacts.accountId, w.accountId), eq(contacts.address, SENDER)));
    expect(contact!.source, "premise: the press wrote a person's contact").toBe("person");

    const claim = await w.deliver("PostFinance", "Ihre Karte wird gesperrt");
    expect(claim).toMatchObject({ desired: "INBOX", check: "impersonation" });
  });
});
