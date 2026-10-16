import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import {
  decodeKeysetCursor, decodeNullableKeysetCursor, encodeNullableKeysetCursor,
} from "@trafficflow/services";
import { makeDeps, seedSession, seedMailbox, seedMessage, req, FIXED_NOW } from "./helpers.js";

/**
 * THE UNDATED TAIL OF A MESSAGE LIST WAS UNREACHABLE.
 *
 * `messages.date` is the sender's own `Date:` header and it is nullable: `mime.ts:503` stores
 * `parsed.date ?? null`, so a message with no parseable header — which any stranger can send —
 * lands with a NULL date. The (date, id) keyset encoded that position as epoch `0`, and the two
 * halves of the list then disagreed about what `0` meant:
 *
 *  · The next page asked for rows strictly OLDER than 1970-01-01, which no undated row satisfies
 *    (`date < $1` is NULL, not TRUE, for a NULL date). The remaining undated mail was skipped and
 *    the walk ended with no cursor and nothing said — the tail was simply gone.
 *  · Drizzle's `desc()` emits bare `ORDER BY … DESC`, which in PostgreSQL means `DESC NULLS
 *    FIRST`, so undated mail sorted at the TOP of every view. Meanwhile the `before` branch's
 *    predicate — copied from `sync-service.ts:807-811` — was written for NULLS LAST. One class,
 *    two orders.
 *
 * The fix was the ordering the other surfaces used plus a cursor that carried the null as a
 * POSITION (`null:<uuid>`). Since mail 0139 the order is the ARRIVAL key (`Dialect.arrivalKey`),
 * which is non-null: an undated row with no arrival sits AT the epoch, so a new cursor names that
 * position as `0:<uuid>` and the keyset `(key, id) < (epoch, id)` reaches the rest of the tail. An
 * old `null:<uuid>` cursor still resumes at the same position (ARCH-MIRROR-COUNTS change 4).
 *
 * ── THE MUTATION-WATCH ─────────────────────────────────────────────────────────────────────
 *
 * Both were watched fail and restored:
 *  · In `message-service.ts`, put `MSG_ORDER` back to `[desc(messages.date), desc(messages.id)]`
 *    and "pages to the END of a list that holds undated mail" goes red: the walk returns 2 of the
 *    6 seeded messages, because page one is undated rows and page two asks for pre-1970 mail.
 *  · Since mail 0139 the same walk is pinned through the arrival key: in `message-service.ts`'s
 *    `decodeMsgCursor`, map `null` anywhere but the epoch and the old-cursor case below goes red.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

interface ListPage { items: { id: string; date: string | null }[]; nextCursor: string | null }

describe("the keyset cursor carries a NULL date as a position, not as epoch 0", () => {
  it("pages to the END of a list that holds undated mail", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });

    // Three dated and three UNDATED, interleaved at insert so the answer's order is the
    // database's and not the insertion sequence.
    const dated: string[] = [];
    const undated: string[] = [];
    for (let i = 0; i < 3; i++) {
      dated.push((await seedMessage(db, {
        accountId: s.accountId, mailboxId: mb, folder: "INBOX",
        date: new Date(FIXED_NOW.getTime() - i * 60_000),
      })).id);
      undated.push((await seedMessage(db, {
        accountId: s.accountId, mailboxId: mb, folder: "INBOX",   // no `date` ⇒ NULL
      })).id);
    }

    // Walk the whole list two at a time, exactly as a client does.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const q = `/messages?view=imbox&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await H(req("GET", q, { bearer: s.token }), deps);
      expect(res.status).toBe(200);
      const body = await res.json() as ListPage;
      seen.push(...body.items.map((i) => i.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    // THE LOAD-BEARING ASSERTION: every seeded message is reachable by paging. Before the fix the
    // walk stopped after the undated rows at the top and returned 2 of 6.
    expect(seen.length, "the walk must reach every message in the list").toBe(6);
    expect(new Set(seen).size, "no message may be returned twice by the walk").toBe(6);
    expect([...seen].sort()).toEqual([...dated, ...undated].sort());

    // …and undated mail sorts LAST, which is what the snapshot bootstrap, the Screener and the
    // client mirror all already do. A message that simply omits its `Date:` header must not pin
    // itself to the top of the reader's inbox.
    expect(seen.slice(0, 3), "dated mail comes first, newest first").toEqual(dated);
    expect(new Set(seen.slice(3)), "the undated tail sorts after every dated row").toEqual(new Set(undated));
  });

  it("hands out a cursor that names the undated position, and an old null cursor resumes there too", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX", date: FIXED_NOW });
    const u1 = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX" });
    const u2 = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX" });

    // Page 1 ends on an undated row: its position is the arrival key's epoch, `0:<uuid>`.
    const p1 = await (await H(req("GET", "/messages?view=imbox&limit=2", { bearer: s.token }), deps)).json() as ListPage;
    expect(p1.nextCursor).toBeTruthy();
    const decoded = Buffer.from(p1.nextCursor!, "base64url").toString("utf8");
    expect(decoded, "an undated position is the key's epoch").toMatch(/^0:[0-9a-f-]{36}$/i);

    const p2 = await (await H(req("GET", `/messages?view=imbox&limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`, { bearer: s.token }), deps)).json() as ListPage;
    expect(p2.items).toHaveLength(1);
    expect([...p1.items, ...p2.items].map((i) => i.id).sort()).toEqual([u1.id, u2.id, p1.items[0]!.id].sort());

    // A cursor minted before the arrival key named the same stop as `null:<uuid>`: it resumes at
    // the same position and serves the same page.
    const id = decoded.slice(2);
    const old = Buffer.from(`null:${id}`, "utf8").toString("base64url");
    const p2old = await (await H(req("GET", `/messages?view=imbox&limit=2&cursor=${encodeURIComponent(old)}`, { bearer: s.token }), deps)).json() as ListPage;
    expect(p2old.items.map((i) => i.id)).toEqual(p2.items.map((i) => i.id));
  });
});

describe("the null sentinel belongs to the NULLABLE family alone", () => {
  const uuid = "0191b1f0-1111-4222-8333-444455556666";

  it("round-trips both positions", () => {
    expect(decodeNullableKeysetCursor(encodeNullableKeysetCursor(null, uuid)))
      .toEqual({ millis: null, id: uuid });
    expect(decodeNullableKeysetCursor(encodeNullableKeysetCursor(1_700_000_000_000, uuid)))
      .toEqual({ millis: 1_700_000_000_000, id: uuid });
  });

  it("is REFUSED by the non-nullable decoder — `detected_at` and `created_at` have no null position", () => {
    // `PrivacyService.listTrackerEvents` and `WorkflowsService.listRuns` page on `notNull`
    // columns. Accepting `null:<uuid>` there would build an `is null` predicate that silently
    // matches nothing, which is a page that ends early for a reason nobody can see — the exact
    // failure this row is about, moved to a different route.
    expect(() => decodeKeysetCursor(encodeNullableKeysetCursor(null, uuid))).toThrow();
    // …and the numeric shape those routes DO issue still decodes, so this is a narrowing and not
    // a break.
    expect(decodeKeysetCursor(encodeNullableKeysetCursor(1_700_000_000_000, uuid)))
      .toEqual({ millis: 1_700_000_000_000, id: uuid });
  });

  it("still refuses the bare-id shape and an over-long cursor", () => {
    expect(() => decodeNullableKeysetCursor(Buffer.from(uuid, "utf8").toString("base64url"))).toThrow();
    expect(() => decodeNullableKeysetCursor(Buffer.from(`null:${"x".repeat(200)}`, "utf8").toString("base64url"))).toThrow();
    // A stale cursor minted before the sentinel existed still decodes — it resumes at the 1970
    // boundary as it always did, and the client is back on a correct cursor after one page.
    expect(decodeNullableKeysetCursor(Buffer.from(`0:${uuid}`, "utf8").toString("base64url")))
      .toEqual({ millis: 0, id: uuid });
  });
});
