import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, mailboxes } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import {
  clearOrganizerStandDown, markMailboxStoodDown, type OneShotsAsRead,
} from "../src/mailboxes.js";

/**
 * AN ORGANIZER EVENT IS A CHANGE OF ROLE, NEVER A STATEMENT RUN AGAIN. The notice is
 * `organizer_event_at > organizer_event_seen_at`; a promotion of a row that is ALREADY the
 * organizer changes nothing a person was told, so it must not move the stamp — or a "Mark read"
 * pressed in between comes back. Reachable: a press landing while the gate promotes stays
 * standing (the promotion spends only the stamp it read) and the next cycle promotes again.
 * Real Postgres: the arms turn on one statement reading a value another writer committed.
 */

const AVAILABLE = await realPgAvailable();

const READ_AT = new Date("2026-09-29T09:00:00.000Z");
const PRESSED_DURING = new Date("2026-09-29T09:00:30.000Z");
const PROMOTED_AT = new Date("2026-09-29T09:01:00.000Z");
const DISMISSED_AT = new Date("2026-09-29T09:01:20.000Z");
const NEXT_CYCLE = new Date("2026-09-29T09:02:00.000Z");

describe.skipIf(!AVAILABLE)("the promotion stamps the organizer event only on a flip", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);

  const seed = async (values: {
    organizerRole: "organizer" | "reader"; takeoverAuthorizedAt?: Date | null;
  }): Promise<string> => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `flip-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `flip-${accountId.slice(0, 8)}@example.test`,
      organizeConsentedAt: READ_AT, ...values,
    }).returning();
    return mb!.id;
  };

  const rowOf = async (id: string) => {
    const [r] = await db.select({
      organizerRole: mailboxes.organizerRole,
      releaseRequestedAt: mailboxes.releaseRequestedAt,
      takeoverAuthorizedAt: mailboxes.takeoverAuthorizedAt,
      eventAt: mailboxes.organizerEventAt,
      seenAt: mailboxes.organizerEventSeenAt,
    }).from(mailboxes).where(eq(mailboxes.id, id));
    return r!;
  };

  /** `MailboxService.dismissOrganizerNotice`'s one statement: the acknowledgement instant. */
  const dismiss = async (id: string, at: Date): Promise<void> => {
    await db.update(mailboxes).set({ organizerEventSeenAt: at }).where(eq(mailboxes.id, id));
  };

  /** The shared shell's predicate (`organizerNotices`): an event newer than its acknowledgement. */
  const noticeStands = (r: { eventAt: Date | null; seenAt: Date | null }): boolean =>
    r.eventAt !== null && (r.seenAt === null || r.eventAt.getTime() > r.seenAt.getTime());

  it("POSITIVE CONTROL: promoting a reader stamps the event", async () => {
    const id = await seed({ organizerRole: "reader", takeoverAuthorizedAt: READ_AT });
    const asRead: OneShotsAsRead = await rowOf(id);
    expect(await clearOrganizerStandDown(db as never, id, { now: PROMOTED_AT, asRead })).toBe(true);
    const r = await rowOf(id);
    expect(r.organizerRole).toBe("organizer");
    expect(r.eventAt?.toISOString(), "a real flip must stamp — the other door reads `elsewhere` off it")
      .toBe(PROMOTED_AT.toISOString());
  });

  it("promoting a row that is already the organizer leaves the stamp, so a dismissal holds", async () => {
    const id = await seed({ organizerRole: "reader", takeoverAuthorizedAt: READ_AT });
    await clearOrganizerStandDown(db as never, id, { now: PROMOTED_AT, asRead: await rowOf(id) });
    await dismiss(id, DISMISSED_AT);
    expect(noticeStands(await rowOf(id)), "the dismissal did not take").toBe(false);

    await clearOrganizerStandDown(db as never, id, { now: NEXT_CYCLE, asRead: await rowOf(id) });
    const r = await rowOf(id);
    expect(r.eventAt?.toISOString(), "a promotion that flipped nothing moved the event")
      .toBe(PROMOTED_AT.toISOString());
    expect(noticeStands(r), "the dismissed notice came back").toBe(false);
  });

  it("an 'Organize here' landing during the gate re-promotes next cycle without re-raising", async () => {
    const id = await seed({ organizerRole: "reader", takeoverAuthorizedAt: READ_AT });
    const asRead: OneShotsAsRead = await rowOf(id);
    await db.update(mailboxes).set({ takeoverAuthorizedAt: PRESSED_DURING }).where(eq(mailboxes.id, id));
    await clearOrganizerStandDown(db as never, id, { now: PROMOTED_AT, asRead });
    const between = await rowOf(id);
    expect(between.organizerRole).toBe("organizer");
    expect(between.takeoverAuthorizedAt?.toISOString(), "the fixture needs the newer press standing")
      .toBe(PRESSED_DURING.toISOString());

    await dismiss(id, DISMISSED_AT);
    // The gate's next cycle sees the standing press (`index.ts`, `lease.takeoverAuthorizedAt`).
    await clearOrganizerStandDown(db as never, id, { now: NEXT_CYCLE, asRead: await rowOf(id) });
    const r = await rowOf(id);
    expect(r.takeoverAuthorizedAt, "the second promotion must still spend the press").toBeNull();
    expect(noticeStands(r), "Mark read did not stick: the re-promotion re-raised the notice").toBe(false);
  });

  it("POSITIVE CONTROL: the demotion still stamps, so the other install reads `elsewhere`", async () => {
    const id = await seed({ organizerRole: "organizer" });
    await dismiss(id, DISMISSED_AT);
    await markMailboxStoodDown(db as never, id, "organized_elsewhere:local", {
      now: NEXT_CYCLE, asRead: await rowOf(id),
      by: { installId: "laptop-7", kind: "local", displayName: "kitchen mac", state: "held" },
    });
    expect(noticeStands(await rowOf(id)), "a demotion is news and must raise the notice").toBe(true);
  });

  // ── THE STAND-DOWN, ON THE SAME RULE (REVIEW-026 L1) ─────────────────────────────────────
  const KITCHEN = { installId: "laptop-7", kind: "local" as const, displayName: "kitchen mac", state: "held" as const };
  const seedReaderOf = async (): Promise<string> => {
    const id = await seed({ organizerRole: "reader" });
    await db.update(mailboxes).set({
      organizedByKind: "local", organizedByInstallId: "laptop-7", organizedByName: "kitchen mac",
      organizerState: "held", organizerEventAt: PROMOTED_AT,
    }).where(eq(mailboxes.id, id));
    await dismiss(id, DISMISSED_AT);
    return id;
  };

  it("a stand-down of a row already reading the SAME holder leaves the event: the dismissal holds", async () => {
    const id = await seedReaderOf();
    expect(noticeStands(await rowOf(id)), "the fixture's dismissal did not take").toBe(false);
    await markMailboxStoodDown(db as never, id, "organized_elsewhere:local", {
      now: NEXT_CYCLE, asRead: await rowOf(id), by: KITCHEN,
    });
    const r = await rowOf(id);
    expect(r.eventAt?.toISOString(), "a stand-down that changed nothing moved the event").toBe(PROMOTED_AT.toISOString());
    expect(noticeStands(r), "the dismissed 'elsewhere' came back about nothing").toBe(false);
  });

  it("POSITIVE CONTROL: a stand-down to a holder whose state CHANGED stamps, and the notice shows again", async () => {
    const id = await seedReaderOf();
    await markMailboxStoodDown(db as never, id, "organized_elsewhere:local", {
      now: NEXT_CYCLE, asRead: await rowOf(id), by: { ...KITCHEN, state: "stopped" },
    });
    expect(noticeStands(await rowOf(id)), "the holder stopped and nothing said so").toBe(true);
  });

  it("POSITIVE CONTROL: a stand-down to ANOTHER holder stamps", async () => {
    const id = await seedReaderOf();
    await markMailboxStoodDown(db as never, id, "organized_elsewhere:local", {
      now: NEXT_CYCLE, asRead: await rowOf(id), by: { ...KITCHEN, installId: "office-2", displayName: "office linux" },
    });
    expect(noticeStands(await rowOf(id))).toBe(true);
  });
});
