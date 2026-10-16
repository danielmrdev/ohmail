import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, threads, messages, kbEntries } from "@trafficflow/db";
import { DraftingService, DraftsService } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";
import type { DraftInput, DraftPort } from "@trafficflow/core";

const NOW = new Date("2026-07-28T12:00:00.000Z");

/** A capturing mock DraftPort: records every input + call-count, never networks. */
function mockDrafter(): DraftPort & { calls: number; inputs: DraftInput[] } {
  const m = {
    calls: 0,
    inputs: [] as DraftInput[],
    async draft(input: DraftInput) {
      m.calls += 1;
      m.inputs.push(input);
      return { subject: "Re: mocked", body: "Mocked reply.", rationale: "mock" };
    },
  };
  return m;
}

async function setup() {
  const db = await makeTestDb();
  const A = randomUUID();
  const B = randomUUID();
  const [mbA] = await db.insert(mailboxes).values({ accountId: A, provider: "imap", address: "a@x-ch.example" }).returning();
  const ctxA: ServiceContext = { db, accountId: A, userId: null, now: () => NOW, requestId: "r" };
  const ctxB: ServiceContext = { db, accountId: B, userId: null, now: () => NOW, requestId: "r" };
  return { db, A, B, mbA: mbA!.id, ctxA, ctxB };
}

interface SeedMsg {
  accountId: string; mailboxId: string; threadId?: string;
  subject?: string; fromAddress?: string; snippet?: string; date?: Date;
  noAi?: boolean; noKb?: boolean; sensitivityCategory?: string | null;
}
async function seedMsg(db: Awaited<ReturnType<typeof setup>>["db"], o: SeedMsg): Promise<string> {
  const [m] = await db.insert(messages).values({
    accountId: o.accountId,
    mailboxId: o.mailboxId,
    bodyHash: "h",
    dedupKey: `seed:${randomUUID()}`,
    subject: o.subject ?? "Seed subject",
    fromAddress: o.fromAddress ?? "sender@example.com",
    snippet: o.snippet ?? "seed snippet",
    threadId: o.threadId ?? null,
    date: o.date ?? NOW,
    noAi: o.noAi ?? false,
    noKb: o.noKb ?? false,
    sensitivityCategory: o.sensitivityCategory ?? null,
  }).returning();
  return m!.id;
}

const svc = new DraftingService();
const draftsSvc = new DraftsService();

describe("DraftingService.draftFromMessage — refuse sensitive/no_ai target", () => {
  it("a no_ai target → 422 sensitive_no_ai, and the drafter is NEVER called", async () => {
    const { db, A, mbA, ctxA } = await setup();
    const id = await seedMsg(db, { accountId: A, mailboxId: mbA, noAi: true });
    const drafter = mockDrafter();
    await expect(svc.draftFromMessage(ctxA, id, { drafter }))
      .rejects.toMatchObject({ httpStatus: 422, code: "sensitive_no_ai" });
    expect(drafter.calls).toBe(0);   // the sensitive body never reached the model
  });

  it("a sensitive (sensitivity_category set) target → 422, drafter not called", async () => {
    const { db, A, mbA, ctxA } = await setup();
    const id = await seedMsg(db, { accountId: A, mailboxId: mbA, sensitivityCategory: "otp" });
    const drafter = mockDrafter();
    await expect(svc.draftFromMessage(ctxA, id, { drafter }))
      .rejects.toMatchObject({ httpStatus: 422 });
    expect(drafter.calls).toBe(0);
  });
});

describe("DraftingService.draftFromMessage — structural exclusion of no_kb/sensitive siblings", () => {
  it("the DraftInput carries the normal thread sibling but NOT the no_kb one", async () => {
    const { db, A, mbA, ctxA } = await setup();
    const [th] = await db.insert(threads).values({ accountId: A, subject: "Thread" }).returning();
    const target = await seedMsg(db, {
      accountId: A, mailboxId: mbA, threadId: th!.id, subject: "Please advise",
      snippet: "target snippet", date: new Date(NOW.getTime() + 3000),
    });
    await seedMsg(db, {
      accountId: A, mailboxId: mbA, threadId: th!.id, fromAddress: "normal@x-ch.example",
      snippet: "NORMAL-SIBLING-SNIPPET", date: new Date(NOW.getTime() + 1000),
    });
    await seedMsg(db, {
      accountId: A, mailboxId: mbA, threadId: th!.id, fromAddress: "secret@x-ch.example",
      snippet: "NOKB-SIBLING-SNIPPET", noKb: true, date: new Date(NOW.getTime() + 2000),
    });

    const drafter = mockDrafter();
    await svc.draftFromMessage(ctxA, target, { drafter });

    expect(drafter.calls).toBe(1);
    const snippets = drafter.inputs[0]!.context.threadMessages.map((t) => t.snippet);
    expect(snippets).toContain("NORMAL-SIBLING-SNIPPET");
    expect(snippets).not.toContain("NOKB-SIBLING-SNIPPET");   // structural WHERE excluded it
    // and never the target itself (ne(id) excludes it)
    expect(snippets).not.toContain("target snippet");
  });
});

describe("DraftingService.draftFromMessage — context assembly + stored-not-sent", () => {
  it("assembles KB + thread context, and STORES a status='draft' row (never sent)", async () => {
    const { db, A, mbA, ctxA } = await setup();
    await db.insert(kbEntries).values({
      accountId: A, title: "Refund policy", content: "We refund purchases within 30 days.",
    });
    const [th] = await db.insert(threads).values({ accountId: A, subject: "Refund" }).returning();
    // KbService.retrieve uses websearch_to_tsquery (AND-semantics), so the query
    // tokens (subject+snippet) must all appear in the KB doc to match. Keep them a
    // subset of "Refund policy … refund purchases within 30 days".
    const target = await seedMsg(db, {
      accountId: A, mailboxId: mbA, threadId: th!.id, subject: "Refund policy",
      snippet: "refund within 30 days", fromAddress: "client@acme-com.example",
    });
    await seedMsg(db, {
      accountId: A, mailboxId: mbA, threadId: th!.id, snippet: "earlier reply", fromAddress: "me@x-ch.example",
      date: new Date(NOW.getTime() - 1000),
    });

    const drafter = mockDrafter();
    const { draftId, seq } = await svc.draftFromMessage(ctxA, target, { drafter });
    expect(seq).toBeGreaterThan(0);

    // The drafter saw the KB entry + the thread sibling.
    const input = drafter.inputs[0]!;
    expect(input.context.kbEntries.map((e) => e.title)).toContain("Refund policy");
    expect(input.context.threadMessages.map((t) => t.snippet)).toContain("earlier reply");
    expect(input.incoming.subject).toBe("Refund policy");

    // Stored, not sent: a 'draft' row with the AI result + linkage.
    const stored = await draftsSvc.get(ctxA, draftId);
    expect(stored.status).toBe("draft");
    expect(stored.body).toBe("Mocked reply.");
    expect(stored.rationale).toBe("mock");
    expect(stored.inReplyToMessageId).toBe(target);
    expect(stored.threadId).toBe(th!.id);
    expect(stored.mailboxId).toBe(mbA);
  });

  it("cross-account target → 404, drafter not called", async () => {
    const { db, A, mbA, ctxB } = await setup();
    const id = await seedMsg(db, { accountId: A, mailboxId: mbA });
    const drafter = mockDrafter();
    await expect(svc.draftFromMessage(ctxB, id, { drafter }))
      .rejects.toMatchObject({ httpStatus: 404 });
    expect(drafter.calls).toBe(0);
  });
});
