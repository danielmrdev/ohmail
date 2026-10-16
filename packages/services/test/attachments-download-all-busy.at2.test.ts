import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { randomUUID } from "node:crypto";
import { attachments as attachmentsTbl } from "@trafficflow/db";
import {
  AttachmentsService, downloadAllOpenFailure, type OpenAdapter,
} from "../src/attachments-service.js";
import { ServiceError } from "../src/errors.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * **WHAT `_errors.txt` SAYS WHEN THE CONNECTION CAP REFUSES.**
 *
 * `downloadAll` deliberately skips a mailbox it cannot open rather than losing the whole archive,
 * and writes the reason into `_errors.txt`. That reason was the single string "mail server
 * unavailable", which was true of every failure it could then produce. Since that change there is another:
 * the API's `makeOpenAdapter` refuses with `mailbox_busy` when the mailbox already has as many
 * live IMAP connections as this deployment will open at once.
 *
 * "Mail server unavailable" is false of that case in every particular — the server is fine, the
 * refusal is ours, and the fix is to wait rather than anything the user could do about a provider.
 * Claims are contracts, and a line in `_errors.txt` is the only claim the user is left holding
 * about a file they asked for and did not get.
 */

const svc = new AttachmentsService();

async function seedAtt(
  db: Awaited<ReturnType<typeof makeCtx>>["db"], accountId: string, messageId: string,
): Promise<string> {
  const [row] = await db.insert(attachmentsTbl).values({
    accountId, messageId,
    filename: `report-${randomUUID()}.pdf`,
    contentType: "application/pdf",
    sizeBytes: 1024, inline: false, partId: "2",
  }).returning();
  return row!.id;
}

/** Read `_errors.txt` back out of the produced archive. */
async function errorsIn(zip: Uint8Array): Promise<string> {
  const archive = await JSZip.loadAsync(zip);
  const entry = archive.file("_errors.txt");
  return entry ? entry.async("string") : "";
}

describe("download-all reports a capped mailbox truthfully", () => {
  it("a `mailbox_busy` refusal is NOT reported as the mail server being unavailable", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await seedAtt(db, accountId, messageId);

    const openAdapter: OpenAdapter = async () => {
      throw new ServiceError(
        "mailbox_busy", 429, "this mailbox already has as many live connections as we will open at once",
        { retryAfter: 10 }, true,
      );
    };

    const { zip } = await svc.downloadAll(ctx, { messageId }, { openAdapter });
    const text = await errorsIn(zip);

    expect(text).not.toMatch(/mail server unavailable/);
    // It names the real cause and the action, and nothing about credentials — the lie the cap is about.
    expect(text).toMatch(/live connections/);
    expect(text).toMatch(/try again/);
    expect(text).not.toMatch(/password|credential/i);
  });

  /* ZIP-ROUTES-SAY-A-REFUSED-OPEN-AS-UNAVAILABLE: every other open failure was "mail server
     unavailable". A named refusal (the byte routes hand the mail server's over typed) is said in its
     own sentence; an unnamed throw is ohmail's. Consumer: the line a person reads in `_errors.txt`. */
  it("a named refusal is said in its own sentence, and an unnamed throw is ohmail's", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await seedAtt(db, accountId, messageId);

    const refused: OpenAdapter = async () => {
      throw new ServiceError("mail_server_login_refused", 424, "your mail server refused the sign-in", undefined, false);
    };
    expect(await errorsIn((await svc.downloadAll(ctx, { messageId }, { openAdapter: refused })).zip))
      .toMatch(/: skipped — your mail server refused the sign-in/);

    const ours: OpenAdapter = async () => { throw new Error("ECONNREFUSED"); };
    const text = await errorsIn((await svc.downloadAll(ctx, { messageId }, { openAdapter: ours })).zip);
    expect(text).toMatch(/: skipped — ohmail could not open this mailbox/);
    expect(text).not.toMatch(/mail server/);
  });

  it("the busy sentence is chosen by CODE, not by matching a message", async () => {
    // A message probe would be defeated by a provider whose text happens to contain the word, and
    // by any rewording of our own refusal. The code is the contract between this file and
    // `packages/api/src/attachments-adapter.ts`.
    const decoy = new ServiceError("upstream_unavailable", 502, "mailbox_busy");
    expect(downloadAllOpenFailure(decoy)).toBe("skipped — mailbox_busy");

    const real = new ServiceError("mailbox_busy", 429, "anything at all");
    expect(downloadAllOpenFailure(real)).toMatch(/live connections/);
  });
});
