import { beforeAll, describe, expect, it } from "vitest";
import { messageBodies } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { searchIndexBackfillPass } from "@trafficflow/core/mail";
import { SearchIndex, type EngineMessage } from "@ohmail/client-engine";
import { SearchService } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * THE DEVICE FINDS WHAT THE SERVER FINDS. This file runs in the default project (Postgres, as
 * PGlite, whose english stemmer is the server's) and in the sqlite project (the phone's store), and
 * TABLE is what Postgres answers in the exact tier: (1) every store answers the table, and (2) the
 * mirror index, the first paint on every client, answers a SUBSET of it, so no row appears and then
 * vanishes when the store answers. Bounded, named differences: STEMMER (Porter on the device,
 * Snowball on the server), PREFIX (FTS5 stems a part's prefix too), SHORT (the mirror's type-ahead
 * under four letters).
 */
const CORPUS: ReadonlyArray<readonly [key: string, subject: string, body: string]> = [
  ["duns", "Your D-U-N-S Number is enclosed", "Keep it safe."], ["email", "Your e-mail address", "Confirm it."],
  ["reenter", "Code", "Please re-enter the code below."], ["coop", "Agenda", "We co-operate with the county."],
  ["delivery", "Delivery window", "Between nine and noon."], ["delivered", "Parcel", "Your parcel was delivered today."],
  ["deliveries", "Weekly", "Two deliveries are late."], ["running", "Status", "The job is running now."],
  ["runs", "Timetable", "The bus runs hourly."], ["invoices", "Accounts", "Three invoices attached."],
  ["invoice", "Your invoice", "Thanks."], ["organizing", "Weekend", "We are organizing the files."],
  ["organization", "Board", "The organization met."], ["connection", "Network", "The connection dropped."],
  ["connected", "Router", "Everything connected again."], ["elevation", "Trip", "The elevation gain was large."],
  ["myaxa", "Welcome to myAXA", "Sign in."], ["unbelievable", "Wow", "An unbelievable result."],
  ["quarterly", "Figures", "The quarterly figures are in."], ["awe", "Notes", "A sense of awe."],
  ["awful", "Diary", "An awful day."], ["awfully", "Queue", "An awfully long wait."], ["decoy", "Holiday plans", "See you soon."],
];

/** Query → the keys Postgres answers in the exact tier; `[]` is a closest-words answer or none. */
const TABLE: ReadonlyArray<readonly [q: string, keys: readonly string[]]> = [
  // joined forms: a compound is found as written and by its parts, never by the parts run together
  ["DUNS", []], ["D-U-N-S", ["duns"]], ["email", []], ["e-mail", ["email"]], ["reenter", []], ["re-enter", ["reenter"]],
  ["cooperate", []], ["co-operate", ["coop"]],
  // stems
  ["delivered", ["delivered"]], ["delivery", ["deliveries", "delivery"]], ["deliveries", ["deliveries", "delivery"]],
  ["deliver", ["delivered", "deliveries", "delivery"]], ["run", ["running", "runs"]], ["running", ["running", "runs"]],
  ["runs", ["running", "runs"]], ["invoices", ["invoice", "invoices"]], ["invoice", ["invoice", "invoices"]],
  ["organize", ["organization", "organizing"]], ["organizing", ["organization", "organizing"]],
  ["organization", ["organization", "organizing"]], ["connect", ["connected", "connection"]],
  ["connected", ["connected", "connection"]], ["connection", ["connected", "connection"]],
  ["awe", ["awe"]], ["awfully", ["awful", "awfully"]],
  // part-words from the start, from four letters
  ["elevat", ["elevation"]], ["unbeliev", ["unbelievable"]], ["quarter", ["quarterly"]],
  ["deliv", ["delivered", "deliveries", "delivery"]], ["organiz", ["organization", "organizing"]],
  // a part inside a word: found in the headers, not in the text
  ["levation", []], ["believ", []], ["arterly", []], ["AXA", ["myaxa"]], ["voice", ["invoice"]],
  // under four letters
  ["inv", ["invoice"]], ["del", ["delivery"]], ["co", ["coop"]], ["qua", []], ["ele", []],
];

/**
 * STEMMER: where the device's Porter and the server's Snowball part, one pair each way (a small
 * share of stems over a long word list). Asked by the whole word, since a part-word prefix reaches past a stem.
 */
const STEMMER: Readonly<Record<string, { device: readonly string[] }>> = {
  awfully: { device: ["awfully"] },      // the server alone reaches `awful`
  awe: { device: ["awe", "awful"] },     // the device alone reaches `awful`
};
/**
 * PREFIX: FTS5's porter stems a part-word's prefix as well, so the device's `"delivered"*` reads
 * as `deliv*` and reaches `delivery` where the server's `'delivered':*` reaches nothing
 * (DEVICE-PART-PREFIX-IS-STEMMED). There the device answers MORE than the table, never less.
 */
const PREFIX: Readonly<Record<string, readonly string[]>> = { delivered: ["delivered", "deliveries", "delivery"] };
/** SHORT: under four letters the mirror is a type-ahead, so it answers at least the table. */
const SHORT = new Set(["inv", "del", "co", "qua", "ele"]);

function engineMessage(id: string, subject: string, body: string, i: number): EngineMessage {
  return {
    accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, to: [], cc: [], folder: "INBOX",
    unread: false, hasAttachments: false, attachmentCount: 0, triage: null, labels: [], remoteContent: "none",
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    updatedAt: "2026-09-08T12:00:00.000Z", id, subject, from: { name: null, address: `s${i}@site.example` },
    snippet: body, date: new Date(Date.parse("2026-07-20T09:00:00Z") - i * 86_400_000).toISOString(),
  };
}

describe("the device answers what the server answers", () => {
  let store: (q: string) => Promise<string[]>;
  let mirror: (q: string) => string[];
  let device = false;
  beforeAll(async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    device = dialect(db).name === "sqlite";
    const keyOf = new Map<string, string>();
    const index = new SearchIndex();
    for (const [i, [key, subject, body]] of CORPUS.entries()) {
      const id = await seedMessage(db, accountId, mailboxId, {
        subject, from: `s${i}@site.example`, snippet: body, folder: "INBOX",
        date: new Date(Date.parse("2026-07-20T09:00:00Z") - i * 86_400_000),
      });
      await db.insert(messageBodies).values({ messageId: id, text: body });
      keyOf.set(id, key);
      index.add(engineMessage(id, subject, body, i));
    }
    expect((await searchIndexBackfillPass({ db: db as never, accountId })).marked).toBe(true);
    store = async (q) => {
      const r = await new SearchService().search(ctx, { q, limit: 50 });
      return r.tier === "exact" ? r.items.map((m) => keyOf.get(m.id)!).sort() : [];
    };
    mirror = (q) => index.search(q, { limit: 50 }).items.map((h) => keyOf.get(h.message.id)!).sort();
  }, 60_000);

  it(`rule 1: the store answers the table (${TABLE.length} queries), the STEMMER and PREFIX classes apart on the device`, async () => {
    const wrong: Array<{ q: string; got: string[]; want: readonly string[] }> = [];
    for (const [q, keys] of TABLE) {
      if (device && PREFIX[q]) expect(keys.every((k) => PREFIX[q]!.includes(k)), `${q}: PREFIX only ever adds`).toBe(true);
      const want = device && STEMMER[q] ? STEMMER[q]!.device : device && PREFIX[q] ? PREFIX[q]! : keys;
      const got = await store(q);
      if (got.join() !== [...want].sort().join()) wrong.push({ q, got, want });
    }
    expect(wrong).toEqual([]);
  });

  it("rule 2: from four letters the mirror answers a subset of the table; under four, at least the table", () => {
    const wrong: Array<{ q: string; mirror: string[]; table: readonly string[] }> = [];
    for (const [q, keys] of TABLE) {
      const got = mirror(q);
      const ok = SHORT.has(q) ? keys.every((k) => got.includes(k)) : got.every((k) => keys.includes(k));
      if (!ok) wrong.push({ q, mirror: got, table: keys });
    }
    expect(wrong).toEqual([]);
  });

  it("the STEMMER class: each store's own pair, in its own direction", async () => {
    expect(await store("awfully"), device ? "Porter keeps awful apart" : "Snowball joins awful").toEqual(device ? ["awfully"] : ["awful", "awfully"]);
    expect(await store("awe"), device ? "Porter joins awful" : "Snowball keeps awful apart").toEqual(device ? ["awe", "awful"] : ["awe"]);
  });
});

/** The typo estimate on both stores: a cut closest-words arm gives no estimate. */
describe("a cut closest-words answer says at least, never about", () => {
  it("no estimate for the similar tier; the summary is exact", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    for (let i = 0; i < 12; i++) {
      const id = await seedMessage(db, accountId, mailboxId, { subject: `Voucher ${i}`, snippet: "Use it.", folder: "INBOX" });
      await db.insert(messageBodies).values({ messageId: id, text: "Use it." });
    }
    expect((await searchIndexBackfillPass({ db: db as never, accountId })).marked).toBe(true);
    const svc = new SearchService();
    const e = await svc.search(ctx, { q: "vo", parts: "estimate", limit: 1 });
    expect({ tier: e.tier, exact: e.totalExact, estimate: e.totalEstimate }).toEqual({ tier: "similar", exact: false, estimate: undefined });
    const s = await svc.search(ctx, { q: "vo", parts: "summary", limit: 1 });
    expect({ tier: s.tier, total: s.total }).toEqual({ tier: "similar", total: 12 });
  });
});
