import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { messages } from "@trafficflow/db";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { planChange, commitChange, UNMETERED_STORAGE_CAP } from "@trafficflow/core";
import type { Change } from "@trafficflow/core";
import { ScreenerService } from "../src/screener-service.js";
import { MessageService } from "../src/message-service.js";
import { materializeMessage } from "../src/dto/materialize.js";
import { makeCtx, FakeAdapter } from "./helpers.js";

/**
 * THE REPORTED SEQUENCE, measured whole: screened in, moved to the Ohbox, READ — does anything
 * on that path lose the read's `lastReadAt` stamp or mint a second row? An unstamped read row
 * is what the old "Earlier" comparator filed months down the list. Against the real pipeline
 * and services, including the part no unit ever watched: the worker's physical move observed
 * back as a fresh arrival under a NEW uid, twice, because the flags race the read (`\Seen` not
 * yet applied, then applied). Both echoes must dedup into ONE row and touch no read state.
 */

const ARRIVED = new Date("2026-09-18T13:19:00.000Z");
const READ_AT = new Date("2026-09-18T13:24:00.000Z");

function inviteEml(mid: string): Buffer {
  return Buffer.from([
    `Message-ID: <${mid}>`,
    "From: organizer@cal.example",
    "To: a@example.test",
    "Subject: Invitation: Sync @ Tue Sep 29, 2026 10am (CEST)",
    `Date: ${ARRIVED.toUTCString()}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "You have been invited.",
  ].join("\r\n"));
}

describe("screen -> move -> read -> the move's echo: one row, the stamp survives", () => {
  it("keeps unread=false, lastReadAt and sortAt through both flag arms of the re-observation", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx(READ_AT);
    const repo = makeDrizzleRepo(db);
    const mid = `inv-${randomUUID()}@cal.example`;
    const raw = inviteEml(mid);

    // 1 — the arrival, at the gate: a stranger's mail plans to ohmail/Screener.
    const arrival: Change = {
      type: "create", locator: { folder: "INBOX", ref: "1:100" }, raw, internalDate: ARRIVED,
    };
    const plan = await planChange(arrival, { repo, accountId, mailboxId, routing: repo, readerMode: false });
    const { messageId } = await repo.transaction((tx) =>
      commitChange(plan, { repo: tx, routing: tx, accountId, mailboxId, storageCap: UNMETERED_STORAGE_CAP }));
    const dto0 = await materializeMessage(db, accountId, messageId);
    expect(dto0!.folder).toBe("ohmail/Screener");

    // 2 — the decision: into the Ohbox.
    const screener = new ScreenerService({ adapter: new FakeAdapter() });
    await screener.decide(ctx, messageId, { decision: "yes" });
    expect((await materializeMessage(db, accountId, messageId))!.folder).toBe("INBOX");

    // 3 — the read, exactly as the webapp's dwell commits it.
    await new MessageService().markSeen(ctx, { ids: [messageId], unread: false });
    const read = await materializeMessage(db, accountId, messageId);
    expect(read!.unread).toBe(false);
    expect(read!.lastReadAt).toBe(READ_AT.toISOString());

    // 4 — the worker's physical move, observed back as a fresh arrival in INBOX under a new
    //     UID. First while `\Seen` has NOT landed (the race the read opens), then once it has.
    for (const [ref, seen] of [["2:501", false], ["2:501", true]] as const) {
      const echo: Change = {
        type: "create", locator: { folder: "INBOX", ref }, raw, seen,
        internalDate: ARRIVED,
      };
      const echoPlan = await planChange(echo, { repo, accountId, mailboxId, routing: repo, readerMode: false });
      await repo.transaction((tx) =>
        commitChange(echoPlan, { repo: tx, routing: tx, accountId, mailboxId, storageCap: UNMETERED_STORAGE_CAP }));

      // ONE row — the dedup recognised its own move; a second row would be an unstamped twin.
      const rows = await db.select({ id: messages.id, unread: messages.unread })
        .from(messages).where(eq(messages.accountId, accountId));
      expect(rows, `after echo seen=${seen}`).toHaveLength(1);

      // …and the read state is untouched: still read, still stamped at the read instant,
      // still sorting at its arrival.
      const dto = await materializeMessage(db, accountId, messageId);
      expect(dto!.unread, `unread after echo seen=${seen}`).toBe(false);
      expect(dto!.lastReadAt, `stamp after echo seen=${seen}`).toBe(READ_AT.toISOString());
      expect(dto!.sortAt).toBe(ARRIVED.toISOString());
    }
  });
});
