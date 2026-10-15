/* @reads: packages/services/src/sync-service.ts packages/services/src/dto/ packages/api/src/routes/sync.ts packages/client-engine/src/ */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { attachments as attachmentsTbl } from "@trafficflow/db";
import { AttachmentsService } from "../src/attachments-service.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * AN ATTACHMENT'S SECTION IS THE SERVER'S, CACHED HERE, AND NO CLIENT HOLDS A COPY. The door may
 * rewrite `part_id` at a request (`repairedPart`), which is invisible to every client only while
 * no synced shape carries it: neither the sync service, its DTOs, the sync route nor the client
 * engine names it, and the attachment list a client reads has no such field.
 */
const REPO = resolve(__dirname, "../../..");
const SOURCES = ["packages/services/src/sync-service.ts", "packages/services/src/dto", "packages/api/src/routes/sync.ts", "packages/client-engine/src"];

function filesUnder(rel: string): string[] {
  const abs = join(REPO, rel);
  if (!statSync(abs).isDirectory()) return [rel];
  return readdirSync(abs).flatMap((f) => filesUnder(join(rel, f))).filter((f) => f.endsWith(".ts"));
}

describe("the attachment's section is in no synced shape", () => {
  it("the sync service, its DTOs, the sync route and the client engine never name it", () => {
    const files = SOURCES.flatMap(filesUnder);
    expect(files.length).toBeGreaterThan(50);
    const naming = files.filter((f) => /\bpartId\b|\bpart_id\b/.test(readFileSync(join(REPO, f), "utf8")));
    expect(naming).toEqual([]);
  });

  it("CONTROL: the reading finds the name where it is used", () => {
    expect(/\bpartId\b/.test(readFileSync(join(REPO, "packages/services/src/attachments-service.ts"), "utf8"))).toBe(true);
  });

  it("the attachment list a client reads carries no section", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await db.insert(attachmentsTbl).values({
      accountId, messageId, filename: "a.pdf", contentType: "application/pdf", sizeBytes: 3, inline: false, partId: "2.1",
    });
    const [dto] = await new AttachmentsService().listForMessage(ctx, messageId);
    expect(Object.keys(dto!).sort()).toEqual(["contentId", "contentType", "filename", "id", "inline", "messageId", "sizeBytes"]);
  });
});
