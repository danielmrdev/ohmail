import { describe, it, expect } from "vitest";
import { planChange, commitChange, UNMETERED_STORAGE_CAP } from "../src/pipeline.js";
import type { PlanDeps } from "../src/pipeline.js";
import { FakeRepo, FakeRouting } from "./fakes.js";
import type { Change, CreditGate } from "../src/ports.js";
import type { Rule } from "../src/rules.js";
import type { ClassifierPort, ClassifierResult } from "../src/ai/classify.js";

/**
 * WHOSE PLACEMENT IS IT — the three values of `folder_state.last_set_by`, and the one a READER
 * used to get wrong.
 *
 * ── THE FAILURE THIS FILE EXISTS FOR ────────────────────────────────────────────────────────
 *
 * Somebody presses "Reads" on a stranger in the Screener. The product answers *"— filed. Future
 * mail from them files there too."* A month later further messages from that same sender are
 * sitting at the gate, unread, behind a decision they already made — the rule still listed, still
 * enabled, still pointing at Reads.
 *
 * The mail had been ingested while that install held no organizer lease. A reader ADOPTS the
 * placement it finds instead of deciding one, and it recorded that placement as `'external'` —
 * which is defined everywhere as *a placement the USER made in their own mail client*. Nobody
 * hand-files mail into ohmail's own consent queue, so the record was false; and it is the one
 * record that means "hands off, for ever":
 *
 *  · `rule-retro.ts` and `reconcileFolders` skip a row that is not theirs to move;
 *  · `ohbox-tidy.ts`, `screener-auto.ts` and `sensitive-rescreen.ts` likewise.
 *
 * ── WHAT THE FIX IS, AND WHAT IT DELIBERATELY IS NOT ────────────────────────────────────────
 *
 * A third value, `'peer'` — *another install of this account placed it, in a folder ohmail
 * organizes* — written by ONE seam and by nothing else: `pipeline.ts#readerAdoption`, for a message
 * this install has never held, through {@link NewPlan.adoption}.
 *
 * ── AND THE SECOND SEAM, WHICH IS WHY THAT SENTENCE READS "ONE" ─────────────────────────────
 *
 * It was two. `readerAttribution` answered the same folder question for a message we ALREADY HOLD,
 * through `ReconcileAction.attribution`, on the argument that both seams must agree or the row a
 * demoted organizer leaves behind would depend on whether the message was first seen at the gate or
 * moved there afterwards. That symmetry cost a person their own filing:
 *
 *   they drag a message out of `ohmail/News` back into `INBOX` in Apple Mail. `INBOX` is one of
 *   the six organized folders, so the folder test answered TRUE, the reader recorded the placement
 *   as another install's, and `rule-retro` — the one pass that admits `'peer'` — moved it back out
 *   the next time a rule of theirs was pressed.
 *
 * So an existing message a reader finds somewhere new is `'external'`: the wire carries no evidence
 * of WHO moved it (the adapter reports a folder change and no more; the destination cannot answer
 * it, because `INBOX` is exactly where a person drags mail), and `'external'` is the direction that
 * fails safe. The two seams are not one question — a message we have never held carries no
 * placement of ours for a `'peer'` record to override, while a message we hold does.
 *
 * THE OTHER HALF OF THE SEQUENCE lives in the pass that reads the value:
 * `apps/worker/test/rule-retro.test.ts` asserts that a requested retro moves a `'peer'` row and
 * leaves an `'external'` one — and, in `a person's own drag survives a rule pressed afterwards`,
 * drives this pipeline and that pass over one message so the value written here is the value that
 * predicate actually excludes.
 *
 * It is NOT `'us'`. `'us'` means THIS install decided, it is the durable dual-organizer
 * discriminator, and it would admit the row to `ohbox-tidy` and `screener-auto` — both of which run
 * unbidden, so a promotion would become a bulk re-filing of the other install's placements. `peer`
 * is admitted by `rule-retro` alone, the one pass a person has to press for.
 *
 * `change.passive` and the import hold keep `'external'` and are asserted below, because the
 * `?? "external"` default at the commit IS their branch — the injected default is the untested
 * direction, and a `"peer"` default would otherwise ship in silence.
 */

const OWNER = "owner@example.com";
const SENDER = "digest@anchor-digest.invalid";
const STRANGER = "unknown@nowhere.invalid";
/** A folder the CUSTOMER made. `isOrganizedFolder` answers false for it. */
const ARCHIVE = "Private/Editor";
const GATE = "ohmail/Screener";
const READS = "ohmail/News";

function eml(messageId: string, from: string = SENDER): Buffer {
  return Buffer.from([
    `Message-ID: <${messageId}>`,
    `From: Anchor Digest <${from}>`,
    `To: ${OWNER}`,
    "Subject: Field report: winter build",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "The winter build is out.",
  ].join("\r\n"));
}

function create(folder: string, raw: Buffer, ref: string, passive = false): Change {
  return {
    type: "create", locator: { folder, ref }, raw, seen: false,
    ...(passive ? { passive: true } : {}),
  };
}

/**
 * A CORRELATED MOVE of a message we already hold — the adapter's `correlateMoves` output.
 *
 * It has to be this shape and not a second `create`: an identical message merely APPEARING in
 * another folder is a duplicate copy (`external_copy`), which adopts nothing, and `permitsAdoption`
 * refuses it on purpose — delivering a second copy of a message we hold is something a stranger can
 * do. Only a correlated move or a verified absence is evidence that the message MOVED.
 */
function moved(folder: string, raw: Buffer, ref: string): Change {
  return { type: "move", locator: { folder, ref }, raw, seen: false };
}

/** The rule the person made by pressing "Reads" on this sender in the Screener. */
const promotedRule: Rule = {
  id: "rule-reads", kind: "sender", match: SENDER,
  destination: READS, effect: "allow", priority: 0,
  provenance: "promoted", enabled: true, subjectContains: null, bodyContains: null,
};

function deps(repo: FakeRepo, extra: Partial<PlanDeps> = {}): PlanDeps {
  return { repo, accountId: "acct-1", mailboxId: "mb-1", readerMode: false, ...extra };
}

async function ingest(change: Change, repo: FakeRepo, extra: Partial<PlanDeps> = {}) {
  const plan = await planChange(change, deps(repo, extra));
  return commitChange(plan, {
    storageCap: UNMETERED_STORAGE_CAP,
    repo, accountId: "acct-1", mailboxId: "mb-1", routing: extra.routing,
  });
}

const attributionOf = async (repo: FakeRepo, id: string) =>
  (await repo.getFolderState(id))!.lastSetBy;

/** A gate that FAILS THE TEST if the pipeline ever asks a reader for money. */
function forbiddenGate(): CreditGate {
  return {
    async spend(_a: string, _action: never, key: string): Promise<never> {
      throw new Error(`credit gate consulted by a READER (key ${key})`);
    },
  };
}

/** A classifier that fails the test if a reader ever reaches it. */
const forbiddenClassifier: ClassifierPort = {
  async classify(): Promise<ClassifierResult> {
    throw new Error("classifier called by a READER");
  },
};

describe("a reader records another install's placement as 'peer', never 'external', never 'us'", () => {
  it("NEW mail observed AT THE GATE is 'peer' — and the reader still commands nothing", async () => {
    /* THE CONTROL. Before the third value existed this row read `'external'`: a claim that the
       person hand-filed the message into ohmail's own consent queue, and the exact value four
       movers read as "never touch this again". */
    const repo = new FakeRepo();
    repo.rules.push(promotedRule);

    const res = await ingest(create(GATE, eml("reader-gate-1@example.com"), "9:1"), repo, {
      readerMode: true,
    });

    expect(await repo.getFolderState(res.messageId)).toEqual({
      desiredFolder: GATE, observedFolder: GATE, lastSetBy: "peer",
    });
    // `desired === observed`, so there is no move to make and none is recorded. The attribution
    // changed; the behaviour did not.
    expect(res.action).toEqual({ type: "none" });
    expect(repo.changes.some((c) => c.op === "move")).toBe(false);
  });

  it("NEW mail delivered to the IMBOX while we read is 'peer' too", async () => {
    // `isOrganizedFolder('INBOX')` is true: nobody hand-files mail INTO the Imbox, it is delivered
    // there. `'external'` was as false here as at the gate.
    const repo = new FakeRepo();

    const res = await ingest(create("INBOX", eml("reader-inbox-1@example.com"), "1:7"), repo, {
      readerMode: true,
    });

    expect(await attributionOf(repo, res.messageId)).toBe("peer");
    expect(res.action).toEqual({ type: "none" });
  });

  it("a reader NEVER writes 'us' — not in either folder family", async () => {
    /* Stated as its own case because it is the half the movers depend on. `'us'` is "THIS install
       decided": it is the dual-organizer discriminator, and it would hand the row to `ohbox-tidy`
       and `screener-auto`, both of which run unbidden. */
    const repo = new FakeRepo();
    repo.rules.push(promotedRule);

    const atGate = await ingest(create(GATE, eml("reader-us-1@example.com"), "9:4"), repo, { readerMode: true });
    const atArchive = await ingest(create(ARCHIVE, eml("reader-us-2@example.com"), "77:9"), repo, { readerMode: true });

    expect([
      await attributionOf(repo, atGate.messageId),
      await attributionOf(repo, atArchive.messageId),
    ]).toEqual(["peer", "external"]);
  });

  it("the customer's OWN folder is still 'external' — the fix must not widen", async () => {
    /* What makes the cases above about the ohmail NAMESPACE rather than about readers. A folder
       somebody made is their filing; `external` is the true statement and the movers must keep
       their hands off it. */
    const repo = new FakeRepo();
    repo.rules.push(promotedRule);

    const res = await ingest(create(ARCHIVE, eml("reader-archive-1@example.com"), "77:4"), repo, {
      readerMode: true,
    });

    expect(await repo.getFolderState(res.messageId)).toEqual({
      desiredFolder: ARCHIVE, observedFolder: ARCHIVE, lastSetBy: "external",
    });
  });

  it("a PASSIVE arrival is 'external' — it does not go through the reader seam", async () => {
    // `change.passive` is the adapter saying "this came out of a folder the customer made", and
    // `passiveFolderExclusion` guarantees that upstream. It keeps `'external'` unconditionally.
    const repo = new FakeRepo();
    repo.rules.push(promotedRule);

    const res = await ingest(create(ARCHIVE, eml("passive-1@example.com"), "77:5", true), repo);

    expect(await attributionOf(repo, res.messageId)).toBe("external");
    expect(res.action).toEqual({ type: "none" });
  });

  it("THE INJECTED DEFAULT: an import-hold adoption is 'external', in an ORGANIZED folder", async () => {
    /* This is the `?? "external"` branch at the commit, and it is the one the reader arm never
       takes — so without this case a `?? "peer"` default would ship in silence.

       It is deliberately an arrival in `INBOX`, a folder `isOrganizedFolder` answers TRUE for, so
       the assertion cannot pass merely because the folder is one the customer made. The import
       hold freezes the previous organizer's placement on purpose: without that, the hold would
       only postpone the re-screen it exists to prevent.

       A sender unknown to THIS store with no rule, so the gate's own verdict fires (`source ===
       'screener'`), whom the travelling document screened in — the two terms `heldForImport` needs. */
    const repo = new FakeRepo();

    const res = await ingest(create("INBOX", eml("hold-1@example.com", STRANGER), "1:11"), repo, {
      importHold: { kind: "document", knownSenders: { addresses: new Set([STRANGER]), inferred: new Set<string>(), lists: new Map() }, rules: [] },
    });

    expect(await repo.getFolderState(res.messageId)).toEqual({
      desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "external",
    });
  });

  it("THE DRAG: a message the person moves back to the IMBOX themselves is 'external'", async () => {
    /* THE FAILURE THIS CASE EXISTS FOR, and it is the reviewer's sequence verbatim.

       The person opens Apple Mail and drags a message out of `ohmail/News` back into `INBOX` —
       "no, I want to see this one". A reader observes the move. `isOrganizedFolder('INBOX')` is
       true, so the second seam recorded it as ANOTHER INSTALL's placement (`'peer'`), which is the
       one non-`us` value `rule-retro` admits; the next rule they pressed moved it straight back out
       of the inbox they had just filed it into.

       `'external'` is the truthful answer for a message we already hold: it moved to a folder we
       did not choose, and nothing on the wire says who moved it. */
    const repo = new FakeRepo();
    const raw = eml("reader-drag-1@example.com");

    // It starts in Reads, adopted there — a `peer` row, so the case cannot pass merely because
    // nothing was ever `peer`.
    const first = await ingest(create(READS, raw, "8:20"), repo, { readerMode: true });
    expect(await attributionOf(repo, first.messageId), "the premise: a peer row in Reads").toBe("peer");

    const seen = await ingest(moved("INBOX", raw, "1:20"), repo, { readerMode: true });

    expect(seen.messageId, "a second row was written instead of the move being adopted")
      .toBe(first.messageId);
    // A reader answers `adopt_external`, never `move`: the mailbox is the master.
    expect(seen.action).toEqual({ type: "adopt_external", newDesired: "INBOX" });
    expect(await repo.getFolderState(first.messageId)).toEqual({
      desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "external",
    });
  });

  it("…and a move INTO an ohmail folder is 'external' too — the destination decides nothing",
    async () => {
      /* The half that makes the case above about EVIDENCE rather than about `INBOX`. A move the
         other organizer really did make — `INBOX` → the gate, on a message we already hold — reads
         identically on the wire to a person dragging mail into that same folder, so it is adopted
         as their hand as well. THE NAMED COST of this fix, asserted rather than left implicit: that
         placement is now out of a pressed rule's reach, which is the import hold's bargain — a
         placement standing on the master is kept as it stands. Reinstating `'peer'` here needs a
         per-message fact on the wire, not a better guess about folders. */
      const repo = new FakeRepo();
      const raw = eml("reader-move-1@example.com");

      const first = await ingest(create("INBOX", raw, "1:22"), repo, { readerMode: true });
      expect(await attributionOf(repo, first.messageId)).toBe("peer");

      const seen = await ingest(moved(GATE, raw, "9:22"), repo, { readerMode: true });
      expect(seen.messageId).toBe(first.messageId);
      expect(await repo.getFolderState(first.messageId)).toEqual({
        desiredFolder: GATE, observedFolder: GATE, lastSetBy: "external",
      });
    });

  it("…and the same move into the customer's OWN folder is 'external'", async () => {
    // Unchanged by the narrowing above, and kept because it is the case that would go on passing if
    // the adopt seam were deleted altogether: a person dragging mail into a folder they made still
    // wins, and still reads as their hand.
    const repo = new FakeRepo();
    const raw = eml("reader-move-2@example.com");

    const first = await ingest(create("INBOX", raw, "1:21"), repo, { readerMode: true });
    await ingest(moved(ARCHIVE, raw, "77:21"), repo, { readerMode: true });

    expect(await attributionOf(repo, first.messageId)).toBe("external");
  });

  it("a reader still reads no rules, builds no classifier and spends nothing", async () => {
    /* The invariant the fix may not break, with doubles that THROW rather than record.

       THE SENDER IS A KNOWN CONTACT, which is what makes this discriminate: an unknown sender gets
       `destination: 'ohmail/Screener'` out of the rules and the AI gate requires
       `decision.destination == null`, so with a stranger it would pass whether the early return
       existed or not. */
    const repo = new FakeRepo();
    repo.senders.add(SENDER);
    const routing = new FakeRouting();

    const res = await ingest(create(GATE, eml("reader-quiet-1@example.com"), "9:3"), repo, {
      readerMode: true, classifier: forbiddenClassifier, credits: forbiddenGate(), routing,
    });

    expect((await repo.getFolderState(res.messageId))!.desiredFolder).toBe(GATE);
    expect(routing.decisions).toEqual([]);
    expect(routing.approvals).toEqual([]);
  });

  it("THE CONSENT DIRECTION: a stranger arriving AFTER promotion still meets the gate", async () => {
    /* The positive half of "a stranger's `peer` Imbox row is never screened afterwards, and that is
       correct". The gate is the ARRIVAL moment, so what must hold is that arrivals from then on
       reach it — not that old adoptions are swept back into it, which would be a retroactive
       re-screen of somebody's mail.

       Without this case, "no pass screens a `peer` Imbox row later" would be indistinguishable
       from a gate that had stopped working. */
    const repo = new FakeRepo();

    const res = await ingest(create("INBOX", eml("stranger-after-1@example.com", STRANGER), "1:30"), repo, {
      readerMode: false,
    });

    expect(res.action).toEqual({ type: "move", to: GATE });
    expect(await attributionOf(repo, res.messageId)).toBe("us");
  });

  it("THE PREMISE: the same rule DOES route the same message on the organizer's path", async () => {
    // Without this every assertion above could hold because the rule never matched anything.
    const repo = new FakeRepo();
    repo.rules.push(promotedRule);

    const res = await ingest(create("INBOX", eml("organizer-1@example.com"), "1:9"), repo, {
      readerMode: false,
    });

    expect(res.action).toEqual({ type: "move", to: READS });
    expect(await attributionOf(repo, res.messageId)).toBe("us");
  });
});

/* ══ A READER COMPUTES THE IDENTITY FACT AND MOVES NOTHING (mail 0148), acceptance 6 ══ The fact
   is read once per ingest above the reader and passive returns, so the row a reader stores carries
   it and the account holder's banner does not wait for an organizer elsewhere. */
describe("a reader stores the identity fact and moves nothing", () => {
  const phish = (messageId: string): Buffer => Buffer.from([
    `Message-ID: <${messageId}>`,
    'From: "PostFinance" <causmaticstore@gmail.invalid>',
    `To: ${OWNER}`,
    "Subject: Bitte bestätigen: Reaktivierung Ihrer PostFinance Karte erforderlich",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Bestätigen Sie jetzt.",
  ].join("\r\n"));

  it("ACCEPTANCE: the reader's row carries the fact, desired is the arrival, and nothing moves", async () => {
    const repo = new FakeRepo();
    const plan = await planChange(create("INBOX", phish("reader-phish-1@gmail.invalid"), "1:31"), deps(repo, { readerMode: true }));
    expect(plan.outcome).toBe("new");
    expect(plan.new!.senderCheck).toEqual({ brand: "PostFinance", via: "name" });
    expect(plan.new!.desired).toBe("INBOX");
    const res = await commitChange(plan, { storageCap: UNMETERED_STORAGE_CAP, repo, accountId: "acct-1", mailboxId: "mb-1" });
    expect(res.action).toEqual({ type: "none" });
    expect(repo.changes.some((c) => c.op === "move")).toBe(false);
    const stored = [...repo.rows.values()].find((r) => r.stored.id === res.messageId);
    expect(stored?.input.senderCheck?.brand).toBe("PostFinance");
  });

  it("the passive arm (a folder the person made) carries it too; the Sent copy states none", async () => {
    const repo = new FakeRepo();
    const passive = await planChange(create(ARCHIVE, phish("passive-phish-1@gmail.invalid"), "7:1", true), deps(repo));
    expect(passive.new!.senderCheck?.brand).toBe("PostFinance");
    const sentCopy = await planChange({
      type: "create", locator: { folder: "Sent", ref: "3:1" }, raw: phish("sent-phish-1@gmail.invalid"),
      seen: true, ownAuthored: true,
    }, deps(repo));
    expect(sentCopy.new!.senderCheck).toBeNull();
  });
});
