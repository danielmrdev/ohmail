import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, accountSettings, applyScreenerDecision, contacts, folderState, listAddresses, listBrandsOf, mailboxFolders,
  mailboxes, messageBodies, messageInstances, messages, routingDecisions, SCREENER_SUGGESTION_PROVENANCE,
  SCREENER_SUGGESTION_STATUS, type Tx,
} from "@trafficflow/db";
import { carryDialect } from "@trafficflow/db/dialect";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { claimedIdentity, evaluateRules, normalizeMime } from "@trafficflow/core/mail";
import { ScreenerService } from "../src/screener-service.js";
import { materializeMessages } from "../src/dto/materialize.js";
import { resetScreeningState } from "../src/consent-reset.js";
import { heldReleaseSenders, releaseHeld } from "../src/held-release-service.js";
import type { ServiceContext } from "../src/context.js";

/**
 * A LIST ADDRESS ON THE SCREENER (mail 0150). The person wrote to `list@` and to a friend, and both
 * have a company claim held. The friend is somebody they wrote to: the row says so and the advice
 * stays theirs. `list@` is an address a mailing list posts as: the row carries the list sentence,
 * the claim's own fact decides the reason, and the advice bought on it is capped — never "You wrote
 * first" at the Ohbox. The mirror carries the same fact on the message. A consent reset forgets
 * the brands a press consented there and keeps the row. On whichever store the project runs.
 */
const GATE = "ohmail/Screener";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const CONNECT = new Date("2026-09-01T08:00:00.000Z");
const WROTE = new Date("2026-09-22T15:12:00.000Z");
const LIST = "list@lists.invalid";
const FRIEND = "friend@corr.invalid";

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `lst-${accountId.slice(0, 8)}` });
  await db.insert(accountSettings).values({ accountId, screeningScope: "all_time" });
  const me = `me-${accountId.slice(0, 8)}@own.invalid`;
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: me, status: "connected", organizerRole: "organizer", createdAt: CONNECT,
  }).returning();
  await db.insert(mailboxFolders).values({ mailboxId: mb!.id, folder: "Sent", uidvalidity: 7n, uidnext: 100n });
  let uid = 0;
  const sentTo = async (to: string, source: "person" | "inferred" = "person") => {
    uid += 1;
    const [s] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `sent:${randomUUID()}`, subject: "Spring meeting",
      fromAddress: me, messageIdHeader: `post-${uid}@own.invalid`, date: WROTE, arrivedAt: WROTE,
      toAddresses: [{ name: null, address: to }], ccAddresses: [], nativeLocator: { folder: "Sent", ref: `7:${uid}` },
    }).returning();
    await db.insert(messageInstances).values({
      accountId, mailboxId: mb!.id, messageId: s!.id, folder: "Sent", uidvalidity: 7n, uid, isPrimary: true,
    });
    await db.insert(folderState).values({
      messageId: s!.id, desiredFolder: "Sent", observedFolder: "Sent", lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    await db.insert(messageBodies).values({ messageId: s!.id, text: "hi", headers: {} });
    await db.insert(contacts).values({ accountId, address: to, source });
  };
  await sentTo(LIST);
  // `inferred`: a person's contact's held claim is not waiting at all (the person skip), so the
  // correspondent the control reads is one the account wrote to without that consent.
  await sentTo(FRIEND, "inferred");
  await db.insert(listAddresses).values({ accountId, address: LIST, consentedBrands: ["Swisscom"] });
  /** A company claim from `from`, held at the gate, with an "Ohbox" suggestion bought on it. */
  const heldClaim = async (from: string) => {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: randomUUID(), dedupKey: `lst:${randomUUID()}`, subject: "Ihre Karte",
      snippet: "", fromAddress: from, fromName: "PostFinance", senderCheck: "impersonation", senderCheckBrand: "PostFinance",
      date: NOW, unread: true, createdAt: NOW, nativeLocator: { folder: GATE, ref: `1:${randomUUID().slice(0, 6)}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: GATE, observedFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    await db.insert(routingDecisions).values({
      accountId, messageId: m!.id, inputProvenance: SCREENER_SUGGESTION_PROVENANCE, destination: "INBOX",
      confidence: 0.95, rationale: "a bank", spam: false, status: SCREENER_SUGGESTION_STATUS,
    } as never);
    return m!.id;
  };
  /** A newer held message from `from` claiming nothing, with an "Ohbox" suggestion bought on it. */
  const heldPlain = async (from: string) => {
    const at = new Date(NOW.getTime() + 60_000);
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: randomUUID(), dedupKey: `lst:${randomUUID()}`, subject: "Agenda",
      snippet: "", fromAddress: from, fromName: "The Lists", senderCheck: "none", date: at, unread: true, createdAt: at,
      nativeLocator: { folder: GATE, ref: `1:${randomUUID().slice(0, 6)}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: GATE, observedFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    await db.insert(routingDecisions).values({
      accountId, messageId: m!.id, inputProvenance: SCREENER_SUGGESTION_PROVENANCE, destination: "INBOX",
      confidence: 0.95, rationale: "a list", spam: false, status: SCREENER_SUGGESTION_STATUS,
    } as never);
    return m!.id;
  };
  const ctx: ServiceContext = {
    db: db as never, accountId, userId: null, now: () => NOW, requestId: `lst-${randomUUID().slice(0, 8)}`,
  };
  const brandsOf = async (address: string) => {
    const [r] = await db.select({ b: listAddresses.consentedBrands }).from(listAddresses)
      .where(and(eq(listAddresses.accountId, accountId), eq(listAddresses.address, address)));
    return r === undefined ? null : listBrandsOf(r.b);
  };
  return { db, accountId, ctx, heldClaim, heldPlain, brandsOf };
}

describe("a list address on the Screener", () => {
  it("ACCEPTANCE 1k: the row carries the list sentence and the claim's fact caps the advice", async () => {
    const w = await world();
    const id = await w.heldClaim(LIST);
    const { items } = await new ScreenerService({}).list(w.ctx, { limit: 50 });
    const item = items.find((i) => i.messageId === id)!;
    expect(item.checked).toEqual({ reason: "impersonation", brand: "PostFinance", domainShared: false, list: true });
    expect(item.aiSuggestion).toMatchObject({ reasonCode: "impersonation", reasonBrand: "PostFinance" });
    expect(item.aiSuggestion!.decision, "\"You wrote first\" at the Ohbox for a list address").not.toBe("yes");
  });

  it("ACCEPTANCE 1k: an older claim in a list address's held mail caps advice bought on a newer plain message", async () => {
    const w = await world();
    await w.heldClaim(LIST);
    const plain = await w.heldPlain(LIST);
    const { items } = await new ScreenerService({}).list(w.ctx, { limit: 50 });
    const item = items.find((i) => i.messageId === plain)!;
    expect(item.checked).toEqual({ reason: "impersonation", brand: "PostFinance", domainShared: false, list: true });
    expect(item.aiSuggestion!.reasonCode, "\"You wrote first\" over a list address's claim").toBe("impersonation");
    expect(item.aiSuggestion!.decision).not.toBe("yes");
  });

  it("CONTROL: a person this account wrote to keeps the correspondent reading and carries no list sentence", async () => {
    const w = await world();
    const id = await w.heldClaim(FRIEND);
    const { items } = await new ScreenerService({}).list(w.ctx, { limit: 50 });
    const item = items.find((i) => i.messageId === id)!;
    expect(item.checked).toEqual({ reason: "impersonation", brand: "PostFinance", domainShared: false });
    expect(item.aiSuggestion).toMatchObject({ reasonCode: "correspondent" });
  });

  it("ACCEPTANCE 1k: the mirror's message carries the list fact beside the claim, and only there", async () => {
    const w = await world();
    const listed = await w.heldClaim(LIST);
    const friend = await w.heldClaim(FRIEND);
    const dtos = await materializeMessages(w.db as never, w.accountId, [listed, friend]);
    expect(dtos.get(listed)!.senderCheck).toEqual({ reason: "impersonation", brand: "PostFinance", domainShared: false, list: true });
    expect(dtos.get(friend)!.senderCheck).toEqual({ reason: "impersonation", brand: "PostFinance", domainShared: false });
  });
});

describe("a consent reset and a list address", () => {
  it("ACCEPTANCE 1h: the reset forgets the brands and keeps the row, so the next claim is held", async () => {
    const w = await world();
    expect(await w.brandsOf(LIST)).toEqual(["Swisscom"]);
    await resetScreeningState(w.ctx);
    expect(await w.brandsOf(LIST), "the row is the mailbox's fact; the brands were presses").toEqual([]);
    const known = await makeDrizzleRepo(w.db as never).knownSenders(w.accountId);
    const msg = await normalizeMime(Buffer.from([
      "Message-ID: <after-reset@lists.invalid>", `From: "Swisscom" <${LIST}>`, "To: me@own.invalid",
      "Subject: Rechnung", "Content-Type: text/plain; charset=utf-8", "", "x",
    ].join("\r\n")));
    const d = evaluateRules({
      msg, rules: [], knownSenders: { ...known, addresses: new Set([...known.addresses, LIST]) }, auth: "unauthenticated",
      ohboxPolicy: "people_and_replied", ownAddresses: new Set(),
      identity: claimedIdentity({ fromName: msg.from.name, fromAddress: msg.from.address, subject: msg.subject }) ?? null,
    });
    expect(d.destination).toBe(GATE);
  });
});

/**
 * A PRESS CONSENTS ONLY THE BRANDS OF THE CLAIMS IT MOVES (HAND BACK 1): the held-release offer's
 * press over a list address moves what its offer counted, the list's ordinary post, and neither moves
 * nor consents the claim the person was never shown; the next forgery still waits. A person's own NO
 * consents nothing, and a moved claim that failed authentication consents no brand.
 */
async function pressWorld(contactSource: "person" | "inferred") {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `lpr-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@own.invalid`, organizerRole: "organizer",
  }).returning();
  let n = 0;
  const held = async (name: string, brand: string | null, placedBy: "us" | "peer", auth: string | null = null) => {
    n += 1;
    const at = new Date(`2026-10-06T0${n}:00:00.000Z`);
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `lpr:${randomUUID()}`, subject: `m${n}`, snippet: "",
      fromAddress: LIST, fromName: name, authVerdict: auth, senderCheck: brand === null ? "none" : "impersonation",
      senderCheckBrand: brand, date: at, unread: true, createdAt: at, nativeLocator: { folder: GATE, ref: `1:${n}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: GATE, observedFolder: GATE, lastSetBy: placedBy, reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };
  await db.insert(contacts).values({ accountId, address: LIST, source: contactSource });
  await db.insert(listAddresses).values({ accountId, address: LIST, consentedBrands: [] });
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => NOW, requestId: `lpr-${randomUUID().slice(0, 8)}` };
  const desired = async (id: string) =>
    (await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;
  const brands = async () => listBrandsOf((await db.select({ b: listAddresses.consentedBrands }).from(listAddresses)
    .where(and(eq(listAddresses.accountId, accountId), eq(listAddresses.address, LIST))))[0]?.b);
  const nextClaimHeld = async () => {
    const known = await makeDrizzleRepo(db as never).knownSenders(accountId);
    const msg = await normalizeMime(Buffer.from([
      "Message-ID: <next@lists.invalid>", `From: "PostFinance" <${LIST}>`, "To: me@own.invalid",
      "Subject: Konto", "Content-Type: text/plain; charset=utf-8", "", "x",
    ].join("\r\n")));
    return evaluateRules({
      msg, rules: [], knownSenders: known, auth: "unauthenticated", ohboxPolicy: "people_and_replied", ownAddresses: new Set(),
      identity: claimedIdentity({ fromName: msg.from.name, fromAddress: msg.from.address, subject: msg.subject }) ?? null,
    }).destination === GATE;
  };
  const press = (decision: "yes" | "no") => (db as unknown as { transaction: <T>(f: (tx: unknown) => Promise<T>) => Promise<T> })
    .transaction((tx) => applyScreenerDecision(carryDialect(db as never, tx as object) as Tx, {
      accountId, scope: "sender", address: LIST, appliedFolder: decision === "yes" ? "INBOX" : "ohmail/Screened", decision,
      triggeringActionId: `screener:${randomUUID()}`, now: NOW, overExisting: "converge", decidedBy: "person",
    }));
  return { db, accountId, ctx, held, desired, brands, nextClaimHeld, press };
}

describe("a press over a list address consents only what it moves", () => {
  for (const source of ["person", "inferred"] as const) {
    for (const placedBy of ["peer", "us"] as const) {
      it(`the release offer's press, ${source} contact, post placed by ${placedBy}: moves the post, never the claim it did not show`, async () => {
        const w = await pressWorld(source);
        const post = await w.held("The List", null, placedBy);
        const forged = await w.held("PostFinance", "PostFinance", "us");
        expect(await heldReleaseSenders(w.db as never, w.accountId)).toEqual([{ sender: LIST, count: 1 }]);
        const r = await releaseHeld(w.ctx, { senders: [LIST] });
        expect([r.total, await w.desired(post)]).toEqual([1, "INBOX"]);
        expect(await w.desired(forged), "the offer never counted the claim").toBe(GATE);
        expect(await w.brands(), "a press that never showed the claim consents no brand").toEqual([]);
        expect(await w.nextClaimHeld(), "the next forgery still waits").toBe(true);
      });
    }
  }

  it("a person's NO over a list address's claim consents nothing", async () => {
    const w = await pressWorld("person");
    const forged = await w.held("PostFinance", "PostFinance", "us");
    await w.press("no");
    expect(await w.desired(forged)).toBe("ohmail/Screened");
    expect(await w.brands()).toEqual([]);
  });

  it("a moved claim that failed authentication consents no brand; CONTROL: the press moves it", async () => {
    const w = await pressWorld("person");
    const failed = await w.held("PostFinance", "PostFinance", "us", "fail");
    await w.press("yes");
    expect(await w.desired(failed)).toBe("INBOX");
    expect(await w.brands()).toEqual([]);
  });
});
