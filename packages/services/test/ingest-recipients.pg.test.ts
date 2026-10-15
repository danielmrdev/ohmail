import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { accounts, mailboxes, messages, folderState } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { planChange, commitChange , UNMETERED_STORAGE_CAP} from "@trafficflow/core";
import type { Change } from "@trafficflow/core";
import { materializeMessage, messageRowToDTO } from "../src/dto/materialize.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * THE "To" LINE: `messages.to_addresses` / `cc_addresses` ARE WRITTEN BY THE CLOUD INGEST.
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The columns have existed (with a `'[]'::jsonb` default) since the mail schema landed, and
 * `messageRowToDTO` has always projected them into `MessageDTO.to`/`.cc`. Nothing on the Cloud
 * ingest path ever wrote them, so every Cloud-ingested message projected `to: []`, `cc: []` and
 * the reader rendered no recipient line at all. The defect was invisible to every existing test
 * because a defaulted column and an empty recipient list are the same value on the wire.
 *
 * ── WHY THIS IS A pg TEST AND NOT A FakeRepo ONE ──────────────────────────────────────────
 *
 * The claim is that a `EmailAddress[]` survives drizzle's insert builder into a `jsonb` column
 * and comes back out of a `select` as the same array of objects — a claim about SQL and about
 * jsonb round-tripping, not about what `commitChange` asked for. A fake repo would hold the
 * array in memory and assert nothing. This is also the file that pins the SHAPE: `jsonb`, an
 * array of `{ name, address }`, which is what the desktop mirror already writes and what the
 * projection already reads.
 *
 * ── THE THIRD CASE IS THE ONE THAT KEEPS THE DESKTOP HALF HONEST ──────────────────────────
 *
 * `apps/sidecar/src/cloud-mirror.ts` writes `toAddresses: m.to ?? []` straight off the DTO into
 * the same two columns of the local mail database. So there is exactly ONE on-disk shape for
 * recipients, written from two directions, and the last case asserts a row written the mirror's
 * way projects identically to a row written by ingest. If ingest ever wrote a different shape
 * — a comma-joined string, a bare address array — the mirror would keep writing objects, the
 * two would disagree on disk, and the projection would render one of them wrongly.
 *
 * ── THE SENDER'S HALF (mail 0057) ─────────────────────────────────────────────────────────
 *
 * `messages.from_name` went through the same defect one header up, with one difference: the
 * column did not exist. The parser produced `from: { name, address }` from the first day,
 * ingest persisted only `.address`, and `messageRowToDTO` hardcoded `from: { name: null, … }` —
 * so a fresh fixture whose From carried a display name still projected a bare address, and
 * nothing failed, because a name the sender never set and a name ingest dropped are the same
 * `null` on the wire. The named-From cases below are that path's guard: parse → store →
 * project, against real SQL.
 */

const AVAILABLE = await realPgAvailable();

const TO = [
  { name: "Mila", address: "mila@lichtgrat.example" },
  { name: null, address: "ops@lichtgrat.example" },
];
const CC = [{ name: "Anna", address: "anna@work.example" }];

function eml(): Buffer {
  return Buffer.from([
    `Message-ID: <recip-${randomUUID()}@bank.example>`,
    "From: partner@bank.example",
    'To: "Mila" <mila@lichtgrat.example>, ops@lichtgrat.example',
    'Cc: "Anna" <anna@work.example>',
    "Subject: Notes from Tuesday",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "The minutes are attached to the next one.",
  ].join("\r\n"));
}

describe.skipIf(!AVAILABLE)("Cloud ingest writes the recipient columns the DTO projects", () => {
  let owned: OwnedDb;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
  }, 180_000);

  afterAll(async () => { await owned?.close().catch(() => {}); });

  /** A fresh account + mailbox per case; the shared Postgres must not make reads flaky. */
  async function world(): Promise<{ accountId: string; mailboxId: string }> {
    const accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `to-${accountId.slice(0, 8)}` });
    const [mb] = await owned.db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: `${accountId}@to.test` }).returning();
    return { accountId, mailboxId: mb!.id };
  }

  async function ingest(w: { accountId: string; mailboxId: string }): Promise<string> {
    const change: Change = { type: "create", locator: { folder: "INBOX", ref: "1:10" }, raw: eml() };
    const repo = makeDrizzleRepo(owned.db);
    const plan = await planChange(change, { ...w, repo });
    const res = await owned.db.transaction(async (tx) => {
      const txRepo = makeDrizzleRepo(tx as never);
      return commitChange(plan, { ...w, repo: txRepo, storageCap: UNMETERED_STORAGE_CAP });
    });
    return res.messageId;
  }

  it("stores the parsed To and Cc lists on the row, as jsonb objects", async () => {
    const w = await world();
    const id = await ingest(w);

    const [row] = await owned.db.select().from(messages).where(eq(messages.id, id));
    // The exact shape, not just "non-empty": `EmailAddress[]`, display name preserved where the
    // header carried one and NULL where it did not. A bare-address array would satisfy a
    // length assertion and still render no name in the reader.
    expect(row!.toAddresses).toEqual(TO);
    expect(row!.ccAddresses).toEqual(CC);
  });

  it("projects them through materializeMessage — the DTO the reader renders", async () => {
    const w = await world();
    const id = await ingest(w);

    const dto = await materializeMessage(owned.db, w.accountId, id);
    expect(dto).not.toBeNull();
    // The whole point of the slice: this used to be `[]` for every Cloud-ingested message, so
    // the reader had nothing to draw a "To" line from.
    expect(dto!.to).toEqual(TO);
    expect(dto!.cc).toEqual(CC);
    // The sender is unchanged — the columns are additive, not a re-derivation of `from`.
    expect(dto!.from).toEqual({ name: null, address: "partner@bank.example" });
  });

  it("a message with no Cc keeps an empty Cc, and a defaulted row still projects []", async () => {
    const w = await world();
    // No recipient headers at all: the parser yields empty lists and the columns hold `[]`, which
    // is the same value the schema default gives every row written before this slice.
    const change: Change = {
      type: "create", locator: { folder: "INBOX", ref: "1:11" },
      raw: Buffer.from([
        `Message-ID: <norecip-${randomUUID()}@bank.example>`,
        "From: partner@bank.example",
        "Subject: No recipients on this one",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "body",
      ].join("\r\n")),
    };
    const repo = makeDrizzleRepo(owned.db);
    const plan = await planChange(change, { ...w, repo });
    const res = await owned.db.transaction(async (tx) =>
      commitChange(plan, { storageCap: UNMETERED_STORAGE_CAP, ...w, repo: makeDrizzleRepo(tx as never) }));

    const dto = await materializeMessage(owned.db, w.accountId, res.messageId);
    expect(dto!.to).toEqual([]);
    expect(dto!.cc).toEqual([]);
  });

  it("ONE on-disk shape: a row written the desktop mirror's way projects the same", async () => {
    const w = await world();
    const id = await ingest(w);

    const [ingested] = await owned.db.select().from(messages).where(eq(messages.id, id));
    const [fs] = await owned.db.select().from(folderState).where(eq(folderState.messageId, id));

    // `cloud-mirror.ts` writes `toAddresses: m.to ?? []` / `ccAddresses: m.cc ?? []` /
    // `fromName: m.from?.name ?? null` — the DTO's own values, straight into these columns.
    // Overlaying that write on the ingested row must be a no-op, which is what "one shape" means.
    const mirrored = { ...ingested!, toAddresses: TO, ccAddresses: CC, fromName: ingested!.fromName };
    expect(messageRowToDTO(mirrored, fs, undefined, undefined))
      .toEqual(messageRowToDTO(ingested!, fs, undefined, undefined));
  });
});

describe.skipIf(!AVAILABLE)("Cloud ingest writes the sender's display name the DTO projects (mail 0057)", () => {
  let owned: OwnedDb;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
  }, 180_000);

  afterAll(async () => { await owned?.close().catch(() => {}); });

  async function world(): Promise<{ accountId: string; mailboxId: string }> {
    const accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `fn-${accountId.slice(0, 8)}` });
    const [mb] = await owned.db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: `${accountId}@fn.test` }).returning();
    return { accountId, mailboxId: mb!.id };
  }

  async function ingest(w: { accountId: string; mailboxId: string }, raw: Buffer): Promise<string> {
    const change: Change = { type: "create", locator: { folder: "INBOX", ref: "1:20" }, raw };
    const repo = makeDrizzleRepo(owned.db);
    const plan = await planChange(change, { ...w, repo });
    const res = await owned.db.transaction(async (tx) =>
      commitChange(plan, { storageCap: UNMETERED_STORAGE_CAP, ...w, repo: makeDrizzleRepo(tx as never) }));
    return res.messageId;
  }

  /** A From carrying a display name — including a quoted, encoded-word-free ordinary one. */
  const named = () => Buffer.from([
    `Message-ID: <fromname-${randomUUID()}@papierwerk.example>`,
    'From: "Papierwerk Studio" <hello@papierwerk.example>',
    "To: mila@lichtgrat.example",
    "Subject: Your order shipped",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "On its way.",
  ].join("\r\n"));

  it("stores the parsed display name on the row and projects it as from.name", async () => {
    const w = await world();
    const id = await ingest(w, named());

    // The row half: the name survives drizzle's insert into the text column.
    const [row] = await owned.db.select().from(messages).where(eq(messages.id, id));
    expect(row!.fromName).toBe("Papierwerk Studio");
    expect(row!.fromAddress).toBe("hello@papierwerk.example");

    // The wire half: the projection reassembles the `EmailAddress` pair the parser produced.
    // This used to be `{ name: null, … }` for every message the product ever ingested.
    const dto = await materializeMessage(owned.db, w.accountId, id);
    expect(dto!.from).toEqual({ name: "Papierwerk Studio", address: "hello@papierwerk.example" });
  });

  it("a From with no display name stays NULL on the row and null on the wire", async () => {
    const w = await world();
    const id = await ingest(w, Buffer.from([
      `Message-ID: <noname-${randomUUID()}@bank.example>`,
      "From: partner@bank.example",
      "Subject: Bare address",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "body",
    ].join("\r\n")));

    const [row] = await owned.db.select().from(messages).where(eq(messages.id, id));
    // NULL, not "" — "no name set" and "ingested before 0057" are deliberately the same value,
    // and the reader falls back to the address for both.
    expect(row!.fromName).toBeNull();
    const dto = await materializeMessage(owned.db, w.accountId, id);
    expect(dto!.from).toEqual({ name: null, address: "partner@bank.example" });
  });
});
