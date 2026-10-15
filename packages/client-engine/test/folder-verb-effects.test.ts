import { describe, expect, it } from "vitest";
import { MemoryMirrorStore } from "../src/store.js";
import { mutationEffects } from "../src/mutations.js";
import type { FolderEntity } from "../src/types.js";

/**
 * THE FOLDER VERBS' LOCAL EFFECTS (FOLDERS-SPEC.md stage 2) — pending MARKERS, never pretended
 * completion. What each effect must and must not paint:
 *
 *  · create — a full optimistic row under the client-local id, wearing `op:{kind:"create"}`;
 *    the address borrowed from a sibling of the SAME mailbox; an empty name yields NO effects
 *    (rejected — the wire would 400 and a nameless row renders nothing).
 *  · rename — the marker with the target; `name` STAYS the mailbox's truth, because every join
 *    (the folder view, the counts, the tail verdict) runs on `name` and an optimistic swap
 *    would strand them against messages the worker has not moved yet.
 *  · delete — the marker only; the row ghosts and the worker's tombstones remove it. Hiding it
 *    instantly would claim a mailbox state that can still fail.
 *  · dismiss — only a FAILED command has one; a failed create tombstones its never-created
 *    row, anything else sheds the marker. A settled folder yields [] (rejected: nothing owed).
 */

const CTX = { now: () => new Date("2026-08-26T12:00:00.000Z"), uuid: () => "u-1" };

const folder = (over: Partial<FolderEntity> = {}): FolderEntity => ({
  id: "f-1", name: "Proj", mailboxId: "mb-1", mailbox: "own@example.com", ...over,
});

async function seeded(entities: FolderEntity[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  for (const f of entities) await store.putLocal("folder", f.id, f);
  return store;
}

describe("folder_create", () => {
  it("paints the optimistic row under the client-local id, marker on, address borrowed from a same-mailbox sibling", async () => {
    const r = await seeded([folder()]);
    const fx = mutationEffects(r, { kind: "folder_create", folderId: "local-9", mailboxId: "mb-1", name: "Proj 2" }, CTX);
    expect(fx).toHaveLength(1);
    const e = fx[0]!.entity as FolderEntity;
    expect(fx[0]!.id).toBe("local-9");
    expect(e.name).toBe("Proj 2");
    expect(e.mailbox).toBe("own@example.com");
    expect(e.op).toEqual({ kind: "create" });
  });

  it("an empty name yields NO effects — rejected, nothing optimistic to roll back", async () => {
    const r = await seeded([]);
    expect(mutationEffects(r, { kind: "folder_create", folderId: "x", mailboxId: "mb-1", name: "   " }, CTX)).toEqual([]);
  });
});

describe("folder_rename", () => {
  it("wears the target in the marker and KEEPS the mailbox's name — the joins stay consistent", async () => {
    const r = await seeded([folder()]);
    const fx = mutationEffects(r, { kind: "folder_rename", folderId: "f-1", name: "Neu" }, CTX);
    const e = fx[0]!.entity as FolderEntity;
    expect(e.name).toBe("Proj");
    expect(e.op).toEqual({ kind: "rename", to: "Neu" });
  });

  it("an unknown id or a no-op name yields [] — the row settled (or vanished) under the cursor", async () => {
    const r = await seeded([folder()]);
    expect(mutationEffects(r, { kind: "folder_rename", folderId: "gone", name: "X" }, CTX)).toEqual([]);
    expect(mutationEffects(r, { kind: "folder_rename", folderId: "f-1", name: "Proj" }, CTX)).toEqual([]);
  });
});

describe("folder_delete", () => {
  it("marks — never removes: the tombstones are the worker's to send", async () => {
    const r = await seeded([folder()]);
    const fx = mutationEffects(r, { kind: "folder_delete", folderId: "f-1" }, CTX);
    const e = fx[0]!.entity as FolderEntity;
    expect(e).not.toBeNull();
    expect(e.op).toEqual({ kind: "delete" });
  });
});

describe("folder_op_dismiss", () => {
  it("a failed CREATE tombstones its never-created row; a failed rename sheds the marker; a settled row rejects", async () => {
    const r = await seeded([
      folder({ id: "f-c", name: "Nie", op: { kind: "create", error: "bad_name" } }),
      folder({ id: "f-r", name: "Proj", op: { kind: "rename", to: "Neu", error: "exists" } }),
      folder({ id: "f-p", name: "Pending", op: { kind: "create" } }),
      folder({ id: "f-s", name: "Settled" }),
    ]);
    const gone = mutationEffects(r, { kind: "folder_op_dismiss", folderId: "f-c" }, CTX);
    expect(gone[0]!.entity).toBeNull();

    const shed = mutationEffects(r, { kind: "folder_op_dismiss", folderId: "f-r" }, CTX);
    const e = shed[0]!.entity as FolderEntity;
    expect(e.name).toBe("Proj");
    expect(e.op).toBeUndefined();

    // A PENDING command has no dismiss — the worker may be mid-execution.
    expect(mutationEffects(r, { kind: "folder_op_dismiss", folderId: "f-p" }, CTX)).toEqual([]);
    expect(mutationEffects(r, { kind: "folder_op_dismiss", folderId: "f-s" }, CTX)).toEqual([]);
  });
});
