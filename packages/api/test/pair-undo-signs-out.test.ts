import { describe, it, expect } from "vitest";
import { createApp, type ApiDeps } from "@trafficflow/api";
import { desktopHostRoutes } from "@trafficflow/api/desktop-host";
import { selfHostRoutes } from "@trafficflow/api/self-host";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * AN UNDONE PAIRING LEAVES THE OTHER COMPUTER'S DEVICES LIST. The desktop that paired holds the
 * bearer the redeem handed it; its own `POST /auth/logout` — ungated, since taking back your own
 * credential must never be hard — revokes that session, and the minter's list reads live
 * sessions only. The desktop-host door mounts the route the pairing desktop asks.
 */
const app = createApp(selfHostRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

describe("the paired bearer's own sign-out", () => {
  it("takes the paired device off the minter's Devices list", async () => {
    const { db, deps } = await makeDeps();
    const minter = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const minted = await (await H(req("POST", "/pair", {
      bearer: minter.token, body: JSON.stringify({ grant: "device-pair", label: "Studio desktop" }),
    }), deps)).json();
    const paired = await (await H(req("POST", "/pair/redeem", {
      body: JSON.stringify({ grant: "device-pair", token: minted.token, kind: "desktop-linux" }),
    }), deps)).json();
    const labels = async (): Promise<string[]> =>
      ((await (await H(req("GET", "/devices", { bearer: minter.token }), deps)).json()).items as { label: string }[])
        .map((d) => d.label);
    expect(await labels()).toContain("Studio desktop");

    const out = await H(req("POST", "/auth/logout", {
      bearer: paired.tokens.accessToken, body: "{}",
    }), deps);
    expect(out.status, await out.clone().text()).toBe(204);
    expect(await labels()).not.toContain("Studio desktop");
  });

  it("is mounted on the desktop-host door, beside the redeem", () => {
    const keys = desktopHostRoutes.map((r) => `${r.method} ${r.pattern}`);
    expect(keys).toContain("POST /auth/logout");
    expect(keys).toContain("POST /pair/redeem");
  });
});
