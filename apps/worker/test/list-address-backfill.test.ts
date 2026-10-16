import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, accountSettings, contacts, listAddresses, listBrandsOf, mailboxes, messageBodies, messages, type Tx,
} from "@trafficflow/db";
import { createLogger } from "@trafficflow/core/mail";
import { listAddressBackfillPass } from "../src/list-address-backfill.js";

/**
 * THE LIST-ADDRESS BACKFILL (mail 0150), on the in-process store (PGlite here, the device's SQLite
 * in the `sqlite` project): every stored message's `List-Post` that did not fail authentication,
 * through the one parser, recorded once, then the stamp. A second run reads nothing, and mail
 * stored after the stamp is ingest's. It writes no contact.
 */
async function world() {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `lb-${accountId.slice(0, 8)}` });
  await db.insert(accountSettings).values({ accountId });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@own.invalid`, status: "connected",
  }).returning();
  let n = 0;
  const stored = async (headers: Record<string, string[]>, auth: string | null = null) => {
    n += 1;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `lb:${randomUUID()}`, subject: `m${n}`,
      fromAddress: `sender${n}@elsewhere.invalid`, authVerdict: auth, nativeLocator: { folder: "INBOX", ref: `1:${n}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "hi", headers });
  };
  const rows = async () => (await db.select({ address: listAddresses.address, brands: listAddresses.consentedBrands })
    .from(listAddresses).where(eq(listAddresses.accountId, accountId)))
    .map((r) => ({ address: r.address, brands: listBrandsOf(r.brands) }))
    .sort((a, b) => a.address.localeCompare(b.address));
  const stamp = async () => (await db.select({ at: accountSettings.listAddressesScannedAt }).from(accountSettings)
    .where(eq(accountSettings.accountId, accountId)))[0]?.at ?? null;
  const contactCount = async () => (await db.select({ a: contacts.address }).from(contacts)
    .where(and(eq(contacts.accountId, accountId)))).length;
  return { db, accountId, stored, rows, stamp, contactCount, me: `me-${accountId.slice(0, 8)}@own.invalid` };
}

describe("the list-address backfill", () => {
  it("ACCEPTANCE 1j: records every list address once, stamps, and a second run changes nothing", async () => {
    const w = await world();
    await w.stored({ "list-post": ["<mailto:list@lists.invalid>"] });
    await w.stored({ "list-post": ["<mailto:list@lists.invalid>"] });
    await w.stored({ "list-post": ["<mailto:Club@Lists.invalid?subject=post>"] });
    await w.stored({ "list-post": ["NO"] });
    await w.stored({ "list-post": ["<mailto:forged@lists.invalid>"] }, "fail");
    await w.stored({ "subject": ["no list here"] });

    const first = await listAddressBackfillPass(w.db, { accountId: w.accountId });
    expect(first.ran).toBe(true);
    expect(await w.rows()).toEqual([
      { address: "club@lists.invalid", brands: [] }, { address: "list@lists.invalid", brands: [] },
    ]);
    expect(await w.stamp(), "the stamp is written LAST").not.toBeNull();
    expect(await w.contactCount(), "a header is never a contact").toBe(0);

    await w.stored({ "list-post": ["<mailto:later@lists.invalid>"] });
    const second = await listAddressBackfillPass(w.db, { accountId: w.accountId });
    expect(second).toEqual({ ran: false, values: 0, addresses: 0 });
    expect((await w.rows()).map((r) => r.address), "mail stored after the stamp is ingest's").toEqual([
      "club@lists.invalid", "list@lists.invalid",
    ]);
  });

  it("an account with no list mail is stamped too, so the next tail reads one row and stops", async () => {
    const w = await world();
    await w.stored({ "subject": ["nothing"] });
    const r = await listAddressBackfillPass(w.db, { accountId: w.accountId });
    expect(r).toEqual({ ran: true, values: 0, addresses: 0 });
    expect(await w.stamp()).not.toBeNull();
  });

  it("its line through the real logger keeps both counts and names no address", async () => {
    const w = await world();
    await w.stored({ "list-post": ["<mailto:list@lists.invalid>"] });
    await w.stored({ "list-post": ["<mailto:club@lists.invalid>"] });
    const raw: string[] = [];
    await listAddressBackfillPass(w.db, {
      accountId: w.accountId, log: createLogger({ service: "worker", sink: (l) => { raw.push(l); } }),
    });
    const lines = raw.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === "list_address_backfill");
    expect(lines.map((l) => [l.scanned, l.written, l.droppedFields])).toEqual([[2, 2, undefined]]);
    expect(raw.join("\n")).not.toContain("lists.invalid");
  });

  it("LOW-4: a List-Post naming the account's own address is never recorded (the store's own door)", async () => {
    const w = await world();
    await w.stored({ "list-post": [`<mailto:${w.me}>`] });
    await w.stored({ "list-post": ["<mailto:list@lists.invalid>"] });
    await listAddressBackfillPass(w.db, { accountId: w.accountId });
    expect((await w.rows()).map((r) => r.address)).toEqual(["list@lists.invalid"]);
  });

  it("an address already recorded keeps the brands a press consented there", async () => {
    const w = await world();
    await w.db.insert(listAddresses).values({ accountId: w.accountId, address: "list@lists.invalid", consentedBrands: ["PostFinance"] });
    await w.stored({ "list-post": ["<mailto:list@lists.invalid>"] });
    await listAddressBackfillPass(w.db, { accountId: w.accountId });
    expect(await w.rows()).toEqual([{ address: "list@lists.invalid", brands: ["PostFinance"] }]);
  });
});
