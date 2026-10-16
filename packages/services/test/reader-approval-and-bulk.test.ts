import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { AdapterPort } from "@trafficflow/core/mail";
import {
  approvals, folderState, mailboxes, messages, organizerRequests,
} from "@trafficflow/db";
import {
  makeApprovalService, makeHeyMigrationService, requestIdInSet, WorkflowsService,
} from "../src/index.js";
import { changesFor, makeCtx, seedMessage } from "./helpers.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE THREE MOVE DOORS NOTHING WAS GUARDING — and the two answers they get
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Found by sweeping for the PATTERN rather than the instance, after `PATCH /messages/:id
 * { folder }` turned out to be a third unguarded spelling. Each writes `desired_folder` with
 * `last_set_by: 'us'`, which the reconciler turns into a real IMAP move, and none of them asked
 * who organizes the mailbox. They take DIFFERENT SHAPES, and the split is the point.
 */

/**
 * `ApprovalService.decide` moves ONE message: one `message.move`, the shape of pressing move on
 * it directly. `undoRun` and the Hey migration move MANY from one press and take the SET shape —
 * `planBulkMoveOnReader` splits organized from travelling, one record each under the press's own
 * key, so a retry writes the rows it already wrote and no others. The BOUND is asked over the
 * total that would travel, before any write, so the flood case is refused at the press.
 */

async function readerWorld() {
  const w = await makeCtx();
  await w.db.update(mailboxes).set({
    organizerRole: "reader", organizerState: "held",
    organizedByCapabilities: "requests,moves",
    organizedByKind: "local", organizedByName: "mila-thinkpad",
  }).where(eq(mailboxes.id, w.mailboxId));
  return w;
}

type W = Awaited<ReturnType<typeof makeCtx>>;

async function requestRows(w: W) {
  return w.db.select().from(organizerRequests)
    .where(eq(organizerRequests.accountId, w.accountId));
}

/** An approval whose approve arm files a message to Reads. */
async function seedApproval(w: W, messageId: string) {
  const [a] = await w.db.insert(approvals).values({
    accountId: w.accountId, messageId, status: "pending",
    // `kind` and `action` are both NOT NULL — the row says what sort of decision it is and what
    // approving it does. `extractFolder` reads the destination out of `payload`.
    kind: "routing", action: "file", payload: { folder: "ohmail/News" },
  }).returning();
  return a!.id;
}

/**
 * A migration service WITH an adapter, because `rerouteToMatchRules` returns
 * `{ moved: 0, … }` immediately when `this.deps.adapter` is absent — so a fixture without one
 * exercises none of the re-route and would have made both cases below pass for the wrong reason
 * (nothing refused because nothing was ever going to move).
 *
 * The adapter carries the port's real `move(locator, toFolder)` and returns a locator, as
 * `ports.ts:78` declares. It should never be CALLED on a reader — the refusal is ahead of the loop —
 * and the organizer control is what proves the path is otherwise live.
 */
function migrationWithAdapter() {
  const move = vi.fn(async (locator: unknown) => locator as never);
  const svc = makeHeyMigrationService({
    adapter: {
      move, addFlags: vi.fn(async () => undefined), removeFlags: vi.fn(async () => undefined),
    } as unknown as AdapterPort,
  });
  return { svc, move };
}

describe("ApprovalService.decide — one message, so it travels", () => {
  it("approving on a reader writes ONE message.move and moves nothing here", async () => {
    const w = await readerWorld();
    const id = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "INBOX" });
    const [m] = await w.db.select({ k: messages.dedupKey }).from(messages).where(eq(messages.id, id));
    const approvalId = await seedApproval(w, id);

    const svc = makeApprovalService({});
    await svc.decide(w.ctx, approvalId, { decision: "approve" });

    const rows = await requestRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "message.move", mailboxId: w.mailboxId, state: "pending" });
    expect(rows[0]!.payload).toEqual({ dedupKey: m!.k, destination: "reads" });

    // Nothing moved locally, and no `move` change told a client otherwise.
    const [fs] = await w.db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs).toMatchObject({ desiredFolder: "INBOX", observedFolder: "INBOX" });
    expect((await changesFor(w.db, w.accountId)).map((c) => c.op)).not.toContain("move");
  });

  it("THE APPROVAL STILL RESOLVES — only the move travels", async () => {
    /* The person decided. Refusing the whole card would make a reader's Approvals list unusable,
     * and the row records a judgement rather than a mail movement. */
    const w = await readerWorld();
    const id = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "INBOX" });
    const approvalId = await seedApproval(w, id);

    const svc = makeApprovalService({});
    await svc.decide(w.ctx, approvalId, { decision: "approve" });

    const [a] = await w.db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(a!.status).toBe("approved");
  });

  it("THE PHYSICAL IMAP MOVE DOES NOT RUN — the sharpest line in that file", async () => {
    /* This is the assertion the conversion exists for. `decide` reaches the mail server AFTER its
     * transaction, from `msg`/`target` captured BEFORE it, so the transaction's refusal alone does
     * not stop it: without the `movePending` gate it would fire on exactly the path that decided
     * to move nothing — this install performing an IMAP move on a mailbox it does not hold, which
     * is two organizers moving one person's mail. An injected adapter that records is the only way
     * to see it, since the DTO looks the same either way. */
    const w = await readerWorld();
    const id = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "INBOX" });
    const approvalId = await seedApproval(w, id);

    /* THE DOUBLE CARRIES THE PORT'S REAL METHOD NAME AND RETURN SHAPE — `move(locator, toFolder)`
     * answering a `NativeLocator` (`ports.ts:78`). The first version of this double named it
     * `moveMessage` and returned `{ ok: true }`, and the mutation below still went red — but on
     * `adapter.move is not a function`, i.e. the FIXTURE failing rather than the assertion
     * observing a move. A double that is wrong-shaped measures itself; this one makes the red come
     * from `not.toHaveBeenCalled()`. */
    const moveTo = vi.fn(async (locator: unknown) => locator as never);
    const adapter = {
      move: moveTo,
      addFlags: vi.fn(async () => undefined),
      removeFlags: vi.fn(async () => undefined),
    } as unknown as AdapterPort;

    const svc = makeApprovalService({ adapter });
    await svc.decide(w.ctx, approvalId, { decision: "approve" });

    expect(moveTo).not.toHaveBeenCalled();
    expect(await requestRows(w)).toHaveLength(1);
  });

  it("POSITIVE CONTROL — on an ORGANIZER mailbox the approve arm files as it always did", async () => {
    const w = await makeCtx();                       // default role: organizer
    const id = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "INBOX" });
    const approvalId = await seedApproval(w, id);

    const svc = makeApprovalService({});
    await svc.decide(w.ctx, approvalId, { decision: "approve" });

    const [fs] = await w.db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs).toMatchObject({ desiredFolder: "ohmail/News", lastSetBy: "us" });
    expect(await requestRows(w)).toEqual([]);
    expect((await changesFor(w.db, w.accountId)).map((c) => c.op)).toContain("move");
  });

  it("REJECTING on a reader is untouched — it moves nothing, so it asks nothing", async () => {
    // The reject arm writes no `folder_state`, so there was never anything to gate. Stated as a
    // case so a future fix cannot quietly start refusing it.
    const w = await readerWorld();
    const id = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "INBOX" });
    const approvalId = await seedApproval(w, id);

    const svc = makeApprovalService({});
    await svc.decide(w.ctx, approvalId, { decision: "reject" });

    const [a] = await w.db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(a!.status).toBe("rejected");
    expect(await requestRows(w)).toEqual([]);
  });
});

describe("the BULK doors travel as a keyed set, or refuse whole", () => {
  /** A run whose two steps each filed a message, so undoing it is two moves from one press. */
  async function seedTwoStepRun(w: W, ids: string[]) {
    const { workflowRuns, auditLog } = await import("@trafficflow/db");
    const [run] = await w.db.insert(workflowRuns).values({
      // `succeeded` and not "done": the column's CHECK set is
      // pending|running|awaiting_approval|succeeded|failed|undone, and there is no `intent`.
      accountId: w.accountId, status: "succeeded",
    }).returning();
    for (const [i, mid] of ids.entries()) {
      await w.db.insert(auditLog).values({
        accountId: w.accountId, action: "workflow_step",
        payload: { runId: run!.id, stepIndex: i },
        inverse: { tool: "file_message", messageId: mid, toFolder: "INBOX" },
      });
    }
    return run!.id;
  }

  it("undoRun on a reader travels as N records under ONE key, and moves nothing here", async () => {
    const w = await readerWorld();
    const a = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "ohmail/News" });
    const b = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "ohmail/News" });
    const runId = await seedTwoStepRun(w, [a, b]);

    const svc = new WorkflowsService();
    const dto = await svc.undoRun(w.ctx, runId);

    /* TWO RECORDS FOR TWO STEPS — the shape the one-record protocol could not carry. Each names
       the destination as a WORD, never an IMAP path: the applier resolves it on the machine
       actually connected. */
    const rows = await requestRows(w);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "message.move")).toBe(true);
    expect(rows.every((r) => r.state === "pending")).toBe(true);
    expect(
      rows.map((r) => (r.payload as { destination: string }).destination),
    ).toEqual(["inbox", "inbox"]);

    /* ONE KEY: every record's id derives from the press's key and its own member, so the two ids
       are exactly the ones `requestIdInSet` names for this run — nothing random, which is what
       makes the retry below write nothing. */
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(
      [a, b].map((mid) => requestIdInSet(`workflow-undo:${runId}`, mid)),
    ));

    // Nothing moved HERE: writing `folder_state` as well would be this install claiming a move it
    // cannot make, and the organizer would then be asked twice.
    for (const mid of [a, b]) {
      const [fs] = await w.db.select().from(folderState).where(eq(folderState.messageId, mid));
      expect(fs!.desiredFolder).toBe("ohmail/News");
    }
    // The decision IS taken — `undone`, with the count saying how much is still in flight.
    expect(dto).toMatchObject({ status: "undone", pendingMoves: 2 });
  });

  it("a RETRIED undo writes no second set — the ids are derived, not minted", async () => {
    /* The whole reason the id is a hash of (press key, member): a second attempt with fresh ids
       would be somebody's mail moved twice, and no guard downstream could tell the two sets
       apart. */
    const w = await readerWorld();
    const a = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "ohmail/News" });
    const runId = await seedTwoStepRun(w, [a]);

    const svc = new WorkflowsService();
    await svc.undoRun(w.ctx, runId);
    const first = await requestRows(w);
    const dto = await svc.undoRun(w.ctx, runId);

    const second = await requestRows(w);
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
    expect(second).toHaveLength(1);
    // The answer still counts the whole press — `of`, not "what this attempt wrote".
    expect(dto.pendingMoves).toBe(1);
  });

  it("a holder that will not take moves refuses the undo WHOLE, by name", async () => {
    /* The travel is not unconditional: a holder advertising `requests` and not `moves` has no
       applier for this kind, so a record would sit pending until it expired. Refused whole —
       travelling the rest would leave half an undo with nothing pending to explain it. */
    const w = await readerWorld();
    await w.db.update(mailboxes).set({ organizedByCapabilities: "requests" })
      .where(eq(mailboxes.id, w.mailboxId));
    const a = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "ohmail/News" });
    const b = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "ohmail/News" });
    const runId = await seedTwoStepRun(w, [a, b]);

    const svc = new WorkflowsService();
    await expect(svc.undoRun(w.ctx, runId)).rejects.toMatchObject({
      code: "organized_elsewhere", httpStatus: 409,
      details: { by: { kind: "local", name: "mila-thinkpad" } },
    });

    for (const mid of [a, b]) {
      const [fs] = await w.db.select().from(folderState).where(eq(folderState.messageId, mid));
      expect(fs!.desiredFolder).toBe("ohmail/News");
    }
    expect(await requestRows(w)).toEqual([]);
    const { workflowRuns } = await import("@trafficflow/db");
    const [after] = await w.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(after!.status).toBe("succeeded");   // not marked `undone` either
  });

  it("a holder that STOPPED refuses the undo whole as no_organizer", async () => {
    // The bulk door's refusal follows the same decider: a lapsed lease organizes nothing.
    const w = await readerWorld();
    await w.db.update(mailboxes).set({ organizerState: "stopped" }).where(eq(mailboxes.id, w.mailboxId));
    const a = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "ohmail/News" });
    const runId = await seedTwoStepRun(w, [a]);
    await expect(new WorkflowsService().undoRun(w.ctx, runId)).rejects.toMatchObject({
      code: "organized_elsewhere", details: { reason: "no_organizer" },
    });
    expect(await requestRows(w)).toEqual([]);
  });

  it("POSITIVE CONTROL — undoRun on an ORGANIZER mailbox still undoes the steps", async () => {
    // Without this the case above proves only that undo is broken.
    const w = await makeCtx();
    const a = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "ohmail/News" });
    const { workflowRuns, auditLog } = await import("@trafficflow/db");
    const [run] = await w.db.insert(workflowRuns).values({
      // `succeeded` and not "done": the column's CHECK set is
      // pending|running|awaiting_approval|succeeded|failed|undone, and there is no `intent`.
      accountId: w.accountId, status: "succeeded",
    }).returning();
    await w.db.insert(auditLog).values({
      accountId: w.accountId, action: "workflow_step",
      payload: { runId: run!.id, stepIndex: 0 },
      inverse: { tool: "file_message", messageId: a, toFolder: "INBOX" },
    });

    const svc = new WorkflowsService();
    await svc.undoRun(w.ctx, run!.id);

    const [fs] = await w.db.select().from(folderState).where(eq(folderState.messageId, a));
    expect(fs!.desiredFolder).toBe("INBOX");
    const [after] = await w.db.select().from(workflowRuns).where(eq(workflowRuns.id, run!.id));
    expect(after!.status).toBe("undone");
  });

  it("the Hey migration's RE-ROUTE travels on a reader, and its rules-only default is untouched", async () => {
    /* The migration's bulk re-route is opt-in (`reroute: true`); the DEFAULT is rules-only and
     * writes no `folder_state`, so there is nothing there to gate. Both halves are asserted,
     * because a refusal that fired on the default would break the ordinary migration — the door
     * everybody actually uses — while every reader assertion stayed green. */
    const w = await readerWorld();
    const id = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "INBOX" });
    const [m] = await w.db.select({ from: messages.fromAddress })
      .from(messages).where(eq(messages.id, id));
    const observations = [
      { senderOrDomain: m!.from.toLowerCase(), kind: "sender" as const, destination: "ohmail/News" as const },
    ];
    const { svc, move } = migrationWithAdapter();

    // RULES-ONLY: admitted, as it always was.
    const plain = await svc.migrateFromObservations(w.ctx, { observations });
    expect(plain.rerouted).toBe(0);

    // RE-ROUTE: travels, one record for the one matching message.
    const out = await svc.migrateFromObservations(w.ctx, { observations }, { reroute: true });
    expect(out.rerouted).toBe(0);            // nothing moved BY THIS INSTALL
    const rows = await requestRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "message.move" });
    expect((rows[0]!.payload as { destination: string }).destination).toBe("reads");
    expect(rows[0]!.id).toBe(requestIdInSet(`hey-reroute:${w.accountId}`, id));
    // And nothing moved HERE: planned ahead of the loop, so no row was touched.
    const [fs] = await w.db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs).toMatchObject({ desiredFolder: "INBOX", observedFolder: "INBOX" });
    // …and the mail server was never reached.
    expect(move).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL — the migration's re-route works on an ORGANIZER mailbox", async () => {
    const w = await makeCtx();
    const id = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "INBOX" });
    const [m] = await w.db.select({ from: messages.fromAddress })
      .from(messages).where(eq(messages.id, id));
    const { svc } = migrationWithAdapter();

    await svc.migrateFromObservations(w.ctx, {
      observations: [
        { senderOrDomain: m!.from.toLowerCase(), kind: "sender", destination: "ohmail/News" },
      ],
    }, { reroute: true });

    const [fs] = await w.db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs!.desiredFolder).toBe("ohmail/News");
  });

  it("an undo whose steps touch NO mailbox is not blocked by a reader mailbox", async () => {
    /* The restriction is "the messages this operation would move", not "this account has a reader".
     * A `draft_reply` inverse moves no mail, so it cannot be blocked — and the union discriminates
     * on `tool`, so an inverse of another kind must not be read as a move. */
    const w = await readerWorld();
    const { workflowRuns, auditLog, drafts } = await import("@trafficflow/db");
    const [run] = await w.db.insert(workflowRuns).values({
      // `succeeded` and not "done": the column's CHECK set is
      // pending|running|awaiting_approval|succeeded|failed|undone, and there is no `intent`.
      accountId: w.accountId, status: "succeeded",
    }).returning();
    const [d] = await w.db.insert(drafts).values({
      accountId: w.accountId, mailboxId: w.mailboxId, subject: "s", body: "b",
      to: [{ name: null, address: "x@example.com" }], status: "draft",
      createdAt: w.ctx.now(), updatedAt: w.ctx.now(),
    }).returning();
    await w.db.insert(auditLog).values({
      accountId: w.accountId, action: "workflow_step",
      payload: { runId: run!.id, stepIndex: 0 },
      inverse: { tool: "draft_reply", draftId: d!.id },
    });

    const svc = new WorkflowsService();
    await svc.undoRun(w.ctx, run!.id);        // admitted
    const [after] = await w.db.select().from(workflowRuns).where(eq(workflowRuns.id, run!.id));
    expect(after!.status).toBe("undone");
  });
});
