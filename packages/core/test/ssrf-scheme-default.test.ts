import { describe, it, expect } from "vitest";
import { assertPublicHttpUrl, type HostResolver } from "../src/net/index.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE GATE'S DEFAULTS ARE A CONTRACT WITH ITS EXISTING CALLERS
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `assertPublicHttpUrl` has three callers that pass NO options — the image proxy, the one-click
 * unsubscribe POST and the add-mailbox host probe — and they predate the options parameter
 * entirely. So "what does this function do when called the way it has always been called" is a
 * contract, and this file is it.
 *
 * ── WHY IT EXISTS: A TIGHTENING IS A BREAKING CHANGE TOO ──────────────────────────────────────
 *
 * The UnifiedPush wake wants https-only endpoints, and that option was first written as
 * `allowHttp`, defaulting to `false`. It reads like the cautious choice and it silently changed
 * every existing caller: the gate has always accepted `http:`, and `privacy-service`'s image proxy
 * passes no options, so plain-`http:` images in real mail stopped loading. Nothing was red,
 * because a refused image is indistinguishable from an image that would not have loaded.
 *
 * The lesson is not "be careful with defaults", it is that a new option must not be able to move
 * an existing call site IN EITHER DIRECTION. Loosening one is the obvious sin; tightening one is
 * the same sin with better intentions. The flag is now `httpsOnly`, so the default is the
 * historical behaviour and the caller that wants the new rule asks for it by name.
 *
 * Watched red by flipping the default back: `httpsOnly` defaulted to `true` turns the first case
 * here red by name.
 */

const PUBLIC = "93.184.216.34";
const resolver: HostResolver = { async resolve() { return [PUBLIC]; } };

describe("assertPublicHttpUrl — the no-options contract", () => {
  it("accepts plain http: — this is what the image proxy has always relied on", async () => {
    await expect(assertPublicHttpUrl("http://images.example.com/pixel.png", resolver))
      .resolves.toEqual([PUBLIC]);
  });

  it("accepts https: too, obviously", async () => {
    await expect(assertPublicHttpUrl("https://images.example.com/pixel.png", resolver))
      .resolves.toEqual([PUBLIC]);
  });

  it("still refuses a non-default port with no options — the other default nobody may move", async () => {
    await expect(assertPublicHttpUrl("https://images.example.com:8443/x", resolver))
      .rejects.toThrow(/port is not allowed/);
  });

  it("still refuses a private answer, a literal and userinfo with no options", async () => {
    const priv: HostResolver = { async resolve() { return ["169.254.169.254"]; } };
    await expect(assertPublicHttpUrl("http://meta.example.com/x", priv))
      .rejects.toThrow(/non-public address/);
    await expect(assertPublicHttpUrl("http://127.0.0.1/x", resolver))
      .rejects.toThrow(/non-public address/);
    await expect(assertPublicHttpUrl("https://user@127.0.0.1/x", resolver))
      .rejects.toThrow(/userinfo/);
  });
});

describe("assertPublicHttpUrl — the options the wake sender asks for BY NAME", () => {
  it("httpsOnly refuses http:, and only when asked", async () => {
    await expect(assertPublicHttpUrl("http://push.example.com/up/x", resolver, { httpsOnly: true }))
      .rejects.toThrow(/scheme must be https/);
    await expect(assertPublicHttpUrl("https://push.example.com/up/x", resolver, { httpsOnly: true }))
      .resolves.toEqual([PUBLIC]);
  });

  it("allowExplicitPort permits a port and CHANGES NOTHING about the address rules", async () => {
    await expect(assertPublicHttpUrl("https://push.example.com:8443/up/x", resolver, { allowExplicitPort: true }))
      .resolves.toEqual([PUBLIC]);
    // A port on a private address is still refused — the two rules are independent.
    await expect(assertPublicHttpUrl("https://127.0.0.1:8443/up/x", resolver, { allowExplicitPort: true }))
      .rejects.toThrow(/non-public address/);
    const priv: HostResolver = { async resolve() { return ["10.0.0.5"]; } };
    await expect(assertPublicHttpUrl("https://ntfy.example.com:8443/up/x", priv, { allowExplicitPort: true }))
      .rejects.toThrow(/non-public address/);
  });
});
