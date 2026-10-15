import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, seedMailbox, seedMessage, req, FIXED_NOW } from "./helpers.js";

/**
 * `GET /mailboxes?counts=1`, and the default that must stay free.
 *
 * The route half of the opt-in. The service already refuses to compute the aggregate unless it
 * is asked (`packages/services/test/mailbox-message-counts.pg.test.ts` takes the statement
 * census against real Postgres); what is decided HERE is that the query string is the only
 * thing that asks, and that it takes exactly one spelling.
 *
 * ── WHY IT IS A QUERY PARAMETER AND NOT A SECOND ROUTE ─────────────────────────────────
 *
 * `/mailboxes/counts` would be a second projection of the same resource, with its own
 * `cost` class, its own account scoping and its own 404 semantics to keep in step — and every
 * caller that wanted mailboxes AND counts would make two requests to build one screen. The
 * resource is the same list; `?counts=1` asks for one more field of it.
 *
 * `cost` stays `read` for the same reason it always was: this reads rows already stored for the
 * caller's own account and writes nothing. The aggregate is more work than the bare list, but
 * "more work" is not what the cost classes sort on — `connection` and `work` exist to fence off
 * dialling somebody's mail server and making the worker do things.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

describe("GET /mailboxes?counts=1", () => {
  it("carries a per-mailbox count, and the bare route carries none", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const busy = await seedMailbox(db, { accountId: s.accountId, address: "busy@lichtgrat.example" });
    const empty = await seedMailbox(db, { accountId: s.accountId, address: "empty@lichtgrat.example" });
    for (let i = 0; i < 3; i++) {
      await seedMessage(db, { accountId: s.accountId, mailboxId: busy, subject: `s${i}` });
    }

    const bare = await H(req("GET", "/mailboxes", { bearer: s.token }), deps);
    expect(bare.status).toBe(200);
    for (const mb of (await bare.json()).items) {
      /* ABSENT, not `0`. The two pollers that read this route every 10 and 30 seconds get this
         response, and "0 messages" rendered from a status poll would tell somebody their mail
         had disappeared. The client's rule is a `typeof === "number"` guard; this is the half
         that makes the guard mean something. */
      expect(mb.messageCount, `${mb.address} carried a count nobody asked for`).toBeUndefined();
    }

    const counted = await H(req("GET", "/mailboxes?counts=1", { bearer: s.token }), deps);
    expect(counted.status).toBe(200);
    const items: Array<{ id: string; messageCount?: number }> = (await counted.json()).items;
    expect(items.find((m) => m.id === busy)?.messageCount).toBe(3);
    expect(items.find((m) => m.id === empty)?.messageCount).toBe(0);
  });

  it("another account's mail is never in the number — the count is account-scoped, like the list", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "owner-tok" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const mine = await seedMailbox(db, { accountId: owner.accountId, address: "mine@lichtgrat.example" });
    const theirs = await seedMailbox(db, { accountId: other.accountId, address: "theirs@lichtgrat.example" });

    await seedMessage(db, { accountId: owner.accountId, mailboxId: mine });
    for (let i = 0; i < 5; i++) {
      await seedMessage(db, { accountId: other.accountId, mailboxId: theirs, subject: `t${i}` });
    }

    const res = await H(req("GET", "/mailboxes?counts=1", { bearer: owner.token }), deps);
    const items: Array<{ id: string; messageCount?: number }> = (await res.json()).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(mine);
    expect(items[0]!.messageCount).toBe(1);
  });

  it("only `counts=1` asks — anything else is the bare list, and nothing 400s over it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await seedMailbox(db, { accountId: s.accountId });
    await seedMessage(db, { accountId: s.accountId, mailboxId: id });

    /**
     * ONE SPELLING, and the others degrade to the DEFAULT rather than to an error.
     *
     * A truthiness read (`params.has("counts")`, or `!== null`) would make `?counts=0` and
     * `?counts=false` both turn the aggregate ON — the two spellings a caller reaches for to
     * turn it OFF. Since the field's absence is a legitimate answer and the default is the
     * cheap path, an unrecognised value resolves to the cheap path: the worst outcome is a
     * screen with no number on it, and the alternative is a polled route quietly paying for an
     * aggregate because somebody wrote `counts=0`.
     *
     * And a bad value is not a 400. Nothing about this parameter is a request the server cannot
     * answer — it is one optional field of a list that is returned either way, and a 400 here
     * would break the whole pane over a decoration.
     */
    for (const q of ["", "?counts=0", "?counts=false", "?counts=yes", "?counts", "?count=1"]) {
      const res = await H(req("GET", `/mailboxes${q}`, { bearer: s.token }), deps);
      expect(res.status, `GET /mailboxes${q}`).toBe(200);
      const [mb] = (await res.json()).items;
      expect(mb.messageCount, `GET /mailboxes${q} computed a count`).toBeUndefined();
    }

    const on = await H(req("GET", "/mailboxes?counts=1", { bearer: s.token }), deps);
    expect((await on.json()).items[0].messageCount).toBe(1);
  });

  it("the single-mailbox read never carries one — `GET /mailboxes/:id` is not a counting surface", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await seedMailbox(db, { accountId: s.accountId });
    await seedMessage(db, { accountId: s.accountId, mailboxId: id });

    /* `?counts=1` is a property of the LIST, which is where the one grouped statement pays for
       itself across every row. A single-mailbox read has no such surface, so the parameter is
       not plumbed into it and is ignored rather than half-honoured. */
    const res = await H(req("GET", `/mailboxes/${id}?counts=1`, { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).messageCount).toBeUndefined();
  });
});
