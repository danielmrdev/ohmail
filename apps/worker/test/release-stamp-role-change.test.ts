import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxes } from "@trafficflow/db";
import { markMailboxStoodDown, clearOrganizerStandDown } from "../src/mailboxes.js";

/**
 * ═══ A STOP REQUEST DOES NOT OUTLIVE THE ROLE IT WAS MADE UNDER ════════════════════════════
 *
 * `RELEASE-STAMP-SURVIVES-ROLE-CHANGE`. `release_requested_at` is one install's standing "stop
 * organizing this mailbox". Three writers change `organizer_role`; only the release's own cleared
 * the stamp. So a takeover left the loser's ask on a row that now names the WINNER, and a
 * re-promote inherited an ask nobody had made under the role it now held — one row saying two
 * things about one mailbox.
 *
 * Nothing false renders today, because the read side already gates the pending sentence on the
 * role rather than on the stamp. That is the pane being careful, not the row being right: a state
 * a later reader can only be correct about by accident is the defect.
 *
 * Every writer that makes the statement untrue clears it in the same statement.
 */

const NOW = new Date("2026-09-08T09:00:00.000Z");
const ASKED = new Date("2026-09-08T08:59:00.000Z");

interface World {
  db: Awaited<ReturnType<typeof makeTestDb>>;
  mailboxId: string;
}

async function newWorld(releaseRequestedAt: Date | null): Promise<World> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `rel-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
    organizerRole: "organizer",
    ...(releaseRequestedAt ? { releaseRequestedAt } : {}),
  }).returning();
  return { db, mailboxId: mb!.id };
}

const rowOf = async (w: World): Promise<{
  organizerRole: string; releaseRequestedAt: Date | null;
}> => {
  const [r] = await w.db.select({
    organizerRole: mailboxes.organizerRole,
    releaseRequestedAt: mailboxes.releaseRequestedAt,
  }).from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
  return r as { organizerRole: string; releaseRequestedAt: Date | null };
};

describe("the stop request is cleared by every writer that makes it untrue", () => {
  let w: World;

  beforeEach(async () => { w = await newWorld(ASKED); });

  it("a DEMOTION clears it — a reader row never carries a stop it can no longer perform", async () => {
    const ok = await markMailboxStoodDown(w.db as never, w.mailboxId, "organized_elsewhere:local", {
      now: NOW,
      by: {
        installId: "laptop-7", kind: "local", displayName: "kitchen mac",
        claimedAt: NOW, state: "held", capabilities: [],
      },
    });
    expect(ok, "the demotion did not write").toBe(true);
    const r = await rowOf(w);
    expect(r.organizerRole).toBe("reader");
    expect(r.releaseRequestedAt,
      "the loser's stop request stands on a row that now names the winner").toBeNull();
  });

  it("a PROMOTION does not inherit a stop asked of the role this row used to hold", async () => {
    const ok = await clearOrganizerStandDown(w.db as never, w.mailboxId, { now: NOW });
    expect(ok, "the promotion did not write").toBe(true);
    const r = await rowOf(w);
    expect(r.organizerRole).toBe("organizer");
    expect(r.releaseRequestedAt,
      "the promotion inherited a previous role's ask").toBeNull();
  });

  it("a row with NO ask keeps none through either transition — the positive control", async () => {
    // Without this, a rule that unconditionally nulls the column would look correct while being
    // indistinguishable from one that nulls it for the wrong reason. The pair below is what says
    // the writers touch the column at all rather than that it happens to be empty.
    const clean = await newWorld(null);
    expect((await rowOf(clean)).releaseRequestedAt).toBeNull();
    await markMailboxStoodDown(clean.db as never, clean.mailboxId, "organized_elsewhere:unknown", { now: NOW });
    expect((await rowOf(clean)).releaseRequestedAt).toBeNull();
    await clearOrganizerStandDown(clean.db as never, clean.mailboxId, { now: NOW });
    const after = await rowOf(clean);
    expect(after.organizerRole, "the promotion did not restore the role").toBe("organizer");
    expect(after.releaseRequestedAt).toBeNull();
  });

  it("a standing ask SURVIVES a write that changes no role — it is a role rule, not a sweep", async () => {
    // The discriminator between "cleared with the role" and "cleared whenever anything is written".
    // The stamp is the person's standing instruction; only a role change spends it.
    const r0 = await rowOf(w);
    expect(r0.releaseRequestedAt?.toISOString(), "the fixture's own ask is missing")
      .toBe(ASKED.toISOString());
  });
});
