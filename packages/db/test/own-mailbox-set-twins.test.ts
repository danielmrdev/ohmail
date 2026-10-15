import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import { mailboxes } from "@trafficflow/db/mail";
import { dialect } from "../src/dialect/index.js";
import { readOwnAddresses } from "../src/own-mail.js";
import { mailboxCountsAsOwn, senderIsOwnSql } from "../src/screener-cutline.js";
import type { Tx } from "../src/change-log.js";

/**
 * THE OWN-ADDRESS SET IS ONE DEFINITION IN THREE READERS (REVIEW-026 HIGH-1): the router's
 * `readOwnAddresses`, the Screener's `senderIsOwnSql` and the DTO's `mailboxCountsAsOwn` answer
 * alike for every state a mailbox row can be in: live, in error, removed (the tombstone),
 * stood down (disabled with a reason), and with its erasure finished, on both stores.
 */
const AT = new Date("2026-10-06T00:00:00Z");
const STATES = [
  { name: "connected", status: "connected", disabledReason: null, erasureDoneAt: null, own: true },
  { name: "error", status: "error", disabledReason: null, erasureDoneAt: null, own: true },
  { name: "removed", status: "disabled", disabledReason: null, erasureDoneAt: null, own: false },
  { name: "stood-down", status: "disabled", disabledReason: "organized_elsewhere:local", erasureDoneAt: null, own: true },
  { name: "erased", status: "disabled", disabledReason: null, erasureDoneAt: AT, own: false },
  { name: "erased-connected", status: "connected", disabledReason: null, erasureDoneAt: AT, own: false },
] as const;

describe("the account's own mailboxes, read three ways", () => {
  it("every state answers the same in SQL, in the Screener's predicate and over the row", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    for (const st of STATES) {
      await db.insert(mailboxes).values({
        accountId, provider: "imap", address: `${st.name}@own.invalid`, status: st.status,
        disabledReason: st.disabledReason, erasureDoneAt: st.erasureDoneAt,
        ...(st.erasureDoneAt ? { erasedAt: st.erasureDoneAt } : {}),
      });
    }
    const set = await readOwnAddresses(db as unknown as Tx, accountId);
    const d = dialect(db);
    for (const st of STATES) {
      const address = `${st.name}@own.invalid`;
      const [row] = await db.select({ own: sql<unknown>`${senderIsOwnSql(d, accountId, sql`${address}`)}` }).from(mailboxes).limit(1);
      // A boolean on the server, 1 or 0 on the device store.
      const screener = row!.own === true || row!.own === 1;
      const byRow = mailboxCountsAsOwn({ status: st.status, disabledReason: st.disabledReason, erasureDoneAt: st.erasureDoneAt });
      expect({ state: st.name, router: set.has(address), screener, row: byRow })
        .toEqual({ state: st.name, router: st.own, screener: st.own, row: st.own });
    }
  });
});
