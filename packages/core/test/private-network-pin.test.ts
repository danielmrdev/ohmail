import { describe, it, expect } from "vitest";
import { isPrivateNetworkAddress, privateNetworkPin, type HostResolver } from "../src/net/index.js";

/**
 * WHERE A PASSWORD MAY TRAVEL UNENCRYPTED: only to a mail server on the person's own network or
 * this machine. The connect probe offers plaintext for such a host alone, and dials the address
 * judged here, so a public answer anywhere in the set, or no answer, must read as "not private".
 */

const resolving = (...addrs: string[]): HostResolver => ({ resolve: async () => addrs });

describe("isPrivateNetworkAddress", () => {
  it("admits the home-network and loopback ranges, in both families", () => {
    for (const ip of ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.20", "127.0.0.1", "::1", "fd00::25", "fc12::1", "::ffff:192.168.1.20", "[fd00::25]"]) {
      expect(isPrivateNetworkAddress(ip), ip).toBe(true);
    }
  });

  it("refuses public, reserved-but-not-private and unparseable addresses", () => {
    for (const ip of ["93.184.216.34", "172.32.0.1", "172.15.255.255", "100.64.0.1", "169.254.1.1", "fe80::1", "2001:db8::1", "::ffff:93.184.216.34", "0.0.0.0", "010.0.0.1", "not-an-ip", ""]) {
      expect(isPrivateNetworkAddress(ip), ip).toBe(false);
    }
  });
});

describe("privateNetworkPin", () => {
  it("a name that resolves only to private addresses pins to exactly those", async () => {
    expect(await privateNetworkPin("mail.home.arpa", resolving("192.168.1.20", "fd00::25"))).toEqual(["192.168.1.20", "fd00::25"]);
  });

  it("one public address among private ones makes the host public", async () => {
    expect(await privateNetworkPin("mail.example.com", resolving("192.168.1.20", "93.184.216.34"))).toBeNull();
  });

  it("a literal is judged without DNS, and a name that does not resolve is not private", async () => {
    const never: HostResolver = { resolve: async () => { throw new Error("no DNS here"); } };
    expect(await privateNetworkPin("10.1.2.3", never)).toEqual(["10.1.2.3"]);
    expect(await privateNetworkPin("[fd00::25]", never)).toEqual(["fd00::25"]);
    expect(await privateNetworkPin("93.184.216.34", never)).toBeNull();
    expect(await privateNetworkPin("mail.home.arpa", never)).toBeNull();
    expect(await privateNetworkPin("mail.home.arpa", resolving())).toBeNull();
  });
});
