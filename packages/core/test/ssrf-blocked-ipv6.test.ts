import { describe, it, expect } from "vitest";
import {
  SsrfRefusal, assertPublicHost, isBlockedAddress, isPrivateNetworkAddress, privateNetworkScope,
  type HostResolver,
} from "../src/net/index.js";

/**
 * The IPv6 half of the one address decision behind every managed egress path: the worker's dial
 * guard, the API probe, the image proxy, the unsubscribe POST and the UnifiedPush wake. Deny by
 * default: past the IPv4-carrying forms, which are unwrapped through the IPv4 set, only global
 * unicast (2000::/3) is admitted, less its non-global ranges.
 */

const resolving = (...addrs: string[]): HostResolver => ({ resolve: async () => addrs });
const never: HostResolver = { resolve: async () => { throw new Error("no DNS here"); } };
const refused = (...ips: string[]): void => { for (const ip of ips) expect(isBlockedAddress(ip), ip).toBe(true); };
const admitted = (...ips: string[]): void => { for (const ip of ips) expect(isBlockedAddress(ip), ip).toBe(false); };

describe("blockedIpv6: nothing outside 2000::/3 is public", () => {
  it("refuses fec0::1, the bottom of fec0::/10, the deprecated site-local range", () => {
    expect(isBlockedAddress("fec0::1")).toBe(true);
  });

  it("refuses feff:ffff::1, the top of fec0::/10", () => {
    expect(isBlockedAddress("feff:ffff::1")).toBe(true);
  });

  it("refuses site-local however it is spelled", () => {
    refused("FEC0::1", "[fec0::1]", "fec0::1%eth0", "fec0:0:0:ffff::1");
  });

  it("refuses a name whose only answer is site-local", async () => {
    await expect(assertPublicHost("mail.example", resolving("fec0::1"))).rejects.toBeInstanceOf(SsrfRefusal);
  });

  it("refuses the RFC 8215 local-use NAT64 prefix carrying 10.0.0.1 in the /96 form", () => {
    expect(isBlockedAddress("64:ff9b:1::a00:1")).toBe(true);
  });

  it("refuses the RFC 8215 local-use NAT64 prefix carrying 10.0.0.1 in the /48 form", () => {
    // RFC 6052 /48 layout: the IPv4 address sits in bytes 6-7 and 9-10; the last 32 bits are suffix.
    expect(isBlockedAddress("64:ff9b:1:a00:0:100:808:808")).toBe(true);
  });

  it("refuses the local-use NAT64 prefix whatever its tail, and the rest of 64:ff9b::/32", () => {
    refused("64:ff9b:1::808:808", "64:ff9b::1:0:808:808", "64:ff9b:a00:1::808:808");
  });

  it("still refuses unique-local, link-local and multicast", () => {
    refused("fc00::1", "fd00::1", "fe80::1", "febf:ffff::1", "ff02::1", "ff0e::1");
  });

  it("refuses fe7f::1 and the rest of fe00::/9, reserved", () => {
    refused("fe7f::1", "fe00::1");
  });

  it("refuses SIIT's translated form, discard-only, the dummy prefix and SRv6 SIDs", () => {
    refused("::ffff:0:a9fe:a9fe", "::ffff:0:a00:1", "100::1", "100:0:0:1::1", "5f00::1");
  });

  it("refuses either side of 2000::/3", () => {
    refused("1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "4000::1");
  });
});

describe("blockedIpv6: inside 2000::/3", () => {
  it("admits global unicast, by literal and by name", async () => {
    const global = ["2001:4860:4860::8888", "2606:2800:220:1:248:1893:25c8:1946"];
    admitted(...global);
    await expect(assertPublicHost("mail.example", resolving(...global))).resolves.toEqual(global);
  });

  it("admits the edges of 2000::/3", () => {
    admitted("2000::1", "3fff:ffff:ffff:ffff:ffff:ffff:ffff:fffe");
  });

  it("refuses 2001::/23, Teredo and benchmarking included, and admits the block past it", () => {
    refused("2001:100::1", "2001:1ff:ffff::1", "2001:0:4136:e378:8000:63bf:f5ff:fffe", "2001:2::1");
    admitted("2001:200::1");
  });

  it("refuses the documentation ranges and admits their neighbours", () => {
    refused("2001:db8::1", "3fff::1", "3fff:fff:ffff::1");
    admitted("2001:db7:ffff::1", "2001:db9::1", "3fff:1000::1");
  });
});

describe("blockedIpv6: the IPv4-carrying forms are unwrapped", () => {
  it("unwraps 6to4: 2002:0a00:0001:: carries 10.0.0.1", () => {
    expect(isBlockedAddress("2002:0a00:0001::")).toBe(true);
  });

  it("reads 6to4's IPv4 from bytes 2-5, never from the tail", () => {
    refused("2002:c0a8:101::1", "2002:a00:1::808:808");
    admitted("2002:808:808::1");
  });

  it("unwraps the NAT64 well-known prefix as an exact /96", () => {
    refused("64:ff9b::a00:1");
    admitted("64:ff9b::808:808");
  });

  it("unwraps v4-mapped and v4-compatible as before", () => {
    refused("::ffff:10.0.0.1", "::a00:1");
    admitted("::ffff:8.8.8.8", "::808:808");
  });

  it("refuses any address carrying a zone id, whatever it carries", () => {
    refused("0000:0000:0000:0000:0000:ffff:8.8.80.100%lo", "[::ffff:8.8.8.8%eth0]", "2606:4700::1%", "2606:4700::1%en0");
    admitted("0000:0000:0000:0000:0000:ffff:8.8.80.100", "2606:4700::1");
  });

  it("does not call site-local a private network: no password travels to it unencrypted", async () => {
    expect(isPrivateNetworkAddress("fec0::1")).toBe(false);
    expect(await privateNetworkScope("[fec0::1]", never)).toEqual({ kind: "public" });
  });
});

/** The 0.25.10 rule over raw bytes, frozen as the floor: the address check may refuse more, never less. */
function refusedIn02510(b: readonly number[]): boolean {
  const v4 = (q: readonly number[]): boolean => {
    const [a = 0, x = 0, y = 0] = q;
    return a === 0 || a === 10 || a === 127 || (a === 169 && x === 254) || (a === 172 && x >= 16 && x <= 31)
      || (a === 192 && x === 168) || (a === 100 && x >= 64 && x <= 127) || (a === 192 && x === 0 && (y === 0 || y === 2))
      || (a === 198 && (x === 18 || x === 19)) || (a === 198 && x === 51 && y === 100)
      || (a === 203 && x === 0 && y === 113) || a >= 224;
  };
  const zero = (n: number): boolean => b.slice(0, n).every((o) => o === 0);
  const tail = b.slice(12, 16);
  if (zero(16) || (zero(15) && b[15] === 1)) return true;
  if (zero(10) && b[10] === 0xff && b[11] === 0xff) return v4(tail);
  if (zero(12)) return v4(tail);
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return v4(tail);
  return (b[0]! & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) || b[0] === 0xff;
}

/** Seeded addresses, biased toward every prefix either rule decides on, middles zeroed now and then. */
function* addresses(n: number): Generator<number[]> {
  let s = 0x9e3779b9;
  const byte = (): number => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s & 0xff; };
  const prefixes = [
    [], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0x64, 0xff, 0x9b],
    [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0x64, 0xff, 0x9b, 0, 1], [0x20, 0x01, 0, 0], [0x20, 0x01, 0x01],
    [0x20, 0x01, 0x02], [0x20, 0x01, 0x0d, 0xb8], [0x20, 0x02], [0x3f, 0xff], [0xfe], [0xfc], [0xfd], [0xff],
    [0x01, 0x00], [0x5f, 0x00], [0x20], [0x26, 0x06], [0x2a], [0x1f], [0x40], [0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0],
  ];
  for (let i = 0; i < n; i++) {
    const pre = prefixes[i % prefixes.length]!;
    const b = Array.from({ length: 16 }, (_, k) => (k < pre.length ? pre[k]! : byte()));
    if (i % 7 === 0) b.fill(0, Math.max(4, pre.length), 12);
    yield b;
  }
}

const text = (b: readonly number[]): string =>
  Array.from({ length: 8 }, (_, i) => ((b[2 * i]! << 8) | b[2 * i + 1]!).toString(16)).join(":");

/** How many sampled addresses `first` refuses and `second` admits. */
function refusedOnlyBy(first: (b: number[]) => boolean, second: (b: number[]) => boolean): number {
  let n = 0;
  for (const b of addresses(48_000)) if (first(b) && !second(b)) n++;
  return n;
}

describe("blockedIpv6: never looser than the 0.25.10 rule", () => {
  const tip = (b: number[]): boolean => isBlockedAddress(text(b));

  it("refuses every sampled address the 0.25.10 rule refused", () => {
    expect(refusedOnlyBy(refusedIn02510, tip)).toBe(0);
  });

  it("the control: the same count reads what the tip newly refuses, so its zero above is a reading", () => {
    expect(refusedOnlyBy(tip, refusedIn02510)).toBeGreaterThan(0);
    expect(refusedOnlyBy(refusedIn02510, () => false)).toBeGreaterThan(0);
  });

  it("the tip admits sampled addresses, so a spelling it cannot parse cannot read as a zero", () => {
    expect(refusedOnlyBy(() => true, tip)).toBeGreaterThan(0);
  });
});
