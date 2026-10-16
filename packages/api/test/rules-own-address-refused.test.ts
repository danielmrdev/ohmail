import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, seedMailbox, seedScreenerHeld, req, FIXED_NOW } from "./helpers.js";

/**
 * A RULE KEYED ON THE ACCOUNT'S OWN ADDRESS IS REFUSED AT THE DOOR (SENDER-SHEET-OFFERED-ON-OUR-
 * OWN-MAIL). Every address the account sends as is one of its mailboxes; a sender rule naming one
 * would decide about the account itself, and the router lets it win over the own-mail branch, so
 * the person's own mail would be filed or held by it. A create, an edit moving the key there and a
 * Screener decision answer `own_address` and write nothing; anybody else's rule and a domain rule stay.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

const OWN = "me@lichtgrat.example";
const OTHER_OWN = "second@lichtgrat.example";

async function account() {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW });
  const mailboxId = await seedMailbox(db, { accountId: s.accountId, address: OWN });
  await seedMailbox(db, { accountId: s.accountId, address: OTHER_OWN });
  return { db, deps, s, mailboxId };
}

const create = (deps: ApiDeps, token: string, body: Record<string, unknown>) =>
  H(req("POST", "/rules", { bearer: token, body: JSON.stringify(body) }), deps);

async function ruleMatches(deps: ApiDeps, token: string): Promise<string[]> {
  const res = await H(req("GET", "/rules", { bearer: token }), deps);
  return ((await res.json()).items as Array<{ match: string }>).map((r) => r.match);
}

describe("a rule keyed on the account's own address", () => {
  it("POST /rules naming one of the account's own addresses answers 400 own_address and writes nothing", async () => {
    const { deps, s } = await account();
    const res = await create(deps, s.token, { kind: "sender", match: OWN, destination: "ohmail/Screened" });
    const body = await res.json();
    expect({ status: res.status, code: body?.error?.code }).toEqual({ status: 400, code: "own_address" });
    expect(await ruleMatches(deps, s.token)).toEqual([]);
  });

  it("is refused in any spelling the key folds to, on any of the account's mailboxes, narrowed or not", async () => {
    const { deps, s } = await account();
    for (const body of [
      { kind: "sender", match: "  Me@Lichtgrat.example ", destination: "ohmail/News" },
      { kind: "sender", match: OTHER_OWN, destination: "INBOX" },
      { kind: "sender", match: OWN, destination: "ohmail/Receipts", subjectContains: "invoice" },
    ]) {
      const res = await create(deps, s.token, body);
      expect({ match: body.match, status: res.status, code: (await res.json())?.error?.code })
        .toEqual({ match: body.match, status: 400, code: "own_address" });
    }
    expect(await ruleMatches(deps, s.token)).toEqual([]);
  });

  it("a rule for anybody else, and a domain rule, are admitted (the positive control)", async () => {
    const { deps, s } = await account();
    expect((await create(deps, s.token, { kind: "sender", match: "friend@example.com", destination: "INBOX" })).status).toBe(201);
    expect((await create(deps, s.token, { kind: "domain", match: "lichtgrat.example", destination: "ohmail/News" })).status).toBe(201);
    expect((await ruleMatches(deps, s.token)).sort()).toEqual(["friend@example.com", "lichtgrat.example"]);
  });

  it("PATCH /rules/:id moving a rule onto one of our own addresses answers 400 own_address and changes nothing", async () => {
    const { deps, s } = await account();
    const made = await (await create(deps, s.token, { kind: "domain", match: "example.com", destination: "ohmail/News" })).json();
    const patch = (body: Record<string, unknown>) =>
      H(req("PATCH", `/rules/${made.id}`, { bearer: s.token, body: JSON.stringify(body) }), deps);
    const res = await patch({ kind: "sender", match: OWN });
    expect({ status: res.status, code: (await res.json())?.error?.code }).toEqual({ status: 400, code: "own_address" });
    expect(await ruleMatches(deps, s.token)).toEqual(["example.com"]);
    // The control: the same edit onto somebody else's address moves the rule.
    expect((await patch({ kind: "sender", match: "friend@example.com" })).status).toBe(200);
    expect(await ruleMatches(deps, s.token)).toEqual(["friend@example.com"]);
  });

  it("POST /screener/:id on the account's own mail answers 400 own_address and promotes no rule", async () => {
    const { db, deps, s, mailboxId } = await account();
    const held = await seedScreenerHeld(db, { accountId: s.accountId, mailboxId, fromAddress: OWN });
    const res = await H(req("POST", `/screener/${held.id}`, {
      bearer: s.token, body: JSON.stringify({ decision: "no", scope: "sender" }),
    }), deps);
    const body = await res.json();
    expect({ status: res.status, code: body?.error?.code }).toEqual({ status: 400, code: "own_address" });
    expect(await ruleMatches(deps, s.token)).toEqual([]);
  });

  it("a Screener decision about anybody else still writes its rule (the positive control)", async () => {
    const { db, deps, s, mailboxId } = await account();
    const held = await seedScreenerHeld(db, { accountId: s.accountId, mailboxId, fromAddress: "stranger@example.com" });
    const res = await H(req("POST", `/screener/${held.id}`, {
      bearer: s.token, body: JSON.stringify({ decision: "no", scope: "sender" }),
    }), deps);
    expect(res.status).toBe(200);
    expect(await ruleMatches(deps, s.token)).toEqual(["stranger@example.com"]);
  });
});
