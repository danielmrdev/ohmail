import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import {
  accounts, auditLog, mailboxes, rules, tags,
  PROFILE_IMPORT_RESOLVED_AUDIT_ACTION,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  makeProfileDoc, profileFingerprint,
  type OrganizerProfileDoc, type ProfileReadResult,
} from "@trafficflow/core/adapters/organizer-profile";
import { profileImportService, type ServiceContext } from "@trafficflow/services";

/**
 * THE APPLY UNDER A REAL POOL — the one claim PGlite structurally cannot check.
 *
 * PGlite is a single-connection Postgres: it serializes everything, so the apply's per-account
 * advisory lock behaves identically whether it is held or missing, and the race it exists to
 * remove never reproduces. The race is the merge's read-then-act: two tabs answering the same
 * card each read "no rule under this key yet" and each insert — a duplicate rule under one
 * natural key, which is the destination coin toss the merge rule exists to prevent. So the
 * property is asserted here, against a pool wide enough to actually race, or it is asserted
 * nowhere: EIGHT concurrent applies of one document leave the store exactly as ONE apply would.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId,
  userId: null,
  now: () => new Date(),
  requestId: `pfi-pg-${randomUUID().slice(0, 8)}`,
} as unknown as ServiceContext);

/**
 * DELIBERATELY NO SCREENER SECTION. A document with one would hide the race this file exists to
 * see: all eight applies upsert the same (account, address) contact row FIRST, and the loser
 * transactions block on that row's unique-conflict lock until the winner commits — an accidental
 * per-account mutex that serializes everything after it. Measured: with a screener entry present,
 * removing the advisory lock left this test green. Rules-and-tags-only is the shape whose first
 * write is the read-then-insert the lock guards.
 */
const DOC: OrganizerProfileDoc = makeProfileDoc({
  screener: [],
  rules: [
    {
      kind: "sender", match: "anna@example.com", destination: "ohmail/News",
      priority: 0, enabled: true, provenance: "promoted",
    },
    {
      kind: "domain", match: "shop.example", destination: "ohmail/Receipts",
      priority: 0, enabled: true, provenance: "manual",
    },
  ],
  notifyRules: [{ kind: "sender", target: "boss@example.com" }],
  awayResponder: null,
  tagNames: ["Invoices"],
  signature: null,
}, { updatedAt: new Date("2026-08-10T09:00:00.000Z"), producer: { kind: "local", version: "0.9.3" } });

const read = async (): Promise<ProfileReadResult> =>
  ({ state: "found", doc: DOC, installId: "elsewhere", ref: 1, residue: 0, generation: 1_000 });

describe.skipIf(!PG_UP)("profile import — the concurrency PGlite cannot see", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 8, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("EIGHT concurrent applies of one document leave the store exactly as one would", async () => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `pfi-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `pfi-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    const fingerprint = profileFingerprint(DOC);

    // All eight from separate pool connections. Without the per-account advisory lock, several
    // read "no rule under this key" before any insert lands, and the account ends up with
    // duplicate rules under one natural key.
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      profileImportService.apply(ctx(accountId), mb!.id, { fingerprint }, { read }),
    ));
    expect(results).toHaveLength(8);

    const storedRules = await db.select().from(rules).where(eq(rules.accountId, accountId));
    expect(storedRules, "one rule per natural key, however many confirmations raced").toHaveLength(2);
    expect(new Set(storedRules.map((r) => `${r.kind} ${r.match}`)).size).toBe(2);

    const storedTags = await db.select().from(tags).where(eq(tags.accountId, accountId));
    expect(storedTags.map((t) => t.name)).toEqual(["Invoices"]);

    // One durable answer, not eight: the serialized transactions each see the winner's row.
    const resolutions = await db.select().from(auditLog).where(and(
      eq(auditLog.accountId, accountId), eq(auditLog.action, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION),
    ));
    expect(resolutions).toHaveLength(1);
  }, 60_000);

  it("declined, then EIGHT concurrent replaces: two rows, one per decision", async () => {
    // The replace's write-once check and its insert are one step only under the same advisory
    // lock; racing them from separate connections is the case a single-connection store hides.
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `pfr-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `pfr-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    const fingerprint = profileFingerprint(DOC);

    await profileImportService.decline(ctx(accountId), mb!.id, { fingerprint });
    await Promise.all(Array.from({ length: 8 }, () =>
      profileImportService.replace(ctx(accountId), mb!.id, { fingerprint }),
    ));

    const resolutions = await db.select().from(auditLog).where(and(
      eq(auditLog.accountId, accountId), eq(auditLog.action, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION),
    ));
    expect(resolutions.map((r) => (r.payload as { decision: string }).decision).sort())
      .toEqual(["declined", "replaced"]);
    // Nothing was applied by either answer.
    expect(await db.select().from(rules).where(eq(rules.accountId, accountId))).toHaveLength(0);
  }, 60_000);
});
