import { describe, it, expect } from "vitest";
import { planChange, commitChange , UNMETERED_STORAGE_CAP} from "../src/pipeline.js";
import { FakeRepo } from "./fakes.js";
import type { Change, PlanDeps } from "../src/ports.js";

/**
 * TWO PHYSICAL COPIES OF ONE MESSAGE IN ONE FOLDER — the second production stall.
 *
 * ── WHAT WAS MEASURED ──────────────────────────────────────────────────────────────────────────
 *
 * A live mailbox, connected three days, `initial_import_completed_at` NULL, and NOT importing: its
 * message count was flat to the row over fifteen minutes of continuous cycling. Its INBOX reported
 * `exists` well above its known instances — every UID enumerated and their full RFC822
 * bodies re-downloaded on every cycle, for ever — and the folder cursor's `uidnext` had been held at
 * 0 since the day the mailbox was created, because `fetchCapped` truncated on every pass.
 *
 * ── THE MECHANISM ──────────────────────────────────────────────────────────────────────────────
 *
 * `updateLocator` MOVES the message's one primary instance (`setPrimaryInstance` is an UPDATE of the
 * primary row, not an insert). So with two copies of one logical message in one folder, only one of
 * them can ever be in the known-set, and repointing hands the other back as an unknown UID:
 *
 *     cycle 1: uid 400 known, uid 900 unknown → fetch 900 → duplicate → primary moves to 900
 *     cycle 2: uid 900 known, uid 400 unknown → fetch 400 → duplicate → primary moves to 400
 *
 * The mailbox is a re-imported one; nothing about it is exotic. Every test below is written so that
 * restoring the unconditional `await repo.updateLocator(...)` in `commitChange` turns it red.
 */

const INBOX = "INBOX";

function eml(messageId: string): Buffer {
  return Buffer.from([
    `Message-ID: <${messageId}>`,
    "From: anna@example.com",
    "To: owner@example.com",
    "Subject: die Rechnung",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Anbei die Rechnung.",
  ].join("\r\n"));
}

const deps = (repo: FakeRepo): PlanDeps => ({ repo, accountId: "acct-1", mailboxId: "mb-1" });

async function ingest(change: Change, repo: FakeRepo) {
  const plan = await planChange(change, deps(repo));
  return commitChange(plan, { repo, accountId: "acct-1", mailboxId: "mb-1", storageCap: UNMETERED_STORAGE_CAP });
}

const create = (raw: Buffer, ref: string, folder = INBOX): Change =>
  ({ type: "create", locator: { folder, ref }, raw, seen: true });

/** Every locator this mailbox would present to the adapter as ALREADY KNOWN. */
const knownRefs = (repo: FakeRepo): string[] =>
  [...repo.instances.values()].filter((i) => i.folder === INBOX).map((i) => i.ref).sort();

describe("a second physical copy in the SAME folder", () => {
  it("becomes KNOWN instead of displacing the first — no oscillation", async () => {
    // Restore the unconditional `updateLocator` and `knownRefs` holds ONE ref after the second
    // ingest, not two: `expected [ '42:900' ] to have a length of 2`. That single ref is the loop.
    const repo = new FakeRepo();
    const raw = eml("dup-1@example.com");

    const first = await ingest(create(raw, "42:400"), repo);
    expect(first.outcome).toBe("new");
    expect(knownRefs(repo)).toEqual(["42:400"]);
    // The first ingest is an ordinary arrival and legitimately files this stranger to the Screener;
    // what must produce NO further delta is the second copy.
    const changesAfterFirst = repo.changes.length;

    const second = await ingest(create(raw, "42:900"), repo);

    expect(second.outcome).toBe("duplicate");
    expect(second.messageId).toBe(first.messageId);
    // ONE logical message…
    expect(repo.rows.size).toBe(1);
    // …and BOTH physical copies known, which is the whole fix: neither body is ever fetched again.
    expect(knownRefs(repo)).toEqual(["42:400", "42:900"]);
    // The message keeps the locator it already had. Repointing on the strength of a second copy is
    // the same class of mistake `external_copy` exists to refuse — a delivery deciding something.
    expect(repo.rows.get(first.messageId)!.stored.nativeLocator)
      .toEqual({ folder: INBOX, ref: "42:400" });
    // NOTHING moved and no client is told anything happened.
    expect(repo.changes.length).toBe(changesAfterFirst);
    expect(repo.audits).toEqual([]);
  });

  it("stays converged when the copies are re-observed in either order", async () => {
    // The oscillation needed only two cycles to be visible. Four re-observations, alternating, must
    // leave the known-set and the locator untouched.
    const repo = new FakeRepo();
    const raw = eml("dup-2@example.com");
    const first = await ingest(create(raw, "42:400"), repo);
    await ingest(create(raw, "42:900"), repo);

    for (const ref of ["42:400", "42:900", "42:400", "42:900"]) {
      const again = await ingest(create(raw, ref), repo);
      expect(again.outcome).toBe("duplicate");
    }

    expect(repo.rows.size).toBe(1);
    expect(knownRefs(repo)).toEqual(["42:400", "42:900"]);
    expect(repo.rows.get(first.messageId)!.stored.nativeLocator)
      .toEqual({ folder: INBOX, ref: "42:400" });
  });

  it("STILL repoints on a UIDVALIDITY renumbering, where the stored locator is meaningless", async () => {
    // The discrimination the fix rests on. A different epoch is not a second copy — every prior UID
    // in the folder has been renumbered, so keeping the old locator would leave the row addressable
    // by nothing. Change `epochOfRef(...) === epochOfRef(...)` to a constant `true` and this goes red.
    const repo = new FakeRepo();
    const raw = eml("dup-3@example.com");
    const first = await ingest(create(raw, "42:400"), repo);

    const renumbered = await ingest(create(raw, "77:12"), repo);

    expect(renumbered.outcome).toBe("duplicate");
    expect(repo.rows.get(first.messageId)!.stored.nativeLocator)
      .toEqual({ folder: INBOX, ref: "77:12" });
    // The dead epoch's instance does not linger as a phantom known locator.
    expect(knownRefs(repo)).toEqual(["77:12"]);
  });

  it("re-asserting the SAME locator is a replay, and changes nothing", async () => {
    const repo = new FakeRepo();
    const raw = eml("dup-4@example.com");
    const first = await ingest(create(raw, "42:400"), repo);

    const replay = await ingest(create(raw, "42:400"), repo);

    expect(replay.outcome).toBe("duplicate");
    expect(knownRefs(repo)).toEqual(["42:400"]);
    expect(repo.rows.get(first.messageId)!.stored.nativeLocator)
      .toEqual({ folder: INBOX, ref: "42:400" });
  });

  it("a VANISHED primary is repaired by ANY live copy, whatever its uid", async () => {
    // Review round 4: an observed expunge with nothing to promote leaves `native_locator` on a
    // dead UID "for the reaper to find" — and an OLDER surviving copy arriving as a pure create
    // must repoint to it, not be filed away as a non-primary the known-set then hides for ever.
    const repo = new FakeRepo();
    const raw = eml("dup-7@example.com");
    const first = await ingest(
      { type: "create", locator: { folder: "Sent", ref: "42:20" }, raw, seen: true, ownAuthored: true },
      repo,
    );
    // The only copy is expunged: nothing to promote, the row's locator is now dead.
    await repo.forgetInstanceAt("mb-1", { folder: "Sent", ref: "42:20" });
    expect(await repo.primaryInstanceVanished(first.messageId)).toBe(true);

    // An OLDER copy surfaces (below the dead uid — `arrivalIsNewer` is false).
    const survivor = await ingest(
      { type: "create", locator: { folder: "Sent", ref: "42:19" }, raw, seen: true, ownAuthored: true },
      repo,
    );
    expect(survivor.outcome).toBe("duplicate");
    expect(repo.rows.get(first.messageId)!.stored.nativeLocator)
      .toEqual({ folder: "Sent", ref: "42:19" });
    expect(await repo.primaryInstanceVanished(first.messageId)).toBe(false);

    // …and for an INBOUND copy too (review round 6): the repair must run AHEAD of the ordinary
    // second-copy recording, or a non-own-authored duplicate of a vanished primary is filed
    // away as non-primary and the dead locator is never repaired. Locator repair is not
    // placement — the adoption boundary is not in play.
    const repo2 = new FakeRepo();
    const raw2 = eml("dup-8@example.com");
    const inboxFirst = await ingest(create(raw2, "42:30"), repo2);
    await repo2.forgetInstanceAt("mb-1", { folder: INBOX, ref: "42:30" });
    expect(await repo2.primaryInstanceVanished(inboxFirst.messageId)).toBe(true);
    const inboxSurvivor = await ingest(create(raw2, "42:29"), repo2);
    expect(inboxSurvivor.outcome).toBe("duplicate");
    expect(repo2.rows.get(inboxFirst.messageId)!.stored.nativeLocator)
      .toEqual({ folder: INBOX, ref: "42:29" });
  });

  it("promotes the surviving copy when the primary is expunged", async () => {
    // The residual the fix creates, and its closure. Before this change the repair happened by
    // accident — the survivor came back as an unknown UID and dragged the primary to itself — which
    // IS the oscillation. So the invariant has to be restored deliberately: `messages.native_locator`
    // names an instance that exists.
    //
    // Delete the promotion block from `forgetInstanceAt` (in `drizzle-repo.ts` and in `fakes.ts`) and
    // the last assertion here reads `{ folder: 'INBOX', ref: '42:400' }` — a UID the server no longer
    // holds, which every read through a locator then fails on.
    const repo = new FakeRepo();
    const raw = eml("dup-5@example.com");
    const first = await ingest(create(raw, "42:400"), repo);
    await ingest(create(raw, "42:900"), repo);

    // The customer deletes one of the two copies in their own mail client — the one the row names.
    await repo.forgetInstanceAt("mb-1", { folder: INBOX, ref: "42:400" });

    expect(knownRefs(repo)).toEqual(["42:900"]);
    expect(await repo.primaryInstanceVanished(first.messageId)).toBe(false);
    expect(repo.rows.get(first.messageId)!.stored.nativeLocator)
      .toEqual({ folder: INBOX, ref: "42:900" });
  });

  it("the SENT folder is NOT exempt — an own-authored second copy is RECORDED, and the primary converges on it", async () => {
    // The exemption this test used to pin ("a second copy in Sent cannot become a permanently
    // unknown UID, because the watermark is that folder's floor and not the known-set") was
    // FALSIFIED in production, 2026-08-30: the watermark is only a floor once a non-truncated
    // first scan has PUBLISHED it, and a Sent first scan that keeps truncating has no floor at
    // all. A production mailbox held one large message APPENDed three times; the repoint
    // the exemption preserved re-fetched the two non-primary copies on every ~2-minute cycle for
    // weeks, and the truncation their re-fetch guaranteed is what kept the watermark at 0 — the
    // defect maintained its own precondition.
    //
    // The contract is record AND repoint — both halves load-bearing, each with its own mutation:
    //  · drop the `recordInstance(e.messageId, e.storedLocator)` half in `commitChange` and the
    //    both-known assertion goes red (the production re-fetch loop);
    //  · drop the `updateLocator` half and the primary-at-newest assertion goes red (review
    //    round 2: a below-watermark provider replace strands the primary on a dead UID, where
    //    no delete is ever reported and no promotion can run).
    const repo = new FakeRepo();
    const raw = eml("dup-6@example.com");
    const sentRefs = (): string[] =>
      [...repo.instances.values()].filter((i) => i.folder === "Sent").map((i) => i.ref).sort();
    const first = await ingest(
      { type: "create", locator: { folder: "Sent", ref: "42:10" }, raw, seen: true, ownAuthored: true },
      repo,
    );
    const twin = await ingest(
      { type: "create", locator: { folder: "Sent", ref: "42:11" }, raw, seen: true, ownAuthored: true },
      repo,
    );

    expect(twin.outcome).toBe("duplicate");
    // BOTH copies are known — neither is ever an unknown UID again — and the primary converged
    // on the newest observed copy, exactly as Sent always has (the provider-replace repair).
    expect(sentRefs()).toEqual(["42:10", "42:11"]);
    expect(repo.rows.get(first.messageId)!.stored.nativeLocator)
      .toEqual({ folder: "Sent", ref: "42:11" });

    // A THIRD copy: the ping-pong that cannot form. One more observation, still every UID known,
    // primary on the newest — the unknown set is EMPTY next pass, so the scan publishes and rests.
    const third = await ingest(
      { type: "create", locator: { folder: "Sent", ref: "42:12" }, raw, seen: true, ownAuthored: true },
      repo,
    );
    expect(third.outcome).toBe("duplicate");
    expect(sentRefs()).toEqual(["42:10", "42:11", "42:12"]);
    expect(repo.rows.get(first.messageId)!.stored.nativeLocator)
      .toEqual({ folder: "Sent", ref: "42:12" });

    // An OLDER copy arriving AFTER — which is a cold scan's normal order, since `fetchCapped`
    // hands creates over newest-first — is recorded and must NOT drag the primary backward
    // (review round 3: the copy an unconditional repoint would walk back onto is precisely the
    // one the provider-replace pattern expunges).
    const older = await ingest(
      { type: "create", locator: { folder: "Sent", ref: "42:9" }, raw, seen: true, ownAuthored: true },
      repo,
    );
    expect(older.outcome).toBe("duplicate");
    expect(sentRefs()).toEqual(["42:10", "42:11", "42:12", "42:9"]);
    expect(repo.rows.get(first.messageId)!.stored.nativeLocator)
      .toEqual({ folder: "Sent", ref: "42:12" });

    // And an OBSERVED expunge of the primary still promotes a survivor.
    await repo.forgetInstanceAt("mb-1", { folder: "Sent", ref: "42:12" });
    expect(repo.rows.get(first.messageId)!.stored.nativeLocator.folder).toBe("Sent");
    expect(sentRefs()).toEqual(["42:10", "42:11", "42:9"]);
  });
});
