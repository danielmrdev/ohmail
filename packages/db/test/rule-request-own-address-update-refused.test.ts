import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { applyRuleRequest, type ValidatedRuleRequest } from "../src/request-apply.js";
import { accounts, mailboxes, rules } from "../src/schema-mail.js";
import type { LedgerTx, Tx } from "../src/change-log.js";

/**
 * A TRAVELLED EDIT OF A RULE ABOUT OUR OWN ADDRESS IS REFUSED WHERE THE MAILBOX IS ORGANIZED, as
 * the edit door refuses it: a reader's Move on the person's own letter asks the
 * organizer to retarget the own-address rule. A pause and a removal are still applied, and anybody
 * else's rule is retargeted as before.
 */

const NOW = new Date("2026-10-09T12:00:00.000Z");
const OWN = "me@lichtgrat.example";

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `rroa-${accountId.slice(0, 8)}` });
  await db.insert(mailboxes).values({ accountId, provider: "imap", address: OWN });
  for (const match of [OWN, "friend@example.com"]) {
    await db.insert(rules).values({ accountId, kind: "sender", match, destination: "INBOX", priority: 0, enabled: true, provenance: "manual" });
  }
  const key = (match: string) => ({ kind: "sender" as const, match, subjectContains: null, bodyContains: null });
  const apply = (payload: ValidatedRuleRequest) => (db as unknown as Tx).transaction((tx) =>
    applyRuleRequest(tx as unknown as LedgerTx, { accountId, payload, now: NOW }));
  const read = async (match: string) => (await db.select().from(rules)
    .where(and(eq(rules.accountId, accountId), eq(rules.match, match))))[0];
  return { key, apply, read };
}

describe("a travelled edit of a rule about our own address", () => {
  it("a retarget is refused own_address and the rule stays where it was", async () => {
    const { key, apply, read } = await world();
    for (const set of [{ destination: "ohmail/News" }, { priority: 3 }, { enabled: true }]) {
      const res = await apply({ op: "update", key: key(OWN), set, applyRetro: false, retroAsked: false });
      expect({ set, res }).toEqual({ set, res: { applied: false, refusal: "own_address" } });
    }
    const r = await read(OWN);
    expect({ destination: r?.destination, priority: r?.priority }).toEqual({ destination: "INBOX", priority: 0 });
  });

  it("a pause and a removal are applied (the positive control)", async () => {
    const { key, apply, read } = await world();
    expect((await apply({ op: "update", key: key(OWN), set: { enabled: false }, applyRetro: false, retroAsked: false })).applied).toBe(true);
    expect((await read(OWN))?.enabled).toBe(false);
    expect((await apply({ op: "delete", key: key(OWN) })).applied).toBe(true);
    expect(await read(OWN)).toBeUndefined();
  });

  it("anybody else's rule is retargeted (the positive control)", async () => {
    const { key, apply, read } = await world();
    const res = await apply({ op: "update", key: key("friend@example.com"), set: { destination: "ohmail/News" }, applyRetro: false, retroAsked: false });
    expect(res.applied).toBe(true);
    expect((await read("friend@example.com"))?.destination).toBe("ohmail/News");
  });
});
