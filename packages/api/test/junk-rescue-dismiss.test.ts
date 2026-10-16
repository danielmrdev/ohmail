import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { accountSettings, junkRescues, mailboxes } from "@trafficflow/db";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import { FIXED_NOW, makeDeps, req, seedMailbox, seedSession } from "./helpers.js";

/**
 * A "NOT JUNK" THE MAIL SERVER REFUSED CAN BE CLEARED — `DELETE /screener/junk/rescue/:id`.
 *
 * After the organizer's backoff runs out the command is kept as `refused`, so the Junk window
 * can say so, and the only way past it was to press again and have the move land. The route
 * clears a refused command for the organizing install and nothing else: a pending one is the
 * organizer's, another account's is not found, a reader refuses as the rescue does.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

async function world(opts: { status?: "pending" | "refused"; reader?: boolean; foldersOff?: boolean; unverified?: boolean } = {}) {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW, ...(opts.unverified ? { emailVerified: false } : {}) });
  if (!opts.foldersOff) await db.insert(accountSettings).values({ accountId: s.accountId, foldersEnabledAt: FIXED_NOW });
  const mb = await seedMailbox(db, { accountId: s.accountId });
  if (opts.reader) await db.update(mailboxes).set({ organizerRole: "reader" }).where(eq(mailboxes.id, mb));
  const [row] = await db.insert(junkRescues).values({
    accountId: s.accountId, mailboxId: mb, folder: "INBOX/Spam", uidvalidity: 7n, uid: 42,
    status: opts.status ?? "refused", attempts: 5, requestedAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).returning();
  const rowsLeft = async () => (await db.select({ id: junkRescues.id }).from(junkRescues)
    .where(and(eq(junkRescues.accountId, s.accountId), eq(junkRescues.id, row!.id)))).length;
  return { db, deps, s, id: row!.id, rowsLeft };
}

const dismiss = (w: Awaited<ReturnType<typeof world>>, id = w.id, bearer: string | null = w.s.token) =>
  H(req("DELETE", `/screener/junk/rescue/${id}`, bearer !== null ? { bearer } : {}), w.deps);

describe("DELETE /screener/junk/rescue/:id", () => {
  it("clears the account's own refused command", async () => {
    const w = await world();
    const res = await dismiss(w);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dismissed: true });
    expect(await w.rowsLeft()).toBe(0);
  });

  it("refuses a command the organizer is still carrying out, and keeps it", async () => {
    const w = await world({ status: "pending" });
    const res = await dismiss(w);
    expect(res.status).toBe(409);
    expect(await w.rowsLeft()).toBe(1);
  });

  it("answers another account's command as not found, and keeps it", async () => {
    const owner = await world();
    const other = await seedSession(owner.db, { now: FIXED_NOW });
    await owner.db.insert(accountSettings).values({ accountId: other.accountId, foldersEnabledAt: FIXED_NOW });
    const res = await H(req("DELETE", `/screener/junk/rescue/${owner.id}`, { bearer: other.token }), owner.deps);
    expect(res.status).toBe(404);
    expect(await owner.rowsLeft()).toBe(1);
  });

  it("refuses a reader, as the rescue does", async () => {
    const w = await world({ reader: true });
    const res = await dismiss(w);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe("organized_elsewhere");
    expect(await w.rowsLeft()).toBe(1);
  });

  it("refuses an id that is not an id, before anything reads it", async () => {
    const w = await world();
    const res = await dismiss(w, "not-a-uuid");
    expect(res.status).toBe(400);
    expect(await w.rowsLeft()).toBe(1);
  });

  it("refuses a request with no session", async () => {
    const w = await world();
    const res = await dismiss(w, w.id, null);
    expect(res.status).toBe(401);
    expect(await w.rowsLeft()).toBe(1);
  });

  it("refuses an account that has not verified its address, as every `work` route does", async () => {
    const w = await world({ unverified: true });
    const res = await dismiss(w);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe("email_unverified");
    expect(await w.rowsLeft()).toBe(1);
  });

  it("answers 409 while “Use folders” is off, like every junk route", async () => {
    const w = await world({ foldersOff: true });
    const res = await dismiss(w);
    expect(res.status).toBe(409);
    expect(await w.rowsLeft()).toBe(1);
  });
});
