import { describe, it, expect } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { accounts, approvals, graduations, routingDecisions, rules } from "@trafficflow/db";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ApprovalService, LearningService, GRADUATION_THRESHOLD, RulesService, ServiceError } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * A PERSON DECIDES THE SENDER (the "No silent AI actions" invariant: graduation is earned and undoable). A learned route is a
 * rule a person can see, pause and remove; a person's pause or removal under the sender's key ends
 * every graduation of that sender, in every place, from zero; while their decision stands nothing
 * learned acts for the sender. Driven through the approval card itself and the pipeline's own read.
 */
const learning = new LearningService();
const rulesSvc = new RulesService();
const ADDR = "a@b.example";
const NEWS = "ohmail/News";
const RECEIPTS = "ohmail/Receipts";
const key = (dest: string): string => `sender:${ADDR}→${dest}`;
type World = Awaited<ReturnType<typeof makeCtx>>;

let n = 0;
/** `times` approvals of the sender into `dest`, then the promotion pass (the graduation driver). */
async function approve(w: World, dest: string, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await learning.record(w.ctx, { triggeringActionId: `p:${n++}`, kind: "approval", senderAddress: ADDR, destination: dest, label: "positive" });
  }
  await learning.promoteOrDemote(w.ctx, key(dest));
}

/** One pending routing card for a message from the sender, as the pipeline enqueues it. */
async function card(w: World, dest: string): Promise<string> {
  const messageId = await seedMessage(w.db, w.accountId, w.mailboxId, { from: ADDR, folder: "INBOX", desired: "INBOX" });
  const [rd] = await w.db.insert(routingDecisions).values({
    accountId: w.accountId, messageId, inputProvenance: "ai", destination: dest, confidence: 0.6, status: "pending_approval",
  }).returning();
  const [a] = await w.db.insert(approvals).values({
    accountId: w.accountId, kind: "routing", messageId, routingDecisionId: rd!.id, action: "move",
    summary: `Route to ${dest}`, payload: { folder: dest }, confidence: 0.6, status: "pending",
  }).returning();
  return a!.id;
}

const rowsOf = async (w: World) => (await w.db.select().from(rules)
  .where(and(eq(rules.accountId, w.accountId), eq(rules.kind, "sender"))).orderBy(asc(rules.createdAt), asc(rules.id)))
  .map((r) => ({ destination: r.destination, enabled: r.enabled, provenance: r.provenance, stamped: r.personDecidedAt !== null }));
const flagOf = async (w: World, dest: string): Promise<boolean | null> => (await w.db.select({ g: graduations.graduated })
  .from(graduations).where(and(eq(graduations.accountId, w.accountId), eq(graduations.patternKey, key(dest)))))[0]?.g ?? null;
/** The pipeline's own question (`RoutingPort.isGraduated`), asked of the repo it runs on. */
const pipelineFiles = (w: World, dest: string): Promise<boolean> =>
  makeDrizzleRepo(w.db as never).isGraduated(w.accountId, key(dest), "route");

describe("a person decides the sender: what is learned is a rule they can see, and their decision ends it everywhere", () => {
  it("three approvals on the card write one learned rule, and two write none", async () => {
    const w = await makeCtx();
    const svc = new ApprovalService({});
    for (let i = 0; i < GRADUATION_THRESHOLD; i++) {
      expect(await rowsOf(w), `a rule before approval ${i + 1}`).toEqual([]);
      await svc.decide(w.ctx, await card(w, RECEIPTS), { decision: "approve" });
    }
    expect(await rowsOf(w), "the approvals graduated the sender and no rule shows it").toEqual([
      { destination: RECEIPTS, enabled: true, provenance: "promoted", stamped: false },
    ]);
  });

  it("removing a rule two graduations wrote ends both places: one approval to the first writes nothing", async () => {
    const w = await makeCtx();
    await approve(w, RECEIPTS, GRADUATION_THRESHOLD);
    await approve(w, NEWS, GRADUATION_THRESHOLD);
    const [learned] = await w.db.select({ id: rules.id }).from(rules).where(eq(rules.accountId, w.accountId));
    expect(await rowsOf(w)).toEqual([{ destination: NEWS, enabled: true, provenance: "promoted", stamped: false }]);
    await rulesSvc.remove(w.ctx, learned!.id);
    await approve(w, RECEIPTS, 1);
    expect(await rowsOf(w), "one approval brought the removed rule back").toEqual([]);
    expect(await pipelineFiles(w, RECEIPTS), "the first place still files the sender by itself").toBe(false);
    await approve(w, RECEIPTS, GRADUATION_THRESHOLD - 1);
    expect(await rowsOf(w), "the full count again writes one rule").toEqual([
      { destination: RECEIPTS, enabled: true, provenance: "promoted", stamped: false },
    ]);
  });

  it("pausing it ends both places too, and approvals after the pause write nothing", async () => {
    const w = await makeCtx();
    await approve(w, RECEIPTS, GRADUATION_THRESHOLD);
    await approve(w, NEWS, GRADUATION_THRESHOLD);
    const [learned] = await w.db.select({ id: rules.id }).from(rules).where(eq(rules.accountId, w.accountId));
    await rulesSvc.update(w.ctx, learned!.id, { enabled: false } as never);
    expect(await learning.isGraduated(w.ctx, key(RECEIPTS)), "the first place is still learned").toBe(false);
    expect(await pipelineFiles(w, RECEIPTS), "the pipeline still files the sender to the first place").toBe(false);
    expect(await pipelineFiles(w, NEWS)).toBe(false);
    const paused = [{ destination: NEWS, enabled: false, provenance: "promoted", stamped: true }];
    expect(await rowsOf(w)).toEqual(paused);
    await approve(w, RECEIPTS, GRADUATION_THRESHOLD);
    expect(await rowsOf(w), "a graduation wrote over the person's pause").toEqual(paused);
    // The counter may flip again; under a standing decision the flag is inert at the one read.
    expect(await flagOf(w, RECEIPTS)).toBe(true);
    expect(await pipelineFiles(w, RECEIPTS), "a flag under the person's pause is read as learned").toBe(false);
  });

  it("a demotion for an erased account answers 410 account_erased, as the fenced seam does", async () => {
    const w = await makeCtx();
    await w.db.insert(accounts).values({ id: w.accountId, name: "erased", erasedAt: new Date("2026-07-28T11:00:00Z") });
    await w.db.insert(graduations).values({ accountId: w.accountId, patternKey: key(NEWS), action: "route", positives: 0, negatives: 5, graduated: false });
    const err = await learning.promoteOrDemote(w.ctx, key(NEWS)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect([(err as ServiceError).code, (err as ServiceError).httpStatus]).toEqual(["account_erased", 410]);
  });
});
