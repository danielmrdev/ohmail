import { describe, it, expect } from "vitest";
import { attachments as attachmentsTbl } from "@trafficflow/db";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, seedMessage, req, FIXED_NOW, type SeededSession } from "./helpers.js";
import type { Db } from "@trafficflow/services";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

async function seedAttachment(
  db: Db, accountId: string, messageId: string,
  o: { filename?: string; contentType?: string; sizeBytes?: number; inline?: boolean } = {},
): Promise<string> {
  const [row] = await db.insert(attachmentsTbl).values({
    accountId, messageId,
    filename: o.filename ?? "file.txt",
    contentType: o.contentType ?? "text/plain",
    sizeBytes: o.sizeBytes ?? 10,
    inline: o.inline ?? false,
    partId: "2",
  }).returning();
  return row!.id;
}

describe("attachments routes (JSON metadata surface)", () => {
  it("GET /messages/:id/attachments → { items }", async () => {
    const { db, deps } = await makeDeps();
    const s: SeededSession = await seedSession(db, { now: FIXED_NOW });
    const { id: messageId } = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
    await seedAttachment(db, s.accountId, messageId, { filename: "a.pdf", contentType: "application/pdf", sizeBytes: 42 });

    const res = await H(req("GET", `/messages/${messageId}/attachments`, { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ filename: "a.pdf", contentType: "application/pdf", sizeBytes: 42, messageId });
  });

  it("GET /attachments/:id/meta → dto; cross-account → 404; unauth → 401", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "owner-tok" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const { id: messageId } = await seedMessage(db, { accountId: owner.accountId, folder: "INBOX" });
    const attId = await seedAttachment(db, owner.accountId, messageId, { filename: "secret.txt" });

    const ok = await H(req("GET", `/attachments/${attId}/meta`, { bearer: owner.token }), deps);
    expect(ok.status).toBe(200);
    expect((await ok.json()).filename).toBe("secret.txt");

    const cross = await H(req("GET", `/attachments/${attId}/meta`, { bearer: other.token }), deps);
    expect(cross.status).toBe(404);

    const unauth = await H(req("GET", `/attachments/${attId}/meta`), deps);
    expect(unauth.status).toBe(401);
  });

  it("GET /files → All Files (non-inline) with the message header; Big Files floors by size", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const { id: messageId } = await seedMessage(db, {
      accountId: s.accountId, folder: "INBOX", subject: "Invoice", fromAddress: "billing@x.example",
    });
    await seedAttachment(db, s.accountId, messageId, { filename: "small.txt", sizeBytes: 10 });
    await seedAttachment(db, s.accountId, messageId, { filename: "big.zip", sizeBytes: 5_000_000 });
    await seedAttachment(db, s.accountId, messageId, { filename: "inline.png", sizeBytes: 9_000_000, inline: true });

    const all = await H(req("GET", "/files?type=all", { bearer: s.token }), deps);
    const allBody = await all.json();
    expect(allBody.items.map((i: { filename: string }) => i.filename).sort()).toEqual(["big.zip", "small.txt"]);
    expect(allBody.items[0].message.subject).toBe("Invoice");

    const big = await H(req("GET", "/files?type=big", { bearer: s.token }), deps);
    const bigBody = await big.json();
    expect(bigBody.items.map((i: { filename: string }) => i.filename)).toEqual(["big.zip"]);
  });
});
