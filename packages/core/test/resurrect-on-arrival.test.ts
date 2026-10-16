import { describe, it, expect } from "vitest";
import { planChange, commitChange, UNMETERED_STORAGE_CAP } from "../src/pipeline.js";
import type { Change, MessageBodyInput, BodyStorageContext } from "../src/ports.js";
import { FakeRepo, FakeAdapter } from "./fakes.js";

/**
 * ═══ A RE-APPEARANCE UN-DELETES AND REFILLS, WHATEVER AUTHORED THE ARRIVAL (mail 0065) ═══════
 *
 * The failure this pins was found by reading the code, not in the field, and it is the nastiest shape of
 * the tombstone feature: OUR OWN completed move whose bookkeeping crashed. The next cycle sees
 * the source delete (reaper tombstones the instanceless row) and the destination create — which
 * classifies as an EXISTING arrival whose action is `none`/`own_move`, not `adopt_external`. A
 * clear that lived only in the adopt arm would leave that message deleted for ever while it sat
 * in its intended destination. So `commitChange`'s existing path clears the tombstone for EVERY
 * arrival shape, restores a `junk_filed`/`expunged` husk from the arrival's own bytes, and emits
 * the resurrection `update` for arms whose switch records no change of their own.
 *
 * FakeRepo carries neither optional method, which is itself half the guard: the calls are
 * optional-chained, so the whole pre-0065 fake population keeps passing untouched — asserted by
 * this file compiling against the unmodified FakeRepo and by the tracked subclass below.
 *
 * Mutation watched (restored, 2026-08-23): gate `clearDeletedOnAdopt` back to the adopt arm
 * only ⇒ the duplicate-arrival test red (`cleared` empty, no resurrection update).
 */

const RAW = Buffer.from([
  "Message-ID: <resurrect-1@example.test>",
  "From: stranger@example.test",
  "To: mila@lichtgrat.example",
  "Subject: back from the dead",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "the body that comes back",
].join("\r\n"));

class TrackedRepo extends FakeRepo {
  cleared: string[] = [];
  restored: Array<{ messageId: string; text: string }> = [];
  /** Answers true once — the row "was tombstoned" — then false, like the real UPDATE. */
  private tombstoned = new Set<string>();
  tombstone(messageId: string): void { this.tombstoned.add(messageId); }
  async clearDeletedOnAdopt(messageId: string): Promise<boolean> {
    this.cleared.push(messageId);
    return this.tombstoned.delete(messageId);
  }
  async restoreWithheldBody(
    messageId: string, body: MessageBodyInput, _storage: BodyStorageContext,
  ): Promise<boolean> {
    this.restored.push({ messageId, text: body.text });
    return true;
  }
}

const create = (folder: string, ref: string): Change => ({ type: "create", locator: { folder, ref }, raw: RAW });

async function ingest(repo: TrackedRepo, ch: Change): Promise<string> {
  const deps = { repo, accountId: "acct-1", mailboxId: "mb-1" };
  const plan = await planChange(ch, deps);
  const res = await commitChange(plan, { ...deps, storageCap: UNMETERED_STORAGE_CAP });
  return res.messageId;
}

describe("mail 0065 — the existing-arrival path clears tombstones and refills husks", () => {
  it("a DUPLICATE arrival (action: none) clears the tombstone, restores the body, emits the update", async () => {
    const repo = new TrackedRepo();
    const adapter = new FakeAdapter();
    void adapter;
    const id = await ingest(repo, create("INBOX", "1:10"));
    repo.tombstone(id);
    const before = repo.changes.length;

    // The same message appears again in the same folder at a new UID — the second-delivery
    // shape, whose action is `none`: exactly the arm the adopt-only clear missed.
    const again = await ingest(repo, create("INBOX", "1:11"));
    expect(again).toBe(id);
    expect(repo.cleared).toContain(id);
    // The husk restore was offered the arrival's own bytes.
    expect(repo.restored.map((r) => r.messageId)).toContain(id);
    expect(repo.restored[0]!.text).toContain("the body that comes back");
    // The resurrection delta: one message `update` beyond what stood before, so a client
    // holding the tombstone lives again on the next drain.
    const news = repo.changes.slice(before).filter((c) => c.entityType === "message" && c.entityId === id);
    expect(news.map((c) => c.op)).toContain("update");
  });

  it("a live row's duplicate arrival emits NO resurrection update — nothing was resurrected", async () => {
    const repo = new TrackedRepo();
    const id = await ingest(repo, create("INBOX", "1:10"));
    const before = repo.changes.length;
    await ingest(repo, create("INBOX", "1:12"));
    // The clear was ASKED (every arrival shape asks) and answered false; no delta follows.
    expect(repo.cleared).toContain(id);
    const news = repo.changes.slice(before).filter((c) => c.entityType === "message" && c.entityId === id && c.op === "update");
    expect(news).toEqual([]);
  });

  it("a repo WITHOUT the optional methods — every pre-0065 fake — ingests duplicates untouched", async () => {
    const repo = new FakeRepo();
    const deps = { repo, accountId: "acct-1", mailboxId: "mb-1" };
    const plan1 = await planChange(create("INBOX", "1:10"), deps);
    const first = await commitChange(plan1, { ...deps, storageCap: UNMETERED_STORAGE_CAP });
    const plan2 = await planChange(create("INBOX", "1:11"), deps);
    const second = await commitChange(plan2, { ...deps, storageCap: UNMETERED_STORAGE_CAP });
    expect(second.messageId).toBe(first.messageId);
  });
});
