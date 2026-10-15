import { describe, it, expect } from "vitest";
import { FakeRepo, FakeAdapter } from "./fakes.js";
import type { NativeLocator } from "../src/ports.js";

describe("ports contract (in-memory fakes)", () => {
  it("FakeRepo returns null for an unknown dedup key", async () => {
    const repo = new FakeRepo();
    expect(await repo.findByDedupKey("mb-1", "mid:none")).toBeNull();
  });

  it("FakeRepo inserts and finds a message by dedup key", async () => {
    const repo = new FakeRepo();
    const loc: NativeLocator = { folder: "INBOX", ref: "1:5" };
    const stored = await repo.insertMessage({ senderCheck: null,
      accountId: "acct-1", mailboxId: "mb-1",
      canonical: { messageIdHeader: "a@b", bodyHash: "h" },
      dedupKey: "mid:a@b", subject: "Hi", fromAddress: "a@b.example", date: null,
      nativeLocator: loc,
      flags: { no_ai: false, no_forward: false, no_kb: false, priority: false },
    });
    expect(stored.id).toMatch(/^msg-/);
    const found = await repo.findByDedupKey("mb-1", "mid:a@b");
    expect(found?.id).toBe(stored.id);
    expect(found?.nativeLocator).toEqual(loc);
  });

  it("FakeRepo round-trips folder state and updates the locator", async () => {
    const repo = new FakeRepo();
    const stored = await repo.insertMessage({ senderCheck: null,
      accountId: "acct-1", mailboxId: "mb-1",
      canonical: { messageIdHeader: "a@b", bodyHash: "h" },
      dedupKey: "mid:a@b", subject: "", fromAddress: "", date: null,
      nativeLocator: { folder: "INBOX", ref: "1:5" },
      flags: { no_ai: false, no_forward: false, no_kb: false, priority: false },
    });
    await repo.upsertFolderState(stored.id, { desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" });
    expect(await repo.getFolderState(stored.id))
      .toEqual({ desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" });
    await repo.updateLocator(stored.id, { folder: "ohmail/News", ref: "1:9" });
    expect((await repo.findByDedupKey("mb-1", "mid:a@b"))?.nativeLocator)
      .toEqual({ folder: "ohmail/News", ref: "1:9" });
    await repo.recordAudit("acct-1", "move", { a: 1 }, { a: 0 });
    expect(repo.audits).toHaveLength(1);
  });

  /**
   * ── THIS ASSERTION REPLACES A COMMITTED ONE THAT WAS WRONG ──────────────────────────
   *
   * It used to read "FakeRepo rejects a duplicate dedup key (mirrors the DB unique constraint)"
   * and assert `rejects.toThrow(/duplicate dedupKey/)`. **The production port does the opposite.**
   * `DrizzleRepo.insertMessage` is `ON CONFLICT DO NOTHING` + a re-read: the constraint exists,
   * but the port ABSORBS it and converges on the winner's row rather than raising. The old name
   * described the schema and then asserted it of the method.
   *
   * It is not being weakened to make something pass — it is being corrected, and the new consumer
   * is named: `pipeline.ts#commitChange` now reads `created` to decide whether it owns the child
   * rows. While the fake threw, a second writer could never reach that code in a fake-based test,
   * which is why two duplicated `attachments` rows and a duplicated `message`/`create` delta
   * survived in `commitChange` and were only visible on real Postgres.
   */
  it("FakeRepo converges a duplicate dedup key on the winner's row, as the real port does", async () => {
    const repo = new FakeRepo();
    const input = { senderCheck: null,
      accountId: "acct-1", mailboxId: "mb-1",
      canonical: { messageIdHeader: "a@b", bodyHash: "h" },
      dedupKey: "mid:a@b", subject: "", fromAddress: "", date: null,
      nativeLocator: { folder: "INBOX", ref: "1:5" },
      flags: { no_ai: false, no_forward: false, no_kb: false, priority: false },
    };
    const winner = await repo.insertMessage(input);
    expect(winner.created).toBe(true);

    // The message has since been moved; a re-ingest arriving with the ORIGINAL arrival locator
    // must not drag the primary instance back to it.
    await repo.updateLocator(winner.id, { folder: "ohmail/News", ref: "1:9" });

    const loser = await repo.insertMessage(input);
    expect(loser.id, "the loser gets the winner's row, it does not raise").toBe(winner.id);
    expect(loser.created, "and it must be able to TELL that it lost").toBe(false);

    const primaries = [...repo.instances.values()].filter((i) => i.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]!.folder, "a duplicate insert must not re-assert the primary")
      .toBe("ohmail/News");
  });

  it("FakeAdapter records moves and returns a new locator", async () => {
    const adapter = new FakeAdapter();
    const out = await adapter.move({ folder: "INBOX", ref: "1:5" }, "ohmail/News");
    expect(out.folder).toBe("ohmail/News");
    expect(out.ref).toMatch(/^1:\d+$/);
    expect(adapter.moves).toEqual([{ from: { folder: "INBOX", ref: "1:5" }, to: "ohmail/News" }]);
  });
});
