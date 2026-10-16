import { afterEach, describe, expect, it } from "vitest";
import dns from "node:dns";
import { resolve4 as namedResolve4 } from "node:dns";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import { pinnedHttpRequest, pinnedLookup } from "@trafficflow/core/net";

/**
 * THE SUITE'S EGRESS GUARD JUDGES THE ADDRESS A SOCKET CONNECTS TO, NOT THE NAME IT WAS HANDED.
 * A dial pinned through `lookup` under an admitted name reaches whatever the lookup returns, so a
 * guard reading `host` alone admitted a mutated door's dial to a public address from a green run.
 * `224.0.0.1` stands for "not this machine": the kernel refuses a TCP connect to a multicast
 * address before any packet leaves (ENETUNREACH), so an admitted dial reads the kernel's code and
 * a refused one the guard's, and nothing leaves either way.
 */

const ELSEWHERE = "224.0.0.1";
const BLOCKED = /^EXTERNAL_NETWORK_BLOCKED/;

/** How one socket ended: `connected`, or the error's code, else the head of its message. */
function ending(sock: net.Socket): Promise<string> {
  return new Promise((resolve) => {
    sock.once("connect", () => { sock.destroy(); resolve("connected"); });
    sock.once("error", (err: NodeJS.ErrnoException) => { sock.destroy(); resolve(err.code ?? err.message); });
  });
}

const servers: net.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((res) => s.close(() => res()));
});

/** A listener on this machine, for the arms that must still connect. */
async function listener(): Promise<number> {
  const srv = net.createServer((s) => { s.on("error", () => {}); s.destroy(); });
  servers.push(srv);
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
  return (srv.address() as net.AddressInfo).port;
}

describe("a dial pinned through a lookup is judged by the address the lookup returns", () => {
  it("net.connect under an admitted name, pinned elsewhere, is refused by the guard", async () => {
    const said = await ending(net.connect({ host: "localhost", port: 9, lookup: pinnedLookup([ELSEWHERE]) }));
    expect(said, "the kernel answered, so the guard admitted a dial it never judged").toMatch(BLOCKED);
  });

  it("a socket's own connect, pinned elsewhere, is refused", async () => {
    const said = await ending(new net.Socket().connect({ host: "localhost", port: 9, lookup: pinnedLookup([ELSEWHERE]) }));
    expect(said).toMatch(BLOCKED);
  });

  it("tls.connect, pinned elsewhere, is refused", async () => {
    const said = await ending(tls.connect({
      host: "localhost", port: 9, servername: "mail.example.test", lookup: pinnedLookup([ELSEWHERE]),
    }));
    expect(said).toMatch(BLOCKED);
  });

  it("an HTTP request, pinned elsewhere, is refused", async () => {
    const said = await new Promise<string>((resolve) => {
      const req = http.request({ host: "localhost", port: 9, path: "/", lookup: pinnedLookup([ELSEWHERE]) });
      req.once("response", (r) => { r.resume(); resolve("answered"); });
      req.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
      req.end();
    });
    expect(said).toMatch(BLOCKED);
  });

  it("THE PRODUCT'S OWN HTTP PIN: a pinned request, which imports its client by name, is refused", async () => {
    // The push wake, the image proxy and one-click unsubscribe all leave through this door.
    const said = await pinnedHttpRequest("http://localhost:9/", { pin: [ELSEWHERE] })
      .then(() => "answered", (e: NodeJS.ErrnoException) => e.code ?? e.message);
    expect(said, "a named import of the client went round the guard").toMatch(BLOCKED);
  });
});

/**
 * A RESOLVER QUERY IS AN EGRESS, whatever name it asks about. Every query surface is asked here with
 * the resolvers pointed at a loopback port nothing serves, so a query the guard lets through reaches
 * no nameserver and reads the resolver's own code; a refused one reads the guard's.
 */
describe("a resolver query is refused before it leaves", () => {
  const LOOPBACK_ONLY = ["127.0.0.1:9"];
  const said = (e: unknown): string => String((e as NodeJS.ErrnoException).code ?? (e as Error).message);
  let restore: Array<() => void> = [];
  afterEach(() => { for (const r of restore.splice(0)) r(); });
  const pointAtLoopback = (): void => {
    const plain = dns.getServers();
    const promised = dns.promises.getServers();
    dns.setServers(LOOPBACK_ONLY);
    dns.promises.setServers(LOOPBACK_ONLY);
    restore.push(() => { dns.setServers(plain); dns.promises.setServers(promised); });
  };

  it("a Resolver instance, as nodemailer asks one", async () => {
    const resolver = new dns.Resolver({ timeout: 200, tries: 1 });
    resolver.setServers(LOOPBACK_ONLY);
    const got = await new Promise<string>((res) => resolver.resolve4("mail.example.test", (e) => res(e ? said(e) : "answered")));
    expect(got, "the query reached a nameserver").toMatch(BLOCKED);
  });

  it("a function imported by name, which is a snapshot of the module", async () => {
    pointAtLoopback();
    const got = await new Promise<string>((res) => namedResolve4("mail.example.test", (e) => res(e ? said(e) : "answered")));
    expect(got, "a named import of the resolver went round the guard").toMatch(BLOCKED);
  });

  it("the module's own functions, which are bound copies", async () => {
    pointAtLoopback();
    const got = await new Promise<string>((res) => dns.resolveTxt("mail.example.test", (e) => res(e ? said(e) : "answered")));
    expect(got).toMatch(BLOCKED);
  });

  it("the promise API, module and Resolver", async () => {
    pointAtLoopback();
    expect(await dns.promises.resolve6("mail.example.test").then(() => "answered", said)).toMatch(BLOCKED);
    const resolver = new dns.promises.Resolver({ timeout: 200, tries: 1 });
    resolver.setServers(LOOPBACK_ONLY);
    expect(await resolver.resolveCname("mail.example.test").then(() => "answered", said)).toMatch(BLOCKED);
  });

  it("CONTROL: the operating system's lookup of this machine still answers", async () => {
    const got = await new Promise<string>((res) => dns.lookup("localhost", (e, a) => res(e ? said(e) : String(a))));
    expect(["127.0.0.1", "::1"]).toContain(got);
  });
});

describe("CONTROLS: what the guard must still admit, and what it already refused", () => {
  it("a dial pinned to this machine still connects", async () => {
    const port = await listener();
    expect(await ending(net.connect({ host: "localhost", port, lookup: pinnedLookup(["127.0.0.1"]) }))).toBe("connected");
    expect(await ending(new net.Socket().connect({ host: "localhost", port, lookup: pinnedLookup(["127.0.0.1"]) }))).toBe("connected");
  });

  it("a loopback dial with no lookup still connects", async () => {
    const port = await listener();
    expect(await ending(net.connect({ host: "127.0.0.1", port }))).toBe("connected");
  });

  it("a name that is not this machine is refused by its name, as before", () => {
    expect(() => net.connect({ host: "mail.example.invalid", port: 9 })).toThrow(BLOCKED);
  });

  it("a NAME that begins 127. is a name, refused before any resolver is asked", () => {
    // The OS lookup is stubbed for this case alone, so a guard that admitted the name asks nothing real.
    const asked: string[] = [];
    const real = dns.lookup;
    dns.lookup = function stub(h: string, ...rest: unknown[]) {
      asked.push(h);
      const cb = rest.find((a) => typeof a === "function") as ((e: Error) => void) | undefined;
      queueMicrotask(() => cb?.(Object.assign(new Error("not here"), { code: "ENOTFOUND" })));
    } as typeof dns.lookup;
    let threw: unknown = null;
    let sock: net.Socket | null = null;
    try { sock = net.connect({ host: "127.anything.example", port: 9 }); } catch (e) { threw = e; } finally { dns.lookup = real; }
    sock?.on("error", () => {});
    sock?.destroy();
    expect(String((threw as Error | null)?.message ?? ""), "a name beginning 127. passed for this machine").toMatch(BLOCKED);
    expect(asked, "the name reached a resolver").toEqual([]);
  });

  it("a reverse lookup is refused before Node does anything with it", async () => {
    // Port 70000 is one Node itself rejects: a real lookupService fails validation here, locally,
    // so only a trap that answers first reads BLOCKED, and nothing reaches the system resolver.
    const got = await new Promise<string>((res) => {
      try { dns.lookupService("192.0.2.1", 70000, (e) => res(e ? e.message : "answered")); } catch (e) { res((e as Error).message); }
    });
    expect(got).toMatch(BLOCKED);
    const p = await Promise.resolve().then(() => dns.promises.lookupService("192.0.2.1", 70000)).then(() => "answered", (e: Error) => e.message);
    expect(p).toMatch(BLOCKED);
  });
});
