import { describe, expect, it } from "vitest";
import { desktopHostRoutes } from "@trafficflow/api/desktop-host";
import { lanCandidates, localLanRoutes } from "../src/lan-routes.js";

/**
 * The LAN ceremony's enumeration — what is offered, and WHERE the route lives. The filter rules
 * are `lan-routes.ts`'s header; the door placement is the security half: the stdio door is the
 * window's own, and a paired device must never be able to enumerate the host machine's
 * interfaces, so the pattern must not exist in `desktopHostRoutes` (which the LAN door also
 * serves).
 */

type Interfaces = Record<string, Array<{ address: string; family: string; internal: boolean }>>;

const fake = (interfaces: Interfaces) => () =>
  interfaces as unknown as ReturnType<typeof import("node:os").networkInterfaces>;

describe("lanCandidates", () => {
  it("offers real IPv4 interface addresses with their interface names", () => {
    const out = lanCandidates(fake({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      en0: [
        { address: "192.168.1.23", family: "IPv4", internal: false },
        { address: "fe80::1c2a", family: "IPv6", internal: false },
      ],
      eth1: [{ address: "10.1.2.3", family: "IPv4", internal: false }],
    }));
    expect(out).toEqual([
      { address: "192.168.1.23", name: "en0" },
      { address: "10.1.2.3", name: "eth1" },
    ]);
  });

  it("filters loopback, IPv6, link-local and the Tailscale CGNAT range", () => {
    const out = lanCandidates(fake({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      en1: [{ address: "169.254.7.7", family: "IPv4", internal: false }],
      utun3: [
        { address: "100.101.102.103", family: "IPv4", internal: false }, // tailscale's own
        { address: "100.63.0.1", family: "IPv4", internal: false },      // below the CGNAT range
        { address: "100.128.0.1", family: "IPv4", internal: false },     // above it
      ],
    }));
    expect(out).toEqual([
      { address: "100.63.0.1", name: "utun3" },
      { address: "100.128.0.1", name: "utun3" },
    ]);
  });
});

describe("where the route lives", () => {
  it("is a stdio-door route and is structurally absent from the doors a paired device reaches", () => {
    const routes = localLanRoutes(() => "a-fingerprint");
    expect(routes.map((r) => `${r.method} ${r.pattern}`)).toEqual([
      "GET /local/lan/candidates",
      "GET /local/lan/pin",
    ]);
    // The LAN and Tailscale doors serve `desktopHostRoutes`; interface enumeration and the
    // door's key fingerprint must not be in that table — a paired (or merely same-network)
    // device has no business asking for either. One prefix covers both, and this is why the
    // pin route was put under it rather than beside it.
    expect(desktopHostRoutes.some((r) => r.pattern.startsWith("/local/lan"))).toBe(false);
  });

  /**
   * THE TWO PRE-TABLE ACTIONS ARE THIS COMPUTER'S OWN, and the doors a paired device reaches must
   * not carry them. Both are statements about the MACHINE rather than about the mailbox — forget
   * the password sealed on this disk (`DELETE /local/stored-login`); make this machine the
   * organizer of a mailbox (`POST /local/organizer/takeover`) — and their whole authority is that
   * somebody is sitting at it. A phone on the same network asserting either would be a remote
   * device spending an authority it does not hold.
   *
   * They are served from `engine.ts`'s `handle` AHEAD of the route table, which is exactly what
   * makes this assertion the right one: the LAN and Tailscale doors route by `matchRoute` over
   * `desktopHostRoutes`, so a path that table has never heard of falls through to the static
   * handler and 404s. This is structural, and this line is what keeps it structural — adding
   * either path to the shared table would open it on three doors at once, silently.
   */
  it("the machine-local actions are absent from the doors a paired device reaches", () => {
    for (const path of ["/local/stored-login", "/local/organizer/takeover"]) {
      expect(desktopHostRoutes.some((r) => r.pattern === path),
        `${path} is reachable from the host and LAN doors — it is an action about THIS COMPUTER`)
        .toBe(false);
    }
  });
});

describe("the pin route reads the identity LIVE", () => {
  it("answers whatever the engine holds now, not what it held at mount", async () => {
    // A captured VALUE here would answer null for the life of a process that resolved its
    // identity a moment after mounting its routes — a window that could never compose a
    // pairing link, on an install whose door was serving perfectly.
    let held: string | null = null;
    const pin = localLanRoutes(() => held)[1]!;
    const call = async (): Promise<unknown> =>
      (await pin.handler(new Request("http://localhost/local/lan/pin"), {} as never, {})).json();
    expect(await call()).toEqual({ fingerprint: null });
    held = "SPKI-FINGERPRINT";
    expect(await call()).toEqual({ fingerprint: "SPKI-FINGERPRINT" });
  });
});
