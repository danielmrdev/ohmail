import { describe, expect, it } from "vitest";
import { MessageService } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * THE SIX VIEWS START PAGE ONE WHERE THE CLIENT'S MIRROR ENDS — `before` on `GET /messages`, as the
 * folder and History arms always did. The Ohbox asked for older mail with nothing but a cursor, so
 * page one was the newest mail the device already listed, and a windowed Ohbox showed it again
 * under "Older".
 */
const svc = new MessageService();

async function world() {
  const { db, accountId, mailboxId, ctx } = await makeCtx();
  const ids: string[] = [];
  for (let day = 5; day >= 1; day -= 1) {
    ids.push(await seedMessage(db, accountId, mailboxId, {
      folder: "INBOX", desired: "INBOX", from: `s${day}@example.com`,
      date: new Date(`2026-07-0${day}${"T"}09:00:00Z`),
    }));
  }
  return { ctx, ids }; // newest first: 07-05 … 07-01
}

describe("a view page starts strictly below the caller's edge", () => {
  it("page one begins under the named position, newest first", async () => {
    const { ctx, ids } = await world();
    // MUTATION: drop the `before` arm in the view branch and page one starts at 07-05 again.
    const page = await svc.list(ctx, { view: "imbox", before: { date: "2026-07-03T09:00:00.000Z", id: ids[2]! } });
    expect(page.items.map((m) => m.id)).toEqual([ids[3], ids[4]]);
  });

  it("without an edge the page is the view's newest, as before", async () => {
    const { ctx, ids } = await world();
    const page = await svc.list(ctx, { view: "imbox" });
    expect(page.items.map((m) => m.id)).toEqual(ids);
  });

  it("a cursor supersedes the edge", async () => {
    const { ctx, ids } = await world();
    const first = await svc.list(ctx, { view: "imbox", limit: 2 });
    const second = await svc.list(ctx, {
      view: "imbox", limit: 2, cursor: first.nextCursor!, before: { date: null, id: ids[4]! },
    });
    expect(second.items.map((m) => m.id)).toEqual([ids[2], ids[3]]);
  });

  it("a malformed edge is refused, never answered with the wrong page", async () => {
    const { ctx, ids } = await world();
    await expect(svc.list(ctx, { view: "imbox", before: { date: null, id: "nope" } })).rejects.toThrow(/beforeId/);
    await expect(svc.list(ctx, { view: "imbox", before: { date: "2026-02-30", id: ids[0]! } })).rejects.toThrow(/beforeDate/);
  });
});
