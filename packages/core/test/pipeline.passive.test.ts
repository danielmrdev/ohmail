import { describe, it, expect } from "vitest";
import { planChange, commitChange , UNMETERED_STORAGE_CAP} from "../src/pipeline.js";
import { FakeRepo, FakeRouting, dedupKeyFor } from "./fakes.js";
import type { Change, CreditGate, PlanDeps, Rule } from "../src/ports.js";
import type { ClassifierPort, ClassifierResult } from "../src/ai/classify.js";

/**
 * MAIL IN THE CUSTOMER'S OWN FOLDERS — passive presence.
 *
 * A folder the customer made (`Archive`, `Private/Editor`, `_archive/Clients/…`) is READ and
 * never REORGANIZED. Reading it is the adapter's half; this file is the other half, and every test
 * below is written so that DELETING the `if (change.passive)` early return in `planChange` turns it
 * red. The failure each one produces is named in its own comment — a guard nobody has watched fail
 * is not evidence.
 *
 * The three the product cannot be wrong about:
 *
 *  1. no RULE runs on it — not even a rule that matches its sender exactly;
 *  2. no AI ACTION is spent on it, so backfilling thousands of archived messages bills nobody;
 *  3. no MOVE is ever issued: `desired === arrival`, and the `folder_state` row is written
 *     `last_set_by: 'external'`, which is what puts it out of every retro pass's reach as well.
 *
 * And the two that make it worth doing at all: the mail is STORED (so it is searchable) and its
 * READ STATE is the server's, not a guess.
 */

const OWNER = "owner@example.com";
const ARCHIVE = "Private/Editor";

function eml(o: { from?: string; subject?: string; body?: string; messageId: string }): Buffer {
  return Buffer.from([
    `Message-ID: <${o.messageId}>`,
    `From: ${o.from ?? "editor@example.com"}`,
    `To: ${OWNER}`,
    `Subject: ${o.subject ?? "Frischer Auftritt"}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    o.body ?? "Die neue Website ist online.",
  ].join("\r\n"));
}

/** A create the adapter read out of one of the customer's own folders. */
function passiveChange(raw: Buffer, ref = "77:12", seen = true): Change {
  return { type: "create", locator: { folder: ARCHIVE, ref }, raw, seen, passive: true };
}
/** The same message arriving the ordinary way, for the contrast each test needs. */
function inboxChange(raw: Buffer, ref = "1:20"): Change {
  return { type: "create", locator: { folder: "INBOX", ref }, raw, seen: false };
}

/** A gate that FAILS THE TEST if the pipeline ever asks it for money on this path. */
function forbiddenGate(): CreditGate {
  return {
    async spend(_a: string, _action: never, key: string): Promise<never> {
      throw new Error(`credit gate consulted for passive mail (key ${key})`);
    },
  };
}

/** A classifier that fails the test if it is ever called. */
const forbiddenClassifier: ClassifierPort = {
  async classify(): Promise<ClassifierResult> {
    throw new Error("classifier called for passive mail");
  },
};

function deps(repo: FakeRepo, extra: Partial<PlanDeps> = {}): PlanDeps {
  return { repo, accountId: "acct-1", mailboxId: "mb-1", ...extra };
}

async function ingest(change: Change, repo: FakeRepo, extra: Partial<PlanDeps> = {}) {
  const plan = await planChange(change, deps(repo, extra));
  return commitChange(plan, {
    storageCap: UNMETERED_STORAGE_CAP,
    repo, accountId: "acct-1", mailboxId: "mb-1", routing: extra.routing,
  });
}

/** An enabled rule that matches the sender of every message in this file. */
const senderRule: Rule = {
  id: "rule-1", kind: "sender", match: "editor@example.com",
  destination: "ohmail/News", effect: "allow", priority: 100,
  provenance: "manual", enabled: true, subjectContains: null, bodyContains: null,
};

describe("passive presence — the customer's own folders", () => {
  it("is stored, keeps the server's read state, and stays exactly where it was filed", async () => {
    const repo = new FakeRepo();
    const raw = eml({ messageId: "passive-1@example.com" });

    const res = await ingest(passiveChange(raw), repo);

    expect(res.outcome).toBe("new");
    // NO MOVE. Delete the early return and `evaluateRules` files this stranger's mail into
    // `ohmail/Screener`, so this reads `{ type: 'move', to: 'ohmail/Screener' }`.
    expect(res.action).toEqual({ type: "none" });

    const stored = await repo.findByDedupKey("mb-1", await dedupKeyFor(raw));
    expect(stored, "passive mail must be STORED — that is what makes it searchable").not.toBeNull();
    // The SERVER's read state, not the `seen: true` the own-authored branch forces: archived mail
    // may well be unread, and claiming otherwise marks a whole archive read in their other clients.
    expect(repo.rows.get(stored!.id)!.input.unread).toBe(false);
    const unreadOne = await ingest(
      passiveChange(eml({ messageId: "passive-unread@example.com" }), "77:13", false), repo,
    );
    expect(repo.rows.get(unreadOne.messageId)!.input.unread).toBe(true);
  });

  it("writes last_set_by 'external' — the gate every retro pass reads", async () => {
    // This one word is the SECOND structural gate, independent of the early return: `rule-retro`,
    // `ohbox-tidy`, `screener-auto` and `read-retro` all carry `eq(folderState.lastSetBy, "us")` in
    // their candidate predicates, and `reconcileFolders` skips a non-`'us'` row outright. Change
    // `p.passive ? "external" : "us"` back to a bare `"us"` in `commitChange` and this goes red
    // while every other test in this file stays green — which is the point of asserting it here.
    const repo = new FakeRepo();
    const res = await ingest(passiveChange(eml({ messageId: "passive-2@example.com" })), repo);

    expect(await repo.getFolderState(res.messageId)).toEqual({
      desiredFolder: ARCHIVE, observedFolder: ARCHIVE, lastSetBy: "external",
    });
    // …and the contrast, so the assertion above is about the passive flag and not about the fake:
    // the same message arriving in INBOX is ours to place.
    const inbox = new FakeRepo();
    const other = await ingest(inboxChange(eml({ messageId: "passive-2b@example.com" })), inbox);
    expect((await inbox.getFolderState(other.messageId))!.lastSetBy).toBe("us");
  });

  it("NO RULE runs on it — not even one that matches its sender exactly", async () => {
    // The rule below matches this sender and files to `ohmail/News`. On the ordinary path it fires;
    // here it must not be consulted at all. Delete the early return and `res.action` is
    // `{ type: 'move', to: 'ohmail/News' }` — a MOVE inside somebody's fifteen-year archive.
    const repo = new FakeRepo();
    repo.rules.push(senderRule);
    const raw = eml({ messageId: "passive-3@example.com" });

    const res = await ingest(passiveChange(raw), repo);

    expect(res.action).toEqual({ type: "none" });
    expect((await repo.getFolderState(res.messageId))!.desiredFolder).toBe(ARCHIVE);
    expect(repo.changes.some((c) => c.op === "move")).toBe(false);

    // THE PREMISE, asserted rather than assumed: the same rule DOES fire on the same message when it
    // arrives the ordinary way. Without this the test above passes against a rule that never matched.
    const ordinary = new FakeRepo();
    ordinary.rules.push(senderRule);
    const fired = await ingest(inboxChange(eml({ messageId: "passive-3b@example.com" })), ordinary);
    expect(fired.action).toEqual({ type: "move", to: "ohmail/News" });
  });

  it("spends NO AI action, so backfilling an archive bills nobody", async () => {
    // With `desired` already decided there is no `unclear` residue, so the AI branch is unreachable
    // and `credits.tryDebit` is never called. Both fakes THROW rather than record, so moving the
    // early return below the AI block fails this loudly instead of subtly.
    //
    // THE SENDER IS A KNOWN CONTACT HERE, and that is what makes this test discriminate. An UNKNOWN
    // sender gets `destination: 'ohmail/Screener'` from the rules, and the AI gate requires
    // `decision.destination == null` — so with a stranger this passes whether the early return exists
    // or not. Measured: without `senders`, deleting the early return leaves this test green.
    const repo = new FakeRepo();
    repo.senders.add("editor@example.com");
    const routing = new FakeRouting();

    const res = await ingest(passiveChange(eml({ messageId: "passive-4@example.com" })), repo, {
      classifier: forbiddenClassifier, credits: forbiddenGate(), routing,
    });

    expect(res.action).toEqual({ type: "none" });
    expect((await repo.getFolderState(res.messageId))!.desiredFolder).toBe(ARCHIVE);
    // No routing decision, no approval: nothing was proposed about this message.
    expect(routing.decisions).toEqual([]);
    expect(routing.approvals).toEqual([]);

    // THE PREMISE: the same message from the same known sender DOES reach the classifier when it
    // arrives the ordinary way. Without this the assertions above could hold because nothing in this
    // account can ever reach the AI branch.
    const ordinary = new FakeRepo();
    ordinary.senders.add("editor@example.com");
    let asked = 0;
    const counted: ClassifierPort = {
      async classify(): Promise<ClassifierResult> {
        asked++;
        return { destination: "ohmail/News", confidence: 0.9, rationale: "newsletter", spam: false };
      },
    };
    await ingest(inboxChange(eml({ messageId: "passive-4b@example.com" })), ordinary, {
      classifier: counted, routing: new FakeRouting(),
    });
    expect(asked, "the ordinary path reaches the classifier for this sender").toBe(1);
  });

  it("keeps its sensitivity flags and is NOT dragged into the Imbox", async () => {
    // `sensitivity.sensitive` forces INBOX on the ordinary path. An eight-year-old password reset
    // filed under `Private/Opi` must not surface in today's Ohbox — delete the early return and
    // `desiredFolder` here is `INBOX`.
    const repo = new FakeRepo();
    const raw = eml({
      messageId: "passive-5@example.com",
      subject: "Your verification code",
      body: "Your login code is 449182. It expires in 10 minutes.",
    });

    const res = await ingest(passiveChange(raw), repo);

    expect((await repo.getFolderState(res.messageId))!.desiredFolder).toBe(ARCHIVE);
    // The never-flags are a property of the sensitivity result and survive the early return.
    expect(repo.rows.get(res.messageId)!.input.flags.no_ai).toBe(true);
  });

  it("a message ALREADY held is not re-ingested when the customer files it away", async () => {
    // The other half of "their filing is theirs", and it needs no passive flag: the adapter pairs the
    // INBOX delete with the archive create, `classifyDedup` answers `external_move` on that evidence,
    // and the existing adoption path follows their hand and writes `last_set_by: 'external'` itself.
    // Asserted here so the two halves are known to meet.
    const repo = new FakeRepo();
    const raw = eml({ messageId: "passive-6@example.com" });
    const first = await ingest(inboxChange(raw, "1:30"), repo);
    expect(first.outcome).toBe("new");

    const moved = await ingest(
      { type: "move", locator: { folder: ARCHIVE, ref: "77:44" }, raw, seen: true }, repo,
    );

    expect(moved.outcome).toBe("external_move");
    expect(moved.messageId).toBe(first.messageId);
    expect(repo.rows.size).toBe(1);
    expect(await repo.getFolderState(first.messageId)).toEqual({
      desiredFolder: ARCHIVE, observedFolder: ARCHIVE, lastSetBy: "external",
    });
  });
});
