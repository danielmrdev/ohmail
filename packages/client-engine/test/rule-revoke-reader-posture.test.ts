import { describe, expect, it } from "vitest";
import { mailboxes } from "@trafficflow/db";
import type { RuleDTO } from "../src/index.js";
import { verbWorld, type VerbWorld } from "./verb-parity/world.js";

/**
 * A RULE REVOKE ON A READER — the real engine over the real route table (PGlite), the postures
 * `planAccountFanOut` decides between. Where nothing organizes the mailbox (released) the door
 * answers 409 organized_elsewhere with `{ by, reason }`; the surface can only say WHY if that
 * reason reaches the result. "Organize here" pressed and the claim not landed yet is WRITTEN here:
 * an edit made during a takeover belongs to the install taking over.
 */

async function worldWithRule(): Promise<{ w: VerbWorld; ruleId: string }> {
  const w = await verbWorld();
  const made = await w.engine.mutate({
    kind: "rule_create", ruleKind: "sender", match: "lena@atelier.example", destination: "ohmail/News",
  });
  expect(made.status).toBe("confirmed");
  const rule = w.store.list<RuleDTO>("rule").find((r) => r.match === "lena@atelier.example");
  expect(rule, "the rule never reached the mirror").toBeDefined();
  return { w, ruleId: rule!.id };
}

/**
 * The world's ONE mailbox, rewritten. No `where`: this package cannot resolve `drizzle-orm`, and
 * each world is its own in-memory database, so the count is asserted instead.
 */
async function setOnlyMailbox(w: VerbWorld, set: Partial<typeof mailboxes.$inferInsert>): Promise<void> {
  const rows = await w.db.select({ id: mailboxes.id }).from(mailboxes);
  expect(rows.map((r) => r.id)).toEqual([w.mailboxId]);
  await w.db.update(mailboxes).set(set);
}

/** Handed back: a reader nothing holds, carrying the release marker. */
async function released(w: VerbWorld): Promise<void> {
  await setOnlyMailbox(w, {
    organizerRole: "reader", organizedByKind: null, organizedByName: null, organizedSince: null,
    organizerState: null, organizedByCapabilities: null,
    organizeConsentedAt: w.clock.now(), organizerReleasedAt: w.clock.now(),
  });
}

/** "Organize here" pressed, the claim not landed: the standing press, still a reader. */
async function starting(w: VerbWorld): Promise<void> {
  await setOnlyMailbox(w, {
    organizerRole: "reader", organizedByKind: null, organizedByName: null, organizedSince: null,
    organizerState: null, organizedByCapabilities: null, organizerReleasedAt: null,
    organizeConsentedAt: w.clock.now(), takeoverAuthorizedAt: w.clock.now(),
  });
}

describe("a revoke where nothing organizes the mailbox is refused, and the refusal says why", () => {
  for (const [label, posture] of [["handed back", released]] as const) {
    it(`${label}: 409 organized_elsewhere, reason no_organizer on the result, the rule still listed`, async () => {
      const { w, ruleId } = await worldWithRule();
      await posture(w);
      const res = await w.engine.mutate({ kind: "rule_delete", ruleId });
      expect(res.status).toBe("rolled_back");
      expect(res.error?.status).toBe(409);
      expect(res.error?.code).toBe("organized_elsewhere");
      // The reason is the fact a sentence turns on; before the fix the adapter dropped it.
      const details = res.error?.details as { reason?: string; by?: { kind: unknown } } | undefined;
      expect(details?.reason).toBe("no_organizer");
      expect(details?.by?.kind ?? null).toBeNull();
      // …and the server's own sentence claims no holder that does not exist.
      expect(res.error?.message).toMatch(/^nothing organizes this mailbox right now/);
      expect(res.error?.message).not.toContain("another install");
      expect(w.store.list<RuleDTO>("rule").map((r) => r.id)).toContain(ruleId);
    });
  }
});

describe("controls: the two postures where a revoke has somewhere to go", () => {
  it("the organizer: confirmed, and the rule is gone", async () => {
    const { w, ruleId } = await worldWithRule();
    const res = await w.engine.mutate({ kind: "rule_delete", ruleId });
    expect(res.status).toBe("confirmed");
    // Server truth: a second engine bootstrapping from nothing.
    const fresh = await w.freshStore();
    expect(fresh.list<RuleDTO>("rule").map((r) => r.id)).not.toContain(ruleId);
  });

  it("organizing not started yet: written here, for the install taking over, and the rule is gone", async () => {
    const { w, ruleId } = await worldWithRule();
    await starting(w);
    const res = await w.engine.mutate({ kind: "rule_delete", ruleId });
    expect(res.status).toBe("confirmed");
    const fresh = await w.freshStore();
    expect(fresh.list<RuleDTO>("rule").map((r) => r.id)).not.toContain(ruleId);
  });

  it("a reader whose holder takes rule requests: awaiting that holder, the rule still listed", async () => {
    const { w, ruleId } = await worldWithRule();
    await setOnlyMailbox(w, {
      organizerRole: "reader", organizerState: "held", organizedByKind: "local",
      organizedByName: "Studio laptop", organizedByCapabilities: "requests,rules",
    });
    const res = await w.engine.mutate({ kind: "rule_delete", ruleId });
    expect(res.status).toBe("awaiting_organizer");
    expect(res.queuedWith?.name).toBe("Studio laptop");
    expect(w.store.list<RuleDTO>("rule").map((r) => r.id)).toContain(ruleId);
  });
});
