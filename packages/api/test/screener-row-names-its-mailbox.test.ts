import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { messages } from "@trafficflow/db";
import { createApp, apiRoutes } from "@trafficflow/api";
import { makeDeps, seedSession, seedMailbox, seedMessage, req, FIXED_NOW } from "./helpers.js";

/**
 * `GET /screener` CARRIES THE TWO FACTS THE ROW IS ABOUT.
 *
 * on an account with more than one mailbox a Screener row did
 * not say which of the reader's addresses a stranger wrote to — and the client could not have
 * labelled it if it wanted to, because the field was not on the wire at all. The Junk pane in the
 * same view has always been per-mailbox, which is what made it a defect rather than a choice.
 *
 * the substantive half: the sender's display name — the identity the stranger asserted, and
 * half of what a screening decision is taken on — was dropped at the server. `ScreenerRow` has
 * carried `fromName` the whole time for the sender check to read; `toItem` wrote `name: null`.
 *
 * THE FIXTURE'S TWO MAILBOXES HAVE DIFFERENT ADDRESSES, deliberately. With one address, or with
 * two that agree, every row names the right one whatever the code does — that fixture measures
 * alignment, not the property.
 */
const app = createApp(apiRoutes);

const WORK = "work@fixture.example";
const HOME = "home@fixture.example";

describe("GET /screener names the mailbox and the sender", () => {
  it("each row carries its OWN mailbox on a two-mailbox account", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const work = await seedMailbox(db, { accountId: s.accountId, address: WORK });
    const home = await seedMailbox(db, { accountId: s.accountId, address: HOME });
    expect(work).not.toBe(home);

    await seedMessage(db, {
      accountId: s.accountId, mailboxId: work, folder: "ohmail/Screener",
      fromAddress: "one@stranger.example", date: new Date("2026-08-02T09:00:00Z"),
    });
    await seedMessage(db, {
      accountId: s.accountId, mailboxId: home, folder: "ohmail/Screener",
      fromAddress: "two@stranger.example", date: new Date("2026-08-02T08:00:00Z"),
    });

    const res = await app.handle(req("GET", "/screener", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ sender: { address: string }; mailboxId: string }> };

    const byAddress = new Map(body.items.map((i) => [i.sender.address, i.mailboxId]));
    expect(byAddress.get("one@stranger.example")).toBe(work);
    expect(byAddress.get("two@stranger.example")).toBe(home);
    // The two rows DISAGREE — a page that handed every row one mailbox would pass the two
    // assertions above on a one-mailbox account and fail this one.
    expect(byAddress.get("one@stranger.example")).not.toBe(byAddress.get("two@stranger.example"));
    // And every row has one: absent was the whole defect, so `undefined` must not read as a pass.
    for (const item of body.items) expect(typeof item.mailboxId).toBe("string");
  });

  it("the sender's display name reaches the wire, and a nameless sender stays null", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId, address: WORK });

    const named = await seedMessage(db, {
      accountId: s.accountId, mailboxId: mb, folder: "ohmail/Screener",
      fromAddress: "named@stranger.example", date: new Date("2026-08-02T09:00:00Z"),
    });
    // `seedMessage` has no `fromName` argument; the column is what the sender check reads and
    // what this case is about, so it is written directly rather than by widening a shared helper.
    await db.update(messages).set({ fromName: "Lena Roth" }).where(eq(messages.id, named.id));
    await seedMessage(db, {
      accountId: s.accountId, mailboxId: mb, folder: "ohmail/Screener",
      fromAddress: "bare@stranger.example", date: new Date("2026-08-02T08:00:00Z"),
    });

    const res = await app.handle(req("GET", "/screener", { bearer: s.token }), deps);
    const body = await res.json() as { items: Array<{ sender: { name: string | null; address: string } }> };
    const byAddress = new Map(body.items.map((i) => [i.sender.address, i.sender.name]));

    expect(byAddress.get("named@stranger.example")).toBe("Lena Roth");
    // THE POSITIVE CONTROL FOR THE OTHER DIRECTION: mail that carried no display name answers
    // null rather than the address, so a surface can tell "no name" from "a name that is one".
    expect(byAddress.get("bare@stranger.example")).toBeNull();
  });
});
