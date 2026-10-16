import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, sql } from "drizzle-orm";
import { brandDialect, carryDialect } from "@trafficflow/db/dialect";
import { accounts, mailboxes, messageBodies } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { pgTestUrl } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { planChange, commitChange, UNMETERED_STORAGE_CAP, type Change } from "@trafficflow/core/mail";

/**
 * INGEST WRITES THE SEARCH DOCUMENT through the REAL repository, in the body's own statement —
 * real Postgres, the shipped plan+commit. Below the cap and AT it: a withheld body's message still
 * carries its words, because the document is written from the parsed message.
 */
const PG_URL = pgTestUrl(import.meta.url);
const client = postgres(PG_URL, { max: 2, onnotice: () => {} });
const db = brandDialect(drizzle(client, { schema }), "pg");
const A = randomUUID();
let mailboxId = "";
let uid = 100;

const eml = (id: string, body: string): Buffer => Buffer.from([
  `Message-ID: <${id}@ingest.example>`, "From: Anna Weber <anna@club.example>",
  "To: Claims Desk <claims@axa.example>", "Subject: Quarterly letter",
  "Content-Type: text/plain; charset=utf-8", "", body,
].join("\r\n"));

async function ingest(raw: Buffer, storageCap: number | typeof UNMETERED_STORAGE_CAP): Promise<string> {
  const change: Change = { type: "create", locator: { folder: "INBOX", ref: `1:${++uid}` }, raw, seen: true };
  const repo = makeDrizzleRepo(db as never);
  const plan = await planChange(change, { repo, accountId: A, mailboxId, routing: repo, readerMode: false } as never);
  const res = await db.transaction(async (tx) => {
    const txRepo = makeDrizzleRepo(carryDialect(db, tx as object) as never);
    return commitChange(plan, { repo: txRepo, routing: txRepo, accountId: A, mailboxId, storageCap } as never);
  });
  return (res as { messageId: string }).messageId;
}

const doc = async (id: string): Promise<{ terms: string; source: string; words: boolean } | undefined> => {
  const rows = await db.execute(sql`select terms, source, text_tsv @@ websearch_to_tsquery('english', 'marzipan') as words
    from message_search where message_id = ${id}`) as unknown as Array<{ terms: string; source: string; words: boolean }>;
  return rows[0];
};

describe("ingest writes the search document with the body (real Postgres)", () => {
  beforeAll(async () => {
    await runMigrations(PG_URL);
    // The cap's reserve is counted against the account's own row.
    await db.insert(accounts).values({ id: A, name: `ingest-${A.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({ accountId: A, provider: "imap", address: "ingest@tf.example" }).returning();
    mailboxId = mb!.id;
  });

  afterAll(async () => {
    for (const t of ["message_search", "attachments", "routing_decisions", "message_instances", "change_log", "account_storage", "account_sync_state"]) {
      await db.execute(sql.raw(`delete from ${t} where ${t === "message_instances" ? "message_id in (select id from messages where account_id = '" + A + "')" : "account_id = '" + A + "'"}`));
    }
    await db.execute(sql`delete from folder_state where message_id in (select id from messages where account_id = ${A})`);
    await db.execute(sql`delete from message_bodies where message_id in (select id from messages where account_id = ${A})`);
    await db.execute(sql`delete from messages where account_id = ${A}`);
    await db.execute(sql`delete from threads where account_id = ${A}`);
    await db.execute(sql`delete from mailboxes where account_id = ${A}`);
    await db.execute(sql`delete from accounts where id = ${A}`);
    await client.end({ timeout: 5 });
  });

  it("an ordinary message: its document holds the recipients and the body's words", async () => {
    const id = await ingest(eml(randomUUID(), "the marzipan order is ready"), UNMETERED_STORAGE_CAP);
    const d = await doc(id);
    expect(d?.source).toBe("text");
    expect(d?.words).toBe(true);
    expect(d?.terms).toContain("claims@axa.example");
  });

  it("AT THE CAP: the body is withheld, the document still carries the words", async () => {
    // The account already stands far past a 10-byte cap, so the arriving body cannot be made room
    // for and is withheld — the cap's hard edge.
    await db.execute(sql`insert into account_storage (account_id, bytes) values (${A}, 100000)
      on conflict (account_id) do update set bytes = 100000`);
    const id = await ingest(eml(randomUUID(), "the marzipan invoice is attached"), 10);
    const [body] = await db.select({ w: messageBodies.withheldReason, t: messageBodies.text })
      .from(messageBodies).where(eq(messageBodies.messageId, id));
    expect(body?.w).toBe("storage_cap");
    expect(body?.t).toBe("");
    expect((await doc(id))?.words).toBe(true);
  });
});
