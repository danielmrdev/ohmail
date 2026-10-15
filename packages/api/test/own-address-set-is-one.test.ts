import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { mailboxes, readOwnAddresses, type Tx } from "@trafficflow/db";
import { makeDeps, seedSession, seedMailbox, req, FIXED_NOW } from "./helpers.js";

/**
 * ONE OWN-ADDRESS SET (REVIEW-026 HIGH-1): the account's mailboxes neither erased nor removed. The
 * rule refusal, the router's own test (`readOwnAddresses`) and the surfaces (`addressIsOwn` on
 * `GET /mailboxes`) read the same answer. A finished erasure and a removed mailbox are no longer
 * the account's own, so a rule about either address is admitted; a stood-down mailbox still is.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

async function account() {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
  const at = async (address: string, set: Partial<typeof mailboxes.$inferInsert>) => {
    const id = await seedMailbox(db, { accountId: s.accountId, address });
    if (Object.keys(set).length > 0) await db.update(mailboxes).set(set).where(eq(mailboxes.id, id));
  };
  await at("live@own.invalid", {});
  await at("erased@own.invalid", { status: "disabled", erasedAt: FIXED_NOW, erasureDoneAt: FIXED_NOW });
  await at("removed@own.invalid", { status: "disabled" });
  await at("stood@own.invalid", { status: "disabled", disabledReason: "organized_elsewhere:cloud" });
  const rule = (match: string) => H(req("POST", "/rules", {
    bearer: s.token, body: JSON.stringify({ kind: "sender", match, destination: "ohmail/Screened" }),
  }), deps);
  return { db, deps, s, rule };
}

describe("the account's own addresses: its mailboxes neither erased nor removed", () => {
  it("a rule about a finished erasure's or a removed mailbox's address is admitted", async () => {
    const a = await account();
    expect((await a.rule("erased@own.invalid")).status).toBe(201);
    expect((await a.rule("removed@own.invalid")).status).toBe(201);
  });

  it("a live or stood-down mailbox is still the account's: a rule about it is refused own_address", async () => {
    const a = await account();
    for (const address of ["live@own.invalid", "stood@own.invalid"]) {
      const res = await a.rule(address);
      expect({ address, status: res.status, code: (await res.json())?.error?.code })
        .toEqual({ address, status: 400, code: "own_address" });
    }
  });

  it("the router's set and GET /mailboxes' addressIsOwn are that same set", async () => {
    const a = await account();
    const own = [...await readOwnAddresses(a.db as unknown as Tx, a.s.accountId)].sort();
    expect(own).toEqual(["live@own.invalid", "stood@own.invalid"]);
    const listed = (await (await H(req("GET", "/mailboxes", { bearer: a.s.token }), a.deps)).json()).items as
      Array<{ address: string; addressIsOwn?: boolean }>;
    expect(listed.map((m) => [m.address, m.addressIsOwn]).sort()).toEqual([
      ["live@own.invalid", true], ["removed@own.invalid", false], ["stood@own.invalid", true],
    ]);
  });

  it("CONTROL: a stranger's rule is admitted", async () => {
    const a = await account();
    expect((await a.rule("stranger@elsewhere.invalid")).status).toBe(201);
  });
});
