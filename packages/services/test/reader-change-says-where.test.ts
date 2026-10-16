import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import {
  accountSettings, mailboxes, organizerRequests,
  applyProfileUpdate, validateProfileUpdatePayload,
} from "@trafficflow/db";
import { setDormancyDays } from "../src/index.js";
import { makeCtx } from "./helpers.js";

/**
 * A SETTINGS CHANGE MADE ON A READER SAYS WHERE IT WENT — the door half.
 *
 * The screening scope ("all time" or the window) is the dormancy dial's other answer. On a reader
 * it wrote the reader's own row and sent nothing, while the window beside it travelled: the
 * organizer's pass kept the window. It now travels through the same three homes as the window —
 * the reader's payload, the holder's validator and the holder's apply — and the reader's row is
 * left alone, as for every other travelling field.
 */

type World = Awaited<ReturnType<typeof makeCtx>>;

async function demoteOwn(w: World): Promise<void> {
  await w.db.update(mailboxes).set({
    organizerRole: "reader", organizerState: "held",
    organizedByCapabilities: "requests,profile",
    organizedByKind: "local", organizedByName: "work-laptop",
  }).where(eq(mailboxes.id, w.mailboxId));
}

async function requests(w: World) {
  return w.db.select().from(organizerRequests).where(eq(organizerRequests.accountId, w.accountId));
}

async function scopeOf(w: World): Promise<string | null> {
  const [row] = await w.db.select({ s: accountSettings.screeningScope })
    .from(accountSettings).where(eq(accountSettings.accountId, w.accountId));
  return row?.s ?? null;
}

describe("the screening scope on a reader", () => {
  it("a scope-only edit travels, and the reader's own row keeps the window", async () => {
    const w = await makeCtx();
    await setDormancyDays(w.ctx, 90);            // a row exists, so "unchanged" is a positive fact
    await demoteOwn(w);

    const result = await setDormancyDays(w.ctx, undefined, "all_time");
    expect(result.pending, "the scope did not travel").toBe(true);
    expect(result.screeningScope).toBe("window");

    const rows = await requests(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "profile.update", mailboxId: w.mailboxId, state: "pending" });
    expect(rows[0]!.payload).toEqual({ screeningScope: "all_time" });
    expect(await scopeOf(w), "the reader wrote its own row").toBe("window");
  });

  it("a window pick names both halves, and both travel", async () => {
    const w = await makeCtx();
    await setDormancyDays(w.ctx, undefined, "all_time");
    await demoteOwn(w);

    await setDormancyDays(w.ctx, 180, "window");
    const [row] = await requests(w);
    expect(row!.payload).toEqual({ dormancyDays: 180, screeningScope: "window" });
    expect(await scopeOf(w)).toBe("all_time");
  });

  it("the holder admits what the reader sent and writes the scope", async () => {
    const reader = await makeCtx();
    await demoteOwn(reader);
    await setDormancyDays(reader.ctx, undefined, "all_time");
    const [sent] = await requests(reader);

    const validated = validateProfileUpdatePayload(sent!.payload);
    expect(validated, "the holder refused the reader's own payload").toEqual({ screeningScope: "all_time" });
    // A holder with no settings row yet, and one that has one: the insert and the update arm.
    for (const seeded of [false, true]) {
      const holder = await makeCtx();
      if (seeded) await setDormancyDays(holder.ctx, 120);
      const applied = await holder.db.transaction((tx) => applyProfileUpdate(tx, {
        accountId: holder.accountId, mailboxId: holder.mailboxId, payload: validated!, now: holder.ctx.now(),
      }));
      expect(applied.wrote).toContain("screeningScope");
      expect(await scopeOf(holder), seeded ? "the update arm" : "the insert arm").toBe("all_time");
    }
  });

  it("the holder refuses a scope outside the closed pair", () => {
    expect(validateProfileUpdatePayload({ screeningScope: "forever" })).toBeNull();
    expect(validateProfileUpdatePayload({ screeningScope: null })).toBeNull();
    expect(validateProfileUpdatePayload({ screeningScope: "window" })).toEqual({ screeningScope: "window" });
  });

  it("an organizer still writes the scope here and sends nothing", async () => {
    const w = await makeCtx();
    const result = await setDormancyDays(w.ctx, undefined, "all_time");
    expect(result.pending).toBeUndefined();
    expect(result.screeningScope).toBe("all_time");
    expect(await requests(w)).toHaveLength(0);
    expect(await scopeOf(w)).toBe("all_time");
  });
});
