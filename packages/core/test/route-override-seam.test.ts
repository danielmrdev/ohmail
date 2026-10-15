import { describe, it, expect } from "vitest";
import { planChange, commitChange, UNMETERED_STORAGE_CAP } from "../src/pipeline.js";
import type { PlanDeps } from "../src/pipeline.js";
import { FakeRepo, FakeRouting } from "./fakes.js";
import type {
  Change, ExternalOverrideInput, ExternalOverrideOutcome, RoutingPort,
} from "../src/ports.js";
import type { Rule } from "../src/rules.js";

/**
 * THE OVERRIDE SEAM — the pipeline arm where a person's hand reaches the route that filed it.
 *
 * The predicate itself is proved against real Postgres (`packages/db/test/route-override.pg.test.ts`).
 * What this file proves is the half a predicate test structurally cannot: that the production
 * ingest path REACHES it, with the right operands, and that a demotion it owes leaves the commit
 * as `owedDemotions` — the switch-off and its rule delta run after the commit, through one door
 * (the worker's `runOwedDemotions`), so this transaction writes no rule and files no rule delta.
 */

const ACCOUNT = "acct-1";
const SENDER = "digest@anchor.example";
const OWNER = "owner@example.test";
const READS = "ohmail/News";

/**
 * The route under contradiction. It has to be a real rule, because `filedTo` is the folder the
 * ROUTE chose — `folder_state.desired_folder` — and not the folder the message physically sat
 * in. Without a rule this sender is first contact, the organizer's own desire is the Screener,
 * and the seam is asked about a route that never existed: measured, and it is the right operand
 * (the pattern key a graduated route is stored under names its DESTINATION).
 */
const readsRule: Rule = {
  id: "rule-reads", kind: "sender", match: SENDER,
  destination: READS, effect: "allow", priority: 0,
  provenance: "promoted", enabled: true, subjectContains: null, bodyContains: null,
};

function eml(messageId: string): Buffer {
  return Buffer.from([
    `Message-ID: <${messageId}>`,
    `From: Anchor Digest <${SENDER}>`,
    `To: ${OWNER}`,
    "Subject: Field report",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "The winter build is out.",
  ].join("\r\n"));
}

const create = (folder: string, raw: Buffer, ref: string): Change =>
  ({ type: "create", locator: { folder, ref }, raw, seen: false });
/** A CORRELATED move — the only evidence `permitsAdoption` accepts. */
const moved = (folder: string, raw: Buffer, ref: string): Change =>
  ({ type: "move", locator: { folder, ref }, raw, seen: false });

/**
 * A routing port that records what the seam asked it, and answers what the case dictates.
 *
 * Deliberately NOT a stub that always answers an outcome: `null` is the answer for every
 * ordinary adoption, and a double that cannot produce it would let the delta arm pass without
 * ever having a case where no delta is owed.
 */
class RecordingRouting extends FakeRouting implements RoutingPort {
  asked: ExternalOverrideInput[] = [];
  answer: ExternalOverrideOutcome | null = null;

  async recordExternalOverride(
    input: ExternalOverrideInput,
  ): Promise<ExternalOverrideOutcome | null> {
    this.asked.push(input);
    return this.answer;
  }
}

function deps(repo: FakeRepo, routing?: RoutingPort): PlanDeps {
  return { repo, accountId: ACCOUNT, mailboxId: "mb-1", readerMode: false, ...(routing ? { routing } : {}) };
}

async function ingest(change: Change, repo: FakeRepo, routing?: RoutingPort) {
  const plan = await planChange(change, deps(repo, routing));
  return commitChange(plan, {
    storageCap: UNMETERED_STORAGE_CAP,
    repo, accountId: ACCOUNT, mailboxId: "mb-1", ...(routing ? { routing } : {}),
  });
}

/** Let the route file a message to `READS`, then have the person drag it to `INBOX`. */
async function fileThenDrag(repo: FakeRepo, routing?: RoutingPort) {
  repo.rules = [readsRule];
  const raw = eml(`override-${Math.random().toString(36).slice(2)}@example.com`);
  const first = await ingest(create(READS, raw, "1:10"), repo, routing);
  const before = repo.changes.length;
  const seen = await ingest(moved("INBOX", raw, "9:10"), repo, routing);
  return { messageId: first.messageId, seen, changesAfter: repo.changes.slice(before) };
}

describe("the adoption arm feeds the override", () => {
  it("asks with the folder the route FILED it into, the folder the person chose, and the adoption's own seq", async () => {
    const repo = new FakeRepo();
    const routing = new RecordingRouting();
    const { messageId, seen, changesAfter } = await fileThenDrag(repo, routing);

    expect(seen.action).toEqual({ type: "adopt_external", newDesired: "INBOX" });
    expect(routing.asked).toHaveLength(1);
    const asked = routing.asked[0]!;
    expect(asked).toMatchObject({
      accountId: ACCOUNT, messageId, filedTo: READS, movedTo: "INBOX",
    });
    // The seq is the ADOPTION's own `message`/`move` row — what makes a replay of THIS move
    // count once. A later seq would key the override on a different event every replay.
    const adoptMove = changesAfter.find((c) => c.entityType === "message" && c.op === "move");
    expect(adoptMove, "the adoption records its own move delta").toBeDefined();
    expect(asked.seq).toBe(adoptMove!.seq);
  });

  it("a demotion leaves the commit as OWED, and the commit itself files no rule delta", async () => {
    const repo = new FakeRepo();
    const routing = new RecordingRouting();
    const patternKey = `sender:${SENDER}→${READS}`;
    routing.answer = { patternKey, overrides: 2, demoted: true };
    const { seen, changesAfter } = await fileThenDrag(repo, routing);
    expect(seen.owedDemotions, "the switch-off the caller owes after the commit").toEqual([patternKey]);
    expect(changesAfter.filter((c) => c.entityType === "rule"), "a rule delta inside the ingest").toEqual([]);
  });

  it("an override that demoted NOTHING owes nothing", async () => {
    const repo = new FakeRepo();
    const routing = new RecordingRouting();
    routing.answer = { patternKey: `sender:${SENDER}→${READS}`, overrides: 1, demoted: false };
    const { seen, changesAfter } = await fileThenDrag(repo, routing);
    expect(seen.owedDemotions).toBeUndefined();
    expect(changesAfter.filter((c) => c.entityType === "rule")).toEqual([]);
  });

  it("an ORDINARY adoption owes nothing — `null` is the commonplace answer", async () => {
    const repo = new FakeRepo();
    const routing = new RecordingRouting();
    routing.answer = null;
    const { seen, changesAfter } = await fileThenDrag(repo, routing);
    expect(routing.asked).toHaveLength(1);
    expect(seen.owedDemotions).toBeUndefined();
    expect(changesAfter.filter((c) => c.entityType === "rule")).toEqual([]);
  });

  it("POSITIVE CONTROL — a shell with no routing port adopts exactly as it did before", async () => {
    // The method is optional because an install that never auto-applies can never produce an
    // override. Absent must therefore mean "no such thing here", never a refusal — the shape
    // that turned a pending-roster rule into a refusal for the desktop and the demo.
    const withPort = new FakeRepo();
    const nullPort = new RecordingRouting();
    nullPort.answer = null;
    const a = await fileThenDrag(withPort, nullPort);

    const noPort = new FakeRepo();
    const b = await fileThenDrag(noPort);

    const shape = (cs: typeof a.changesAfter) =>
      cs.map((c) => ({ entityType: c.entityType, op: c.op, meta: c.meta }));
    expect(shape(b.changesAfter)).toEqual(shape(a.changesAfter));
    expect(b.seen.action).toEqual({ type: "adopt_external", newDesired: "INBOX" });
    expect((await noPort.getFolderState(b.messageId))!.lastSetBy).toBe("external");
  });

  it("a routing port from BEFORE this seam is not broken by it — an absent method is not a call", async () => {
    const repo = new FakeRepo();
    // `FakeRouting` itself, which implements the three original methods and not this one.
    const legacy = new FakeRouting();
    const { seen, messageId } = await fileThenDrag(repo, legacy);
    expect(seen.action).toEqual({ type: "adopt_external", newDesired: "INBOX" });
    expect((await repo.getFolderState(messageId))!.lastSetBy).toBe("external");
  });
});
