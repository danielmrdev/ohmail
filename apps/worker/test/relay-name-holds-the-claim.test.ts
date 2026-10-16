import { describe, expect, it } from "vitest";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, accountSettings, folderState, mailboxes, messages, rules, type Tx } from "@trafficflow/db";
import { runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A RELAY'S OWN BRAND EXCUSES NOTHING (mail 0148), through a real sync cycle. A
 * person's allow DOMAIN rule for a platform that relays mail under a user-chosen display name (a
 * Drive share from google.com): the name claims PostFinance and the platform, and the platform's
 * own match does not overlap PostFinance's, so the claim waits at the Screener with its fact.
 */
async function world(rule: { match: string } | null) {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `r026r-${accountId.slice(0, 8)}` });
  await db.insert(accountSettings).values({ accountId, screeningScope: "all_time" });
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@own.invalid` }).returning();
  if (rule) {
    await db.insert(rules).values({
      accountId, kind: "domain", match: rule.match, destination: "INBOX", provenance: "manual", enabled: true,
    });
  }
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials */ } },
  );
  const queue: Array<{ from: string; subject: string; messageId: string }> = [];
  const deliver = async (from: string, subject: string) => {
    queue.push({ from, subject, messageId: `m-${randomUUID()}@relay.invalid` });
    fleet.behave(mb!.id, { deliver: [...queue] });
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE, repo: makeDrizzleRepo(db as never), adapter, accountId,
      mailboxId: mb!.id, storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
    });
    const [row] = await db.select({ check: messages.senderCheck, desired: folderState.desiredFolder })
      .from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(eq(messages.accountId, accountId), eq(messages.subject, subject)));
    return row!;
  };
  return { deliver };
}

describe("a relay platform's domain rule and a name claiming another company", () => {
  it("a Drive-share shaped claim under an allow google.com rule", async () => {
    const w = await world({ match: "google.com" });
    const r = await w.deliver(`"PostFinance Sicherheit (via Google Drive)" <drive-shares-dm-noreply@google.com>`,
      "Dokument freigegeben: Kontoverifizierung PostFinance");
    expect(r, "a PostFinance claim from google.com waits at the Screener").toMatchObject({
      desired: "ohmail/Screener", check: "impersonation",
    });
  });

  it("CONTROL: the same claim without the platform's name in it is held", async () => {
    const w = await world({ match: "google.com" });
    const r = await w.deliver(`"PostFinance Sicherheit" <drive-shares-dm-noreply@google.com>`, "Dokument freigegeben");
    expect(r).toMatchObject({ desired: "ohmail/Screener", check: "impersonation" });
  });

  it("CONTROL: a plain Google notice under the rule is admitted", async () => {
    const w = await world({ match: "google.com" });
    const r = await w.deliver(`"Google" <no-reply@google.com>`, "Sicherheitswarnung");
    expect(r).toMatchObject({ desired: "INBOX", check: "none" });
  });
  it("OWNER SHAPE: a gmail.com allow rule and a PostFinance name from a gmail address", async () => {
    const w = await world({ match: "gmail.com" });
    const r = await w.deliver(`"PostFinance" <${personalAt("fixture.mila", "gmail.com")}>`,
      "Bitte bestätigen: Reaktivierung Ihrer PostFinance Karte erforderlich");
    expect(r).toMatchObject({ desired: "ohmail/Screener", check: "impersonation" });
  });
});

