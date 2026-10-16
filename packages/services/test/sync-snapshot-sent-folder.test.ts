import { describe, expect, it } from "vitest";
import { SyncService } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * ═══ MAIL THIS ACCOUNT SENT REACHES A FRESH MIRROR ════════════════════════════════════════
 *
 * The address view's "To them" direction reads the recipients of the account's OWN sent mail off
 * the device — so it depends on those rows being in the mirror at all, and the shape of the code
 * suggests they are not. A sent copy is filed under `folder: "Sent"`, which is NOT one of the six
 * members of the client's `Folder` union and matches no pile view, so it is invisible everywhere
 * a surface reads the mirror BY PILE. `address-book.ts`'s header stated the stronger claim for
 * months — "sent MESSAGES never reach the mirror at all" — and that claim was false.
 *
 * This pins the half that makes it false: `/sync`'s snapshot selects on the account and
 * `deleted_at is null` with NO folder filter, so a Sent-folder row is emitted like any other.
 * (`recordSent` in `packages/core/src/sent-record.ts` is the writer that puts it there; the
 * Sent-folder watch is the backstop behind it.)
 *
 * ── WHY THIS TEST IS HERE AND NOT LEFT AS A READING OF THE QUERY ──────────────────────────
 *
 * Because a folder filter is exactly the kind of thing a later change adds for a good local
 * reason — a pile view that wants only the six, a bootstrap that wants to be smaller — and it
 * would be a silent, total loss of one direction of the address view. Nothing in the address
 * view's own suite could see it: the client-engine tests mint their sent rows locally, and a
 * mirror that never receives them still passes every one of them.
 *
 * PGlite is enough: this is a `select`, with no concurrency and no extension in it.
 */
describe("the /sync snapshot carries Sent-folder mail", () => {
  it("emits a message whose folder is outside the client's six-member union", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const svc = new SyncService();

    // One ordinary inbound row, and one the account SENT. `folder` here is the observed native
    // location, which is what `materializeMessage` reads for a row with no desired folder.
    const inbound = await seedMessage(db, accountId, mailboxId, {
      subject: "from a stranger", folder: "ohmail/Screener",
    });
    const sent = await seedMessage(db, accountId, mailboxId, {
      subject: "my reply", from: "mila@lichtgrat.example", folder: "Sent", desired: "Sent",
    });

    const page = await svc.getSnapshot(ctx, {});
    const emitted = page.changes.filter((c) => c.type === "message").map((c) => c.id);

    // THE POSITIVE CONTROL FIRST: the snapshot is producing messages at all, so the assertion
    // below is about the Sent row being INCLUDED and not about an empty page.
    expect(emitted).toContain(inbound);
    expect(emitted).toContain(sent);

    // …and the row arrives carrying `Sent`, which is what the address view's selector keys on
    // (the from/to/cc fields, never the folder) and what `folderLeaf` labels on screen. A
    // snapshot that rewrote the folder to one of the six would be a different defect with the
    // same consequence.
    const dto = page.changes.find((c) => c.type === "message" && c.id === sent)?.entity as
      | { folder?: string }
      | undefined;
    expect(dto?.folder).toBe("Sent");
  });
});
