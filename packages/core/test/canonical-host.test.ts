import { describe, it, expect } from "vitest";
import {
  assertPublicHostShape, canonicalHost, resolvePinUnchecked, type HostResolver,
} from "../src/net/ssrf-guard.js";
import { hostOf, isKnownTracker } from "../src/privacy/tracker-blocker.js";

/**
 * ONE SPELLING OF A HOST, THE ONE THE GATE DIALS. The SSRF gate lowered the case and dropped a
 * FQDN's root dot before it asked anything; the image proxy's tracker list compared `URL.host`,
 * which keeps both the dot and a port, so `us1.list-manage.com.` was fetched while
 * `us1.list-manage.com` was refused. Both now read `canonicalHost`, and these cases break if
 * either stops.
 */

describe("canonicalHost", () => {
  it("lowers the case and drops ONE root dot", () => {
    expect(canonicalHost("Example.COM.")).toBe("example.com");
    expect(canonicalHost("example.com")).toBe("example.com");
    expect(canonicalHost("example.com..")).toBe("example.com.");
  });
});

describe("the gate reads the canonical host", () => {
  it("a FQDN's root dot is the same host", () => {
    expect(assertPublicHostShape("Example.COM.")).toEqual({ host: "example.com", literal: null });
  });

  it("a blocked name keeps its refusal with a root dot", () => {
    expect(() => assertPublicHostShape("printer.local.")).toThrow("host is not public");
  });

  it("the pin-only path asks the resolver for the canonical name", async () => {
    const asked: string[] = [];
    const resolver: HostResolver = { async resolve(h) { asked.push(h); return ["192.168.1.20"]; } };
    expect(await resolvePinUnchecked("https://Printer.LAN./x", resolver)).toEqual(["192.168.1.20"]);
    expect(asked).toEqual(["printer.lan"]);
  });
});

describe("the tracker list reads the host the gate dials", () => {
  it.each([
    "https://us1.list-manage.com./r/abc123.jpg",
    "https://US1.LIST-MANAGE.COM./r/abc123.jpg",
    "https://us1.list-manage.com:443/r/abc123.jpg",
    "https://cdn.example.com./p.png",
  ])("%s", (url) => {
    expect(hostOf(url)).toBe(canonicalHost(new URL(url).hostname));
  });

  it("a listed host with a root dot is still listed", () => {
    expect(isKnownTracker(hostOf("https://us1.list-manage.com./r/abc123.jpg"))).toBe(true);
  });
});
