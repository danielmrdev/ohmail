import { describe, expect, it } from "vitest";
import { localRoutes } from "@trafficflow/api/local";
import { assertPublicHttpUrl, nodeHostResolver } from "@trafficflow/services/mail";

/**
 * THE DESKTOP'S IMAGE PROXY — the third egress this process has, and the gate that bounds it.
 *
 * The route was mounted on this door all along; what was refused was the EGRESS, with the
 * reason written at the composition: no allow-list of hosts this machine may talk to. Pictures
 * load now, so the refusal moved to where it can be reasoned about — the SSRF gate, which resolves every url and refuses anything that lands on the
 * reader's own network, exactly as the hosted door does.
 *
 * What is asserted here is the gate's behaviour under the REAL resolver, because a gate driven
 * by a resolver double proves the arithmetic and not the wiring; and the mount, because the
 * route's cost class is what keeps it behind a session.
 */

describe("the local door serves the image proxy, and serves it as a socket-opening route", () => {
  it("mounts exactly one GET /img, session-gated and raw", () => {
    const img = localRoutes.filter((r) => r.pattern === "/img");
    expect(img, "the local door lost (or doubled) its image proxy").toHaveLength(1);
    /* `connection` is what marks it as opening a socket to a host the SENDER named — the
       cost class the router reads. Raw because the answer is bytes, not the JSON envelope. */
    expect(img[0]!.cost, "the image proxy stopped declaring its socket cost").toBe("connection");
    expect(img[0]!.options?.raw).toBe(true);
    /* `mid` is an AUTHORISATION, and it is only one if a session is resolved first. */
    expect(img[0]!.options?.public ?? false, "the image proxy went public").toBe(false);
    expect(img[0]!.options?.anonymous ?? false).toBe(false);
  });
});

describe("the SSRF gate, under the resolver the desktop actually runs", () => {
  /**
   * THE ARM THE DESKTOP NEEDS MOST. A desktop sits INSIDE somebody's home network, so a url
   * naming a private address is not an abstract SSRF — it is a message reaching the reader's
   * router, printer or hypervisor metadata service. Each of these is refused on the literal,
   * before any name is resolved and before any socket is opened.
   *
   * Mutation: drop the private-range arm from `@trafficflow/core/net`'s refusal set. Real
   * failure text: "a message could make this machine fetch 10.0.0.5: expected promise to reject".
   */
  it.each([
    ["loopback", "http://127.0.0.1/pixel.png"],
    ["loopback v6", "http://[::1]/pixel.png"],
    ["private 10/8", "http://10.0.0.5/pixel.png"],
    ["private 192.168/16", "http://192.168.1.1/pixel.png"],
    ["link-local metadata", "http://169.254.169.254/latest/meta-data"],
  ])("refuses %s before it opens anything", async (_label, url) => {
    await expect(
      assertPublicHttpUrl(url, nodeHostResolver),
      `a message could make this machine fetch ${url}`,
    ).rejects.toThrow();
  });

  /**
   * THE POSITIVE CONTROL, and it is the reason the arms above mean anything: a refusal rule whose
   * permit branch is never exercised would pass with the gate refusing EVERYTHING, which is
   * precisely the state this lane is moving the desktop out of.
   *
   * It drives a RESOLVER DOUBLE rather than `nodeHostResolver`, and the reason is the arms above,
   * not convenience: those are IP LITERALS, refused on the literal before any name is looked up,
   * so they need no DNS and the real resolver is the honest thing to hand them. A hostname needs
   * an answer, and taking that answer from the network would make this case a test of whoever is
   * running it — it fails closed with "host did not resolve" wherever DNS is unavailable, which
   * is a green-to-red flip that says nothing about the gate. The double answers a public address;
   * what is under test is what the gate DOES with one.
   */
  it("admits a host that resolves publicly, and returns the addresses the fetch is pinned to", async () => {
    const publicResolver = { resolve: async () => ["93.184.216.34"] };
    const pinned = await assertPublicHttpUrl("https://pictures.example/hero.png", publicResolver);
    expect(pinned, "the gate admitted a host but pinned no address").toEqual(["93.184.216.34"]);
  });

  /**
   * AND THE SAME DOUBLE POINTED SOMEWHERE PRIVATE — the arm that proves the gate resolves the
   * NAME rather than merely reading the literal. A sender who controls DNS for their own host
   * can point it at the reader's router; the refusal has to survive that, and without this case
   * the five literal arms above would all pass on a gate that only ever parsed strings.
   */
  it("refuses a host whose NAME resolves onto the reader's own network", async () => {
    const rebinding = { resolve: async () => ["192.168.1.1"] };
    await expect(
      assertPublicHttpUrl("https://pictures.example/hero.png", rebinding),
      "a sender-controlled name resolving to a LAN address was admitted",
    ).rejects.toThrow();
  });
});
