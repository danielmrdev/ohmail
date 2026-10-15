import { describe, expect, it } from "vitest";
import {
  canonicalIp, makeTrustedProxies, parseTlsTerminatorList, parseTrustedProxyEntry, splitTrustedProxyList,
  type TrustedProxyNote,
} from "../../src/adapters/trusted-proxies.js";

/**
 * The trusted-proxy set the self-host server builds from `TF_TRUSTED_PROXIES`. The lookup and the
 * clock are injected, so every resolution below is deterministic; the production lookup
 * (`systemLookup`, Docker's resolver) is only exercised on a real compose stack.
 */

/** A clock the test moves, and a lookup that answers from a table the test edits. */
function rig(answers: Record<string, string[] | Error>) {
  let t = 1_000_000;
  const calls: string[] = [];
  const notes: TrustedProxyNote[] = [];
  const lookup = async (name: string): Promise<string[]> => {
    calls.push(name);
    const a = answers[name];
    if (a === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: "ENOTFOUND" });
    if (a instanceof Error) throw a;
    return a;
  };
  return {
    calls, notes, answers,
    now: () => t,
    advance: (ms: number) => { t += ms; },
    opts: { lookup, now: () => t, onNote: (n: TrustedProxyNote) => { notes.push(n); } },
  };
}

describe("canonicalIp: one spelling per address", () => {
  it("folds every spelling of an IPv4-mapped address to dotted IPv4", () => {
    expect(canonicalIp("::ffff:172.18.0.5")).toBe("172.18.0.5");
    expect(canonicalIp("::FFFF:172.18.0.5")).toBe("172.18.0.5");
    expect(canonicalIp("0:0:0:0:0:ffff:172.18.0.5")).toBe("172.18.0.5");
    expect(canonicalIp("::ffff:ac12:5")).toBe("172.18.0.5");
  });

  it("lowercases and compresses IPv6, drops a zone id and brackets", () => {
    expect(canonicalIp("2001:DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
    expect(canonicalIp("[2001:db8::1]")).toBe("2001:db8::1");
    expect(canonicalIp("fe80::1%eth0")).toBe("fe80::1");
    expect(canonicalIp(" 203.0.113.7 ")).toBe("203.0.113.7");
  });

  it("anything that is not an address is empty, never a guess", () => {
    for (const junk of ["", "unknown", "_hidden", "203.0.113.7:4431", "01.2.3.4", "1.2.3", "proxy", "::gg"]) {
      expect(canonicalIp(junk), junk).toBe("");
    }
  });
});

describe("parsing TF_TRUSTED_PROXIES entries", () => {
  it("addresses, CIDRs and names, each in its canonical form", () => {
    expect(parseTrustedProxyEntry("::ffff:172.18.0.5")).toEqual({ kind: "address", address: "172.18.0.5" });
    expect(parseTrustedProxyEntry("172.16.0.0/12")).toEqual({ kind: "cidr", network: "172.16.0.0", prefix: 12, family: "ipv4" });
    expect(parseTrustedProxyEntry("fd00::/8")).toEqual({ kind: "cidr", network: "fd00::", prefix: 8, family: "ipv6" });
    expect(parseTrustedProxyEntry("proxy")).toEqual({ kind: "name", name: "proxy" });
    expect(parseTrustedProxyEntry("ohmail_proxy_1")).toEqual({ kind: "name", name: "ohmail_proxy_1" });
    expect(parseTrustedProxyEntry("Proxy.Internal.")).toEqual({ kind: "name", name: "proxy.internal." });
  });

  it("an address or CIDR that does not parse is a problem; a name never is for not resolving", () => {
    for (const bad of ["300.1.1.1", "1.2.3", "172.16.0.0/33", "172.16.0.0/x", "::gg", "[::1", "fd00::/129", "proxy!"]) {
      expect(parseTrustedProxyEntry(bad), bad).toHaveProperty("problem");
    }
    expect(parseTrustedProxyEntry("a-name-nothing-resolves")).toEqual({ kind: "name", name: "a-name-nothing-resolves" });
  });

  it("commas and whitespace both separate", () => {
    expect(splitTrustedProxyList(" proxy, 172.16.0.0/12\t10.0.0.1 ,")).toEqual(["proxy", "172.16.0.0/12", "10.0.0.1"]);
    expect(splitTrustedProxyList("")).toEqual([]);
  });
});

/**
 * OHMAIL_TLS_TERMINATOR: only the shapes the proxy (Caddy's `trusted_proxies static`) and the api
 * read alike. What Caddy itself reads for each shape is a recording from the real image
 * (test/fixtures/selfhost/caddy-2.10.2-terminator-verdicts.json, asserted at the repo root).
 */
describe("parsing OHMAIL_TLS_TERMINATOR, the intersection grammar", () => {
  it("addresses and CIDRs as written, separated by single spaces", () => {
    expect(parseTlsTerminatorList("172.16.0.0/12")).toEqual({ ok: true, entries: ["172.16.0.0/12"] });
    expect(parseTlsTerminatorList("10.0.0.0/8 192.168.1.5 fd00::/8 2001:db8::9")).toEqual({
      ok: true, entries: ["10.0.0.0/8", "192.168.1.5", "fd00::/8", "2001:db8::9"],
    });
    expect(parseTlsTerminatorList("0.0.0.0/32")).toEqual({ ok: true, entries: ["0.0.0.0/32"] });
  });

  it("nothing but whitespace is unset, the entrypoint's set of bytes: empty, spaces, line breaks, U+00A0", () => {
    for (const v of ["", "   ", "\n", "\n \n", "\u00a0", "\t\r\v\f\u00a0 \n"]) {
      expect(parseTlsTerminatorList(v), JSON.stringify(v)).toEqual({ ok: true, entries: [] });
    }
    // Whitespace the entrypoint does not count as unset is a value, and is refused as one.
    expect(parseTlsTerminatorList("\u3000")).toEqual({ ok: false, refusal: "whitespace", position: 0 });
    expect(parseTlsTerminatorList("\u2028")).toEqual({ ok: false, refusal: "line", position: 0 });
  });

  it("the value is read untrimmed: any whitespace but single spaces between entries is refused by name", () => {
    for (const v of [" 203.0.113.9", "203.0.113.9 ", "10.0.0.0/8  192.168.1.5", "10.0.0.0/8\t192.168.1.5",
      "10.0.0.1\u00a0192.168.1.5", "203.0.113.9\u3000"]) {
      expect(parseTlsTerminatorList(v), JSON.stringify(v)).toEqual({ ok: false, refusal: "whitespace", position: 0 });
    }
  });

  it("a comma anywhere is refused, for the whole value, whatever surrounds it", () => {
    for (const v of ["10.0.0.0/8,192.168.1.5", "10.0.0.0/8, 192.168.1.5", "10.0.0.1,"]) {
      expect(parseTlsTerminatorList(v), v).toEqual({ ok: false, refusal: "comma", position: 0 });
    }
  });

  it("a line break is refused, leading and trailing ones too: it would start a new proxy directive", () => {
    for (const v of ["10.0.0.0/8\n192.168.1.5", "10.0.0.1\r", "203.0.113.9\n", "\n203.0.113.9"]) {
      expect(parseTlsTerminatorList(v), JSON.stringify(v)).toEqual({ ok: false, refusal: "line", position: 0 });
    }
  });

  it("an IPv4 address in IPv6 form is refused at its position, address or CIDR, any spelling", () => {
    expect(parseTlsTerminatorList("10.0.0.1 ::ffff:172.16.0.0/108")).toEqual({ ok: false, refusal: "mapped", position: 2 });
    expect(parseTlsTerminatorList("::ffff:203.0.113.9")).toEqual({ ok: false, refusal: "mapped", position: 1 });
    expect(parseTlsTerminatorList("::FFFF:cb00:7109")).toEqual({ ok: false, refusal: "mapped", position: 1 });
    // An IPv6 address that is not a mapped IPv4 one is an ordinary IPv6 entry.
    expect(parseTlsTerminatorList("::1 fe80::1")).toEqual({ ok: true, entries: ["::1", "fe80::1"] });
  });

  it("a word is refused: a Caddy keyword the api does not share, or a name the proxy never looks up", () => {
    for (const [v, position] of [["private_ranges", 1], ["10.0.0.1 link_local", 2], ["terminator.example", 1], ["proxy", 1]] as const) {
      expect(parseTlsTerminatorList(v), v).toEqual({ ok: false, refusal: "word", position });
    }
  });

  it("anything else that is not a plain address is malformed: bad octets, prefixes, zones, brackets", () => {
    for (const v of ["300.1.1.1", "1.2.3", "10.0.0.0/33", "10.0.0.0/08", "fd00::/129", "10.0.0.0/", "fe80::1%eth0", "[2001:db8::9]", "::gg"]) {
      expect(parseTlsTerminatorList(v), v).toEqual({ ok: false, refusal: "malformed", position: 1 });
    }
  });
});

describe("the set: literals and CIDRs are trusted without a lookup", () => {
  it("a literal matches the peer's mapped spelling and the reverse", async () => {
    const r = rig({});
    const plain = makeTrustedProxies(["172.18.0.5"], r.opts);
    expect(await plain.trustsPeer(canonicalIp("::ffff:172.18.0.5"))).toBe(true);
    const mapped = makeTrustedProxies(["::ffff:172.18.0.5"], r.opts);
    expect(mapped.has("172.18.0.5")).toBe(true);
    expect(r.calls).toEqual([]);
  });

  it("a CIDR admits its range and nothing outside it", async () => {
    const s = makeTrustedProxies(["172.16.0.0/12", "fd00::/8"], rig({}).opts);
    expect(s.has("172.31.226.1")).toBe(true);
    expect(s.has("172.32.0.1")).toBe(false);
    expect(s.has("192.168.1.10")).toBe(false);
    expect(s.has("fd12::5")).toBe(true);
    expect(await s.trustsPeer("10.0.0.1")).toBe(false);
  });

  it("an empty set trusts nobody and never looks anything up", async () => {
    const r = rig({ proxy: ["172.18.0.5"] });
    const s = makeTrustedProxies([], r.opts);
    expect(s.empty).toBe(true);
    expect(await s.trustsPeer("172.18.0.5")).toBe(false);
    expect(r.calls).toEqual([]);
  });
});

describe("the set: a name is resolved on a miss, bounded, and expires", () => {
  it("the name does not resolve yet, then does; the first request after is trusted ON THAT REQUEST", async () => {
    const r = rig({});
    const s = makeTrustedProxies(["proxy"], { ...r.opts, minLookupMs: 5_000 });
    expect(await s.trustsPeer("172.18.0.5")).toBe(false);
    expect(r.notes).toEqual([{ kind: "unresolved", name: "proxy" }]);
    r.answers.proxy = ["172.18.0.5"];
    r.advance(5_000);
    expect(await s.trustsPeer("172.18.0.5")).toBe(true);
    expect(r.calls).toEqual(["proxy", "proxy"]);
    expect(r.notes[1]).toEqual({ kind: "resolved", name: "proxy", addresses: ["172.18.0.5"] });
  });

  it("a thousand requests from an untrusted peer inside one interval cost ONE lookup", async () => {
    const r = rig({ proxy: ["172.18.0.5"] });
    const s = makeTrustedProxies(["proxy"], { ...r.opts, minLookupMs: 5_000 });
    const verdicts = await Promise.all(Array.from({ length: 500 }, () => s.trustsPeer("203.0.113.7")));
    for (let i = 0; i < 500; i++) { r.advance(1); verdicts.push(await s.trustsPeer("203.0.113.7")); }
    expect(verdicts.every((v) => v === false)).toBe(true);
    expect(r.calls).toEqual(["proxy"]);
    // The proxy itself is trusted from the cache that one lookup filled, with no second lookup.
    expect(await s.trustsPeer("172.18.0.5")).toBe(true);
    expect(r.calls).toEqual(["proxy"]);
  });

  it("control 8: a recreated proxy at a new address is trusted, the old address stops being trusted past the TTL", async () => {
    const r = rig({ proxy: ["172.18.0.5"] });
    const s = makeTrustedProxies(["proxy"], { ...r.opts, minLookupMs: 5_000, ttlMs: 60_000 });
    expect(await s.trustsPeer("172.18.0.5")).toBe(true);
    r.answers.proxy = ["172.18.0.9"];
    r.advance(5_000);
    // The new address misses, resolves and is trusted on its first request…
    expect(await s.trustsPeer("172.18.0.9")).toBe(true);
    // …and the old one is gone from that same answer.
    expect(await s.trustsPeer("172.18.0.5")).toBe(false);
    expect(r.notes.map((n) => n.kind)).toEqual(["resolved", "resolved"]);
  });

  it("a cached address is looked up again once it is older than the TTL", async () => {
    const r = rig({ proxy: ["172.18.0.5"] });
    const s = makeTrustedProxies(["proxy"], { ...r.opts, minLookupMs: 5_000, ttlMs: 60_000 });
    expect(await s.trustsPeer("172.18.0.5")).toBe(true);
    r.advance(59_000);
    expect(await s.trustsPeer("172.18.0.5")).toBe(true);
    expect(r.calls).toHaveLength(1);
    r.answers.proxy = new Error("getaddrinfo EAI_AGAIN proxy");
    r.advance(2_000);
    expect(await s.trustsPeer("172.18.0.5")).toBe(false);
    expect(r.calls).toHaveLength(2);
    expect(r.notes.at(-1)).toEqual({ kind: "unresolved", name: "proxy" });
  });

  it("a failure is said once per transition, not once per request", async () => {
    const r = rig({});
    const s = makeTrustedProxies(["proxy"], { ...r.opts, minLookupMs: 1 });
    for (let i = 0; i < 5; i++) { r.advance(10); await s.trustsPeer("172.18.0.5"); }
    expect(r.calls).toHaveLength(5);
    expect(r.notes).toEqual([{ kind: "unresolved", name: "proxy" }]);
  });

  it("for a forwarder: a thousand requests carrying the header from one untrusted peer cost ONE lookup", async () => {
    const r = rig({ proxy: ["172.18.0.5"] });
    const s = makeTrustedProxies(["proxy"], { ...r.opts, minLookupMs: 5_000 });
    for (let i = 0; i < 1_000; i++) { r.advance(4); expect(await s.trustsPeer("172.18.0.66", true)).toBe(false); }
    expect(r.calls).toEqual(["proxy"]);
  });

  it("a spray of a thousand never-seen peers inside one interval costs ONE lookup", async () => {
    const r = rig({ proxy: ["172.18.0.5"] });
    const s = makeTrustedProxies(["proxy"], { ...r.opts, minLookupMs: 5_000 });
    for (let i = 0; i < 1_000; i++) { r.advance(4); await s.trustsPeer(`10.1.${i >> 8}.${i & 255}`); }
    expect(r.calls).toEqual(["proxy"]);
  });

  it("a peer a complete lookup refuted costs no further lookup within the TTL (the server's own health check)", async () => {
    const r = rig({ proxy: ["172.18.0.5"] });
    const s = makeTrustedProxies(["proxy"], { ...r.opts, minLookupMs: 5_000, ttlMs: 60_000 });
    for (let i = 0; i < 12; i++) { expect(await s.trustsPeer("127.0.0.1")).toBe(false); r.advance(5_000); }
    expect(r.calls).toEqual(["proxy"]);
  });

  it("a recreated proxy is trusted on its FIRST request even when another peer just spent the lookup", async () => {
    const r = rig({ proxy: ["172.18.0.5"] });
    const slept: number[] = [];
    const s = makeTrustedProxies(["proxy"], {
      ...r.opts, minLookupMs: 5_000, sleep: async (ms) => { slept.push(ms); r.advance(ms); },
    });
    expect(await s.trustsPeer("172.18.0.5", true)).toBe(true);
    r.advance(10_000);
    // The health check (no header) spends the lookup; then the proxy is recreated elsewhere.
    expect(await s.trustsPeer("127.0.0.1")).toBe(false);
    r.answers.proxy = ["172.18.0.9"];
    r.advance(1_000);
    expect(await s.trustsPeer("172.18.0.9", true)).toBe(true);
    expect(slept).toEqual([4_000]);
    expect(r.calls).toHaveLength(3);
  });

  it("a never-seen peer that does not forward does not wait for a lookup", async () => {
    const r = rig({ proxy: ["172.18.0.5"] });
    const slept: number[] = [];
    const s = makeTrustedProxies(["proxy"], { ...r.opts, minLookupMs: 5_000, sleep: async (ms) => { slept.push(ms); } });
    await s.trustsPeer("127.0.0.1");
    r.advance(1_000);
    expect(await s.trustsPeer("172.18.0.40")).toBe(false);
    expect(slept).toEqual([]);
    expect(r.calls).toHaveLength(1);
  });

  it("a refuted peer that starts forwarding is asked about again within the budget (a proxy at a reused address)", async () => {
    const r = rig({ proxy: ["172.18.0.5"] });
    const s = makeTrustedProxies(["proxy"], { ...r.opts, minLookupMs: 5_000, ttlMs: 60_000 });
    expect(await s.trustsPeer("172.18.0.20")).toBe(false);
    r.answers.proxy = ["172.18.0.20"];
    r.advance(6_000);
    expect(await s.trustsPeer("172.18.0.20")).toBe(false);
    expect(await s.trustsPeer("172.18.0.20", true)).toBe(true);
    expect(r.calls).toHaveLength(2);
  });

  it("a lookup that never answers fails at the timeout and trusts nothing", async () => {
    const s = makeTrustedProxies(["proxy"], {
      lookup: () => new Promise<string[]>(() => { /* never settles */ }),
      lookupTimeoutMs: 20,
    });
    const started = Date.now();
    expect(await s.trustsPeer("172.18.0.5")).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
