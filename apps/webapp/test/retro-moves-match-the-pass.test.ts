/**
 * A RULE'S BACKLOG IS MOVED BY THE SERVER'S PASS, NEVER BY THE PRESS (THE-CLIENTS-FIFTY).
 *
 * The sheet used to dispatch up to fifty `move`s itself under a rule that also asked the pass for
 * the past mail, choosing them with `retroPassWouldMove` — which sees three of the pass's seven
 * clauses. So mail the person had replied to, or placed themselves from another mail app, moved at
 * the press while the footer said the pass leaves it alone. The press now moves none of it: the
 * rule carries `applyRetro` and the pass moves exactly its own set. A press with NO rule is the
 * person's own instruction and still moves the visible mail, narrowed by the predicate, newest
 * fifty. The fixture is `test/support/retro-candidates.ts`, shared with the phone's twin.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  retroPassWouldMove,
  type EngineMessage,
  type Folder,
  type MessageStateDTO,
  type SyncChange,
} from "@ohmail/client-engine";
import { movesAtLanding, planScreeningChange, senderScreening } from "../app/shell/sender-screening";
import {
  RETRO_DESTINATION,
  RETRO_FIXTURE,
  RETRO_MOVES,
  RETRO_ORDER_FIXTURE,
  RETRO_ORDER_MOVES,
  RETRO_SENDER,
  type RetroFixtureRow,
} from "../../../test/support/retro-candidates.js";

let seq = 0;

function row(r: RetroFixtureRow): EngineMessage {
  const triage: MessageStateDTO | null = r.triage === null
    ? null
    : {
      messageId: r.id,
      state: r.triage as MessageStateDTO["state"],
      bubbleUpAt: null,
      setAt: r.date,
      updatedAt: r.date,
    };
  return {
    id: r.id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: r.why,
    from: { name: RETRO_SENDER.name, address: RETRO_SENDER.address },
    to: [],
    cc: [],
    date: r.date,
    folder: r.folder as Folder,
    snippet: r.why,
    unread: true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage,
    labels: [],
    remoteContent: "none",
    updatedAt: r.date,
  };
}

async function mirror(rows: readonly RetroFixtureRow[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(rows.map((r): SyncChange => ({
    type: "message", op: "create", id: r.id, seq: ++seq, updatedAt: r.date, entity: row(r),
  })));
  return store;
}

/** The plan this press makes over the fixture: a rule with the past-mail answer, or a bare move. */
async function planOf(rows: readonly RetroFixtureRow[], makeRule: boolean) {
  const store = await mirror(rows);
  const s = senderScreening(store, rows[0]!.id, RETRO_SENDER.address);
  expect(s, "the fixture's sender did not read out of the mirror").not.toBeNull();
  return planScreeningChange(s!, "reads", "sender", makeRule, true);
}

/** The ids a press moves itself, in the order the one door emits them (no forecast: every candidate). */
const movedBy = (plan: Awaited<ReturnType<typeof planOf>>): string[] =>
  movesAtLanding(plan, null).map((m) => m.messageId);

describe("a rule's past mail is the pass's to move, and the press moves none of it", () => {
  it("names the same destination the fixture does", () => {
    // Anti-vacuity: the whole comparison is about one destination, and a fixture built for a
    // different one would make every exclusion below trivially true.
    expect(RETRO_DESTINATION).toBe("ohmail/News");
  });

  it("a rule press dispatches no move of its own, and asks the pass for the past mail", async () => {
    const plan = await planOf(RETRO_FIXTURE, true);
    expect(movedBy(plan), "the press moved backlog the pass alone can judge").toEqual([]);
    expect(plan.mutations.some((m) => m.kind === "rule_create" && m.applyRetro === true),
      "the positive control: the rule carries the past-mail answer to the pass").toBe(true);
    // The sheet's count still names the mail in scope, which is what it says before the click.
    expect(plan.matched).toBe(RETRO_MOVES.length);
  });

  it("a bare move — the person's own instruction — moves exactly the predicate's rows", async () => {
    const moved = new Set(movedBy(await planOf(RETRO_FIXTURE, false)));
    expect([...moved].sort()).toEqual([...RETRO_MOVES].sort());
    for (const r of RETRO_FIXTURE) {
      expect(
        moved.has(r.id),
        `${r.id} (${r.folder}, triage ${r.triage ?? "none"}) — ${r.why}`,
      ).toBe(retroPassWouldMove(row(r), RETRO_DESTINATION));
    }
    expect(moved.size).toBeGreaterThan(0);
    expect(moved.size).toBeLessThan(RETRO_FIXTURE.length);
  });

  it("keeps the NEWEST fifty when fifty-one are eligible for a bare move", async () => {
    const ids = movedBy(await planOf(RETRO_ORDER_FIXTURE, false));
    expect(ids).toHaveLength(50);
    expect([...ids].sort()).toEqual([...RETRO_ORDER_MOVES].sort());
  });
});
