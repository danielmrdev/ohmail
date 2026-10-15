import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, seedMailbox, seedRule, req, FIXED_NOW } from "./helpers.js";

/**
 * AN EXISTING RULE ABOUT ONE OF THE ACCOUNT'S OWN ADDRESSES IS NEVER WRITTEN AGAIN.
 * Such rules exist from before the create door refused them. A Move on the person's own letter
 * PATCHed one to News: the edit door refused only a key MOVING onto an own address, so a retarget
 * of a rule already standing there rewrote it. The rule may be paused or removed; nothing else.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

const OWN = "me@lichtgrat.example";

async function account() {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW });
  await seedMailbox(db, { accountId: s.accountId, address: OWN });
  const own = await seedRule(db, { accountId: s.accountId, kind: "sender", match: OWN, destination: "INBOX" });
  const other = await seedRule(db, { accountId: s.accountId, kind: "sender", match: "friend@example.com", destination: "INBOX" });
  const patch = (id: string, body: Record<string, unknown>) =>
    H(req("PATCH", `/rules/${id}`, { bearer: s.token, body: JSON.stringify(body) }), deps);
  const read = async () => {
    const res = await H(req("GET", "/rules", { bearer: s.token }), deps);
    return Object.fromEntries(((await res.json()).items as Array<{ match: string; destination: string; enabled: boolean }>)
      .map((r) => [r.match, `${r.destination}:${r.enabled ? "on" : "off"}`]));
  };
  return { deps, s, own, other, patch, read };
}

describe("an existing rule about one of our own addresses", () => {
  it("PATCH moving it to another place answers 400 own_address and leaves it where it was", async () => {
    const { own, patch, read } = await account();
    for (const body of [
      { destination: "ohmail/News", applyRetro: false },
      { destination: "ohmail/Receipts" },
      { applyRetro: true },
      { priority: 5 },
      { enabled: true, destination: "ohmail/Screened" },
      { enabled: false, destination: "ohmail/News" },
    ]) {
      const res = await patch(own, body);
      expect({ body, status: res.status, code: (await res.json())?.error?.code })
        .toEqual({ body, status: 400, code: "own_address" });
    }
    expect((await read())[OWN]).toBe("INBOX:on");
  });

  it("can still be paused and removed (the positive control)", async () => {
    const { deps, s, own, patch, read } = await account();
    expect((await patch(own, { enabled: false })).status).toBe(200);
    expect((await read())[OWN]).toBe("INBOX:off");
    expect((await H(req("DELETE", `/rules/${own}`, { bearer: s.token }), deps)).status).toBe(204);
    expect((await read())[OWN]).toBeUndefined();
  });

  it("anybody else's rule still moves where it is sent (the positive control)", async () => {
    const { other, patch, read } = await account();
    expect((await patch(other, { destination: "ohmail/News", applyRetro: false })).status).toBe(200);
    expect((await read())["friend@example.com"]).toBe("ohmail/News:on");
  });

  it("an edit moving our own rule onto somebody else's address is admitted", async () => {
    const { own, patch, read } = await account();
    expect((await patch(own, { match: "friend2@example.com" })).status).toBe(200);
    expect((await read())["friend2@example.com"]).toBe("INBOX:on");
  });
});
