import dns from "node:dns";
import net from "node:net";

/**
 * A mail server with no TLS, and the name that reaches it. The fakes keep every line they
 * received in memory and answer only by count or by a yes/no on a verb: a LOGIN or AUTH line
 * carries the fixture password, so no helper here returns or prints a line.
 */
export interface PlainServer {
  port: number;
  /** Connections accepted, whatever was said on them. */
  connections: () => number;
  /** Did a line with this verb arrive? `LOGIN` for IMAP, `AUTH` for SMTP. */
  saw: (verb: "LOGIN" | "AUTH") => boolean;
  close: () => Promise<void>;
}

function serve(onLine: (line: string, write: (s: string) => void) => void, greeting: string): Promise<PlainServer> {
  const lines: string[] = [];
  const live = new Set<net.Socket>();
  let accepted = 0;
  const srv = net.createServer((sock) => {
    accepted += 1;
    live.add(sock);
    sock.on("error", () => { /* a client that hangs up is the normal ending here */ });
    sock.on("close", () => live.delete(sock));
    const write = (s: string): void => { if (!sock.destroyed) sock.write(s); };
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        lines.push(line);
        onLine(line, write);
      }
    });
    write(greeting);
  });
  const verbAt = (verb: string) => (l: string): boolean =>
    verb === "AUTH" ? /^AUTH\b/i.test(l) : new RegExp(`^\\S+ ${verb}\\b`, "i").test(l);
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({
      port: (srv.address() as net.AddressInfo).port,
      connections: () => accepted,
      saw: (verb) => lines.some(verbAt(verb)),
      close: () => new Promise<void>((res) => { for (const s of live) s.destroy(); srv.close(() => res()); }),
    }));
  });
}

/** IMAP with no STARTTLS. `acceptLogin` completes a session; otherwise LOGIN is answered NO. */
export function plainImap(o: { acceptLogin?: boolean } = {}): Promise<PlainServer> {
  return serve((line, write) => {
    const [tag, cmd, ...args] = line.split(" ");
    const c = (cmd ?? "").toUpperCase();
    if (c === "CAPABILITY") write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
    else if (c === "LOGIN") write(o.acceptLogin ? `${tag} OK logged in\r\n` : `${tag} NO refused\r\n`);
    else if (c === "LIST" && args.join(" ") === `"" ""`) write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK done\r\n`);
    else if (c === "LIST") write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK done\r\n`);
    else if (c === "LSUB") write(`* LSUB (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK done\r\n`);
    else if (c === "LOGOUT") write(`* BYE\r\n${tag} OK\r\n`);
    else write(`${tag} BAD unsupported\r\n`);
  }, "* OK [CAPABILITY IMAP4rev1] plain imap ready\r\n");
}

/** SMTP with no STARTTLS that offers AUTH (so a client sends it) and refuses every password. */
export function plainSmtp(): Promise<PlainServer> {
  return serve((line, write) => {
    const c = line.toUpperCase();
    if (c.startsWith("EHLO")) write("250-plain greets you\r\n250 AUTH PLAIN LOGIN\r\n");
    else if (c.startsWith("HELO")) write("250 plain\r\n");
    else if (c.startsWith("AUTH")) write("535 refused\r\n");
    else if (c.startsWith("QUIT")) write("221 bye\r\n");
    else write("500 unsupported\r\n");
  }, "220 plain ESMTP ready\r\n");
}

/**
 * THE NAME A MAILBOX IS STORED UNDER. The suite's egress guard admits it and the TLS floor does
 * not exempt it (it is not `localhost`, `*.localhost` or a loopback literal), so a dial to it is
 * a real consent-branch dial that can still reach a listener on this machine. The published
 * `apps/desktop/test/first-run-door-refusal.imap.test.tsx` keeps its own copy of this name and of
 * {@link osAnswers}, because this file is not published: change both.
 */
export const HOME_NAME = "ip6-localhost";

/**
 * What the OPERATING SYSTEM answers for {@link HOME_NAME} until `restore`: an address, or `null`
 * for "does not resolve". `0.0.0.0` is not a private address to the rule and a connect to it
 * reaches a listener on 127.0.0.1, so it stands for "the name now points somewhere public".
 * `address` is the socket's own lookup (`dns.lookup`, and the `Resolver` queries nodemailer asks
 * first); `resolved` is `dns.promises.lookup`, which the node resolver asks — apart, so a dial
 * that reaches its server with the socket's lookup dead was carried by a pin.
 */
export function osAnswers(address: string | null, resolved: string | null = address): () => void {
  const lookup = dns.lookup;
  const promised = dns.promises.lookup;
  const r4 = dns.Resolver.prototype.resolve4;
  const r6 = dns.Resolver.prototype.resolve6;
  const notFound = (): NodeJS.ErrnoException => Object.assign(new Error(`${HOME_NAME} did not resolve`), { code: "ENOTFOUND" });
  const family = (a: string): number => (a.includes(":") ? 6 : 4);
  dns.lookup = function stub(host: string, ...rest: unknown[]) {
    if (host !== HOME_NAME) return (lookup as (...a: unknown[]) => unknown).call(dns, host, ...rest);
    const cb = rest.find((a) => typeof a === "function") as (e: unknown, a?: unknown, f?: number) => void;
    const opts = (typeof rest[0] === "object" && rest[0] !== null ? rest[0] : {}) as { all?: boolean };
    queueMicrotask(() => {
      if (address === null) cb(notFound());
      else if (opts.all) cb(null, [{ address, family: family(address) }]);
      else cb(null, address, family(address));
    });
  } as typeof dns.lookup;
  dns.promises.lookup = async function stub(host: string, ...rest: unknown[]) {
    if (host !== HOME_NAME) return (promised as (...a: unknown[]) => Promise<unknown>).call(dns.promises, host, ...rest);
    if (resolved === null) throw notFound();
    const opts = (rest[0] ?? {}) as { all?: boolean };
    return opts.all ? [{ address: resolved, family: family(resolved) }] : { address: resolved, family: family(resolved) };
  } as typeof dns.promises.lookup;
  const none = function (this: unknown, _h: string, cb: (e: unknown) => void) {
    queueMicrotask(() => cb(Object.assign(new Error("no record"), { code: dns.NOTFOUND })));
  };
  dns.Resolver.prototype.resolve4 = none as typeof r4;
  dns.Resolver.prototype.resolve6 = none as typeof r6;
  return () => {
    dns.lookup = lookup;
    dns.promises.lookup = promised;
    dns.Resolver.prototype.resolve4 = r4;
    dns.Resolver.prototype.resolve6 = r6;
  };
}

/** The resolver the deployment asks at the dial: a fixed answer for {@link HOME_NAME}. */
export function resolverAnswering(addresses: readonly string[]): { resolve: (host: string) => Promise<string[]>; asked: () => number } {
  let asked = 0;
  return {
    asked: () => asked,
    resolve: async (host: string) => {
      asked += 1;
      if (host !== HOME_NAME) throw new Error(`the test resolves only ${HOME_NAME}`);
      return [...addresses];
    },
  };
}
