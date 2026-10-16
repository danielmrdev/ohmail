import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { approvals, graduations, learningSignals, routingDecisions, rules } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { TEST_DIALECT_ENV } from "@trafficflow/db/testing";
import { ApprovalService, GRADUATION_THRESHOLD } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * THE ALLOWS THE SHIPPED "NOT JUNK, ALWAYS ALLOW" WROTE, through mail 0144 and then three approval
 * cards. Each shape had a Screener decision the allow overrode (a spam verdict into Quarantine, a
 * screen-out into Screened by the act or a person), some after ohmail had once let the sender in;
 * 0144 makes the allow the person's own rule, so the approvals graduate the sender and write
 * nothing over it. A learned retarget of the person's spam row stays ohmail's. The store's own
 * 0144 file runs.
 */
const FILE = process.env[TEST_DIALECT_ENV] === "sqlite"
  ? "../../db-mail/drizzle-sqlite/0144_rule_person_decided_backfill.sql"
  : "../../db-mail/drizzle/0144_rule_person_decided_backfill.sql";
const STATEMENTS = readFileSync(fileURLToPath(new URL(FILE, import.meta.url)), "utf8")
  .split("--> statement-breakpoint").map((s) => s.replace(/^\s*--[^\n]*$/gm, "").trim()).filter(Boolean);
const ADDR = "lena@atelier.example";
const RECEIPTS = "ohmail/Receipts";
type World = Awaited<ReturnType<typeof makeCtx>>;

async function signal(w: World, destination: string, by: "person" | "act", createdAt?: Date): Promise<void> {
  await w.db.insert(learningSignals).values({
    accountId: w.accountId, triggeringActionId: `${by === "act" ? "screener:auto:" : "screener:"}${randomUUID()}`,
    kind: "screener", senderAddress: ADDR, destination, label: "positive", ...(createdAt ? { createdAt } : {}),
  });
}
const ADMIT = new Date("2026-09-10T10:00:00.000Z");
const OUT = new Date("2026-09-20T10:00:00.000Z");
/** ohmail's admit moved to Quarantine and the person's spam row, both switched off by the allow. */
async function spamOverAnAdmit(w: World, admit: "act" | "learned"): Promise<void> {
  await w.db.insert(rules).values({ accountId: w.accountId, kind: "sender", match: ADDR, destination: "ohmail/Quarantine", enabled: false, provenance: "promoted", createdAt: ADMIT });
  if (admit === "act") await signal(w, "INBOX", "act", ADMIT);
  else await w.db.insert(graduations).values({ accountId: w.accountId, patternKey: `sender:${ADDR}→INBOX`, action: "route", positives: 3, negatives: 0, graduated: true, graduatedAt: ADMIT });
  await w.db.insert(rules).values({ accountId: w.accountId, kind: "sender", match: ADDR, destination: "ohmail/Quarantine", enabled: false, provenance: "promoted", createdAt: OUT });
  await signal(w, "ohmail/Quarantine", "person", OUT);
}

/** The three histories, each as the shipped allow left it: an unstamped promoted INBOX row. */
const SHAPES: Record<string, (w: World) => Promise<void>> = {
  "a spam verdict the allow switched off": async (w) => {
    await w.db.insert(rules).values({ accountId: w.accountId, kind: "sender", match: ADDR, destination: "ohmail/Quarantine", enabled: false, provenance: "promoted" });
    await signal(w, "ohmail/Quarantine", "person");
  },
  "the act's screen-out the allow converged onto": async (w) => { await signal(w, "ohmail/Screened", "act"); },
  "a person's screen-out the allow converged onto": async (w) => { await signal(w, "ohmail/Screened", "person"); },
  "the act's old admit, the person's spam, then the allow's own row": (w) => spamOverAnAdmit(w, "act"),
  "a learned admit, the person's spam, then the allow's own row": (w) => spamOverAnAdmit(w, "learned"),
};

async function migrate(w: World): Promise<void> {
  const d = dialect(w.db);
  for (const s of STATEMENTS) await d.exec(w.db, sql.raw(s));
}

/** The shape, then the allow's own INBOX row (created now, after every signal), then 0144. */
async function shipped(shape: string): Promise<World> {
  const w = await makeCtx();
  await SHAPES[shape]!(w);
  await w.db.insert(rules).values({ accountId: w.accountId, kind: "sender", match: ADDR, destination: "INBOX", enabled: true, provenance: "promoted" });
  await migrate(w);
  return w;
}

async function approveIntoReceipts(w: World): Promise<void> {
  const svc = new ApprovalService({});
  for (let i = 0; i < GRADUATION_THRESHOLD; i++) {
    const messageId = await seedMessage(w.db, w.accountId, w.mailboxId, { from: ADDR, folder: "INBOX", desired: "INBOX" });
    const [rd] = await w.db.insert(routingDecisions).values({
      accountId: w.accountId, messageId, inputProvenance: "ai", destination: RECEIPTS, confidence: 0.6, status: "pending_approval",
    }).returning();
    const [card] = await w.db.insert(approvals).values({
      accountId: w.accountId, kind: "routing", messageId, routingDecisionId: rd!.id, action: "move",
      summary: `Route to ${RECEIPTS}`, payload: { folder: RECEIPTS }, confidence: 0.6, status: "pending",
    }).returning();
    await svc.decide(w.ctx, card!.id, { decision: "approve" });
  }
}

const allowOf = async (w: World) => (await w.db.select().from(rules)
  .where(and(eq(rules.accountId, w.accountId), eq(rules.kind, "sender"), eq(rules.enabled, true))).orderBy(asc(rules.id)))
  .map((r) => ({ destination: r.destination, provenance: r.provenance, stamped: r.personDecidedAt !== null }));

describe("the shipped Not junk, always allow, after mail 0144 and three approvals", () => {
  for (const shape of Object.keys(SHAPES)) {
    it(`${shape}: the allow is the person's, and three approvals into Receipts leave it`, async () => {
      const w = await shipped(shape);
      const mine = [{ destination: "INBOX", provenance: "manual", stamped: true }];
      expect(await allowOf(w), "0144 left the allow an inference").toEqual(mine);
      await approveIntoReceipts(w);
      expect(await allowOf(w), "the approvals retargeted the person's allow").toEqual(mine);
    });
  }

  it("CONTROL: a learned retarget of the person's spam row keeps its creation, and stays ohmail's", async () => {
    const w = await makeCtx();
    await w.db.insert(graduations).values({ accountId: w.accountId, patternKey: `sender:${ADDR}→INBOX`, action: "route", positives: 3, negatives: 0, graduated: true, graduatedAt: ADMIT });
    await w.db.insert(rules).values({ accountId: w.accountId, kind: "sender", match: ADDR, destination: "INBOX", enabled: true, provenance: "promoted", createdAt: OUT });
    await signal(w, "ohmail/Quarantine", "person", OUT);
    await migrate(w);
    expect(await allowOf(w), "0144 stamped a row the learning retargeted").toEqual([{ destination: "INBOX", provenance: "promoted", stamped: false }]);
    await approveIntoReceipts(w);
    expect(await allowOf(w), "the approvals did not move ohmail's row, which is theirs to move").toEqual([{ destination: RECEIPTS, provenance: "promoted", stamped: false }]);
  });
});
