import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { createApp, type ApiDeps } from "@trafficflow/api";
import { apiRoutes } from "@trafficflow/api";
import { desktopHostRoutes } from "@trafficflow/api/desktop-host";
import { selfHostRoutes } from "@trafficflow/api/self-host";
import { pairStateRoutes } from "../src/routes/pair.js";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * `POST /pair/state` — IS THIS LINK STILL GOOD, asked by the token's HASH. A desktop checks a
 * pasted link before it configures anything; before this route a spent link was refused only at
 * the redeem, after the door had been set up. The hash here is computed with node's own sha256,
 * not the server's `hashToken`, so the two spellings are compared rather than shared.
 */
const app = createApp(selfHostRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });
const hashOf = (token: string): string => createHash("sha256").update(token, "utf8").digest("base64url");

const mint = async (d: ApiDeps, bearer: string, body: Record<string, unknown>): Promise<{ id: string; token: string }> =>
  (await H(req("POST", "/pair", { bearer, body: JSON.stringify(body) }), d)).json();
const state = async (d: ApiDeps, body: unknown): Promise<{ status: number; body: any }> => {
  const res = await H(req("POST", "/pair/state", { body: JSON.stringify(body) }), d);
  return { status: res.status, body: await res.json() };
};
const redeem = (d: ApiDeps, token: string): Promise<Response> =>
  H(req("POST", "/pair/redeem", { body: JSON.stringify({ grant: "device-pair", token }) }), d);

describe("POST /pair/state — a link's state by its hash, spending nothing", () => {
  it("live before the redeem, spent after it, and asking does not spend it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const minted = await mint(deps, s.token, { grant: "device-pair", label: "Desk" });

    const before = await state(deps, { tokenHash: hashOf(minted.token) });
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body).toEqual({ state: "live" });

    const paired = await redeem(deps, minted.token);
    expect(paired.status, await paired.clone().text()).toBe(200);

    expect((await state(deps, { tokenHash: hashOf(minted.token) })).body).toEqual({ state: "spent" });
  });

  it("expired past its ttl, revoked once taken back, unknown for anything else", async () => {
    const { db, deps, clock } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });

    const revoked = await mint(deps, s.token, { grant: "device-pair" });
    expect((await H(req("DELETE", `/pair/${revoked.id}`, { bearer: s.token }), deps)).status).toBe(204);
    expect((await state(deps, { tokenHash: hashOf(revoked.token) })).body).toEqual({ state: "revoked" });

    const short = await mint(deps, s.token, { grant: "device-pair", ttlSeconds: 120 });
    clock.advance(121_000);
    expect((await state(deps, { tokenHash: hashOf(short.token) })).body).toEqual({ state: "expired" });

    // An invite is not a device-pair link: the redeem this client makes would refuse it whatever
    // its state, so it reads as no link at all. So does a hash nobody minted.
    const invite = await mint(deps, s.token, { grant: "invite" });
    expect((await state(deps, { tokenHash: hashOf(invite.token) })).body).toEqual({ state: "unknown" });
    expect((await state(deps, { tokenHash: hashOf("never-minted") })).body).toEqual({ state: "unknown" });
  });

  it("takes the hash and never the token: a raw token or a malformed hash is refused 400", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const minted = await mint(deps, s.token, { grant: "device-pair" });

    for (const body of [{ token: minted.token }, { tokenHash: minted.token + "x" }, { tokenHash: 7 }, {}, []]) {
      const out = await state(deps, body);
      expect(out.status, JSON.stringify(body)).toBe(400);
      expect(out.body.error.code).toBe("validation_failed");
    }
    // Nothing above spent it: the link still redeems.
    expect((await redeem(deps, minted.token)).status).toBe(200);
  });

  it("needs no session, and is mounted wherever the redeem is — the same route object", () => {
    const [route] = pairStateRoutes;
    expect(route!.cost).toBe("ceremony");
    expect(route!.options).toEqual({ public: true });
    for (const table of [selfHostRoutes, apiRoutes, desktopHostRoutes]) {
      expect(table.filter((r) => r.pattern === "/pair/state")).toEqual([route]);
      expect(table.some((r) => r.pattern === "/pair/redeem")).toBe(true);
    }
  });
});
