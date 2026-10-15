/**
 * The "Testing bar" invariant, enforced for the WHOLE suite instead of asserted per file.
 *
 * Two mail test files each installed their own `globalThis.fetch` trap, which proved
 * something narrow: that *those* files performed no request. It did not prove the
 * property the goal states. `new ResendMailer({…})` defaulted `http` to the real
 * `nodeHttpPost`, so a single future route test constructing one from
 * `process.env.RESEND_API_KEY` would have sent a real email to a real person, from a
 * green test run, and nothing in the repository would have noticed.
 *
 * This file is loaded as a vitest `setupFiles` entry, so it runs in every worker before
 * every test file, and it blocks egress at the primitives rather than at one façade:
 *
 *   · `net.Socket.prototype.connect`, `net.connect`, `net.createConnection`
 *   · `tls.connect`
 *   · `dns.lookup`, `dns.promises.lookup`
 *   · `http.request`/`get`, `https.request`/`get`
 *   · `globalThis.fetch`
 *
 * **Loopback is allowed**, and has to be: the `*.pg.test.ts` files talk to a local
 * docker Postgres over `127.0.0.1`, and the worker's health-server test fetches its own
 * listener. Unix-domain sockets are allowed for the same reason (a socket path is not
 * an egress). Everything else throws `EXTERNAL_NETWORK_BLOCKED` with the destination in
 * the message, so a violation names itself instead of hanging until a timeout.
 *
 * If a test legitimately needs a remote host, the answer is an injected transport — the
 * pattern every port in `packages/services` already uses — not an exception here.
 */
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { networkInterfaces } from "node:os";
import { syncBuiltinESMExports } from "node:module";

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "", "ip6-localhost"]);

/**
 * THIS MACHINE'S OWN interface addresses, read once. A bind to — or a connect to — an address
 * assigned to one of this host's own interfaces terminates on this host by definition, so it is
 * not an egress and the property this file enforces ("zero external requests") is untouched by
 * allowing it. The consumer that needed this named: the sidecar's LAN-door tests
 * (`apps/sidecar/test/host-lan.e2e.test.ts`) bind the machine's own LAN interface to prove the
 * chosen-address bind is real and is NOT a loopback or wildcard bind — a property a loopback
 * bind cannot demonstrate about itself.
 */
const SELF_ADDRESSES: ReadonlySet<string> = new Set(
  Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .map((iface) => iface.address.toLowerCase()),
);

function isLoopbackHost(host: unknown): boolean {
  if (typeof host !== "string") return true;          // no host ⇒ not an egress we can judge
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (LOOPBACK_NAMES.has(h)) return true;
  if (net.isIPv4(h) && h.startsWith("127.")) return true;   // the 127/8 block, as an ADDRESS: "127.x.example" is a name
  if (SELF_ADDRESSES.has(h)) return true;             // this machine's own interfaces — see above
  return false;
}

function blocked(where: string, target: string): Error {
  return new Error(
    `EXTERNAL_NETWORK_BLOCKED: ${where} → ${target}. The test suite performs zero external ` +
    `requests. Inject a transport double instead — see MailerPort/HttpPost, ` +
    `RemoteFetch in privacy-service, or OpenSendAdapter in send-service.`,
  );
}

/** Pull a host out of the many shapes node's net/http APIs accept. */
function hostOf(args: unknown[]): { host: string; loopback: boolean } {
  const first = args[0];
  // connect(path) / connect(port, host?) / connect(options)
  if (typeof first === "number") {
    const second = args[1];
    const host = typeof second === "string" ? second : "localhost";
    return { host, loopback: isLoopbackHost(host) };
  }
  if (typeof first === "string") {
    // A bare string is either a URL (http.request) or a unix socket path (net.connect).
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(first)) {
      try {
        const u = new URL(first);
        return { host: u.host, loopback: isLoopbackHost(u.hostname) };
      } catch { /* fall through */ }
    }
    return { host: first, loopback: true };           // socket path — not an egress
  }
  if (first && typeof first === "object") {
    const o = first as Record<string, unknown>;
    if (typeof o.path === "string" && !o.host && !o.hostname && !o.port) {
      return { host: o.path, loopback: true };        // IPC socket
    }
    if (o instanceof URL) return { host: o.host, loopback: isLoopbackHost(o.hostname) };
    const host = (o.host ?? o.hostname ?? "localhost") as string;
    return { host: String(host), loopback: isLoopbackHost(host) };
  }
  return { host: "unknown", loopback: false };
}

const JUDGED = Symbol("a lookup the egress guard already judges");

/** The addresses a lookup answered, in either of the two shapes `net` asks for. */
function answeredAddresses(address: unknown): string[] {
  if (typeof address === "string") return [address];
  if (!Array.isArray(address)) return [];
  return address.map((a) => (typeof a === "string" ? a : String((a as { address?: unknown } | null)?.address)));
}

/**
 * A CALLER'S `lookup`, JUDGED BY WHAT IT ANSWERS. A dial pinned under an admitted name reaches
 * whatever the lookup returns, so the name alone said nothing. An address that is not this machine
 * is refused in a microtask, never inside the call: a refusal there destroys a TLS socket's handle
 * before `tls.connect` reads it. An admitted answer keeps the lookup's own timing, so the suite
 * still measures how the product's pin answers.
 */
function judgedLookup(lookup: (...a: unknown[]) => unknown): (...a: unknown[]) => unknown {
  const judged = function (this: unknown, hostname: unknown, options: unknown, callback?: unknown): unknown {
    const twoArgs = typeof options === "function";
    const cb = (twoArgs ? options : callback) as (err: unknown, address?: unknown, family?: unknown) => void;
    const answer = (err: unknown, address?: unknown, family?: unknown): void => {
      const outside = err ? undefined : answeredAddresses(address).find((a) => !isLoopbackHost(a));
      if (outside === undefined) { cb(err, address, family); return; }
      queueMicrotask(() => cb(blocked("lookup", outside)));
    };
    return twoArgs ? lookup.call(this, hostname, answer) : lookup.call(this, hostname, options, answer);
  };
  (judged as unknown as Record<symbol, true>)[JUDGED] = true;
  return judged;
}

/** Every options bag in a call that carries a `lookup`, COPIED with that lookup judged. */
function withJudgedLookups(args: unknown[]): unknown[] {
  return args.map((a) => {
    if (!a || typeof a !== "object" || Array.isArray(a) || a instanceof URL) return a;
    const lookup = (a as { lookup?: unknown }).lookup;
    if (typeof lookup !== "function" || (lookup as unknown as Record<symbol, unknown>)[JUDGED]) return a;
    return { ...(a as object), lookup: judgedLookup(lookup as (...x: unknown[]) => unknown) };
  });
}

function guard<T>(where: string, fn: T): T {
  return function guarded(this: unknown, ...args: unknown[]) {
    const { host, loopback } = hostOf(args);
    if (!loopback) throw blocked(where, host);
    return (fn as unknown as (...a: unknown[]) => unknown).apply(this, withJudgedLookups(args));
  } as unknown as T;
}

net.Socket.prototype.connect = guard("net.Socket.connect", net.Socket.prototype.connect);
net.connect = guard("net.connect", net.connect);
net.createConnection = guard("net.createConnection", net.createConnection);
tls.connect = guard("tls.connect", tls.connect);
http.request = guard("http.request", http.request);
http.get = guard("http.get", http.get);
https.request = guard("https.request", https.request);
https.get = guard("https.get", https.get);

// `dns.lookup` is the layer a resolver-based client hits before any socket exists, and
// blocking it turns "we tried to reach the internet" into an error at the earliest
// possible point. The promises variant is a separate function object.
const realLookup = dns.lookup;
dns.lookup = function lookup(this: unknown, hostname: string, ...rest: unknown[]) {
  if (!isLoopbackHost(hostname)) {
    const cb = rest.find((a) => typeof a === "function") as
      | ((e: Error) => void) | undefined;
    if (cb) return cb(blocked("dns.lookup", hostname));
    throw blocked("dns.lookup", hostname);
  }
  return (realLookup as (...a: unknown[]) => unknown).call(this, hostname, ...rest);
} as typeof dns.lookup;

const realLookupAsync = dns.promises.lookup;
dns.promises.lookup = async function lookup(this: unknown, hostname: string, ...rest: unknown[]) {
  if (!isLoopbackHost(hostname)) throw blocked("dns.promises.lookup", hostname);
  return (realLookupAsync as (...a: unknown[]) => unknown).call(this, hostname, ...rest);
} as typeof dns.promises.lookup;

/**
 * A RESOLVER QUERY IS AN EGRESS, whatever name it asks about: it goes to the configured nameserver,
 * not to this machine's hosts file, and nodemailer sends one for every name it dials. Every query
 * surface is trapped; the module's functions are bound copies, so they are trapped apart from the
 * prototypes. A test that needs an answer injects a resolver.
 */
const RESOLVER_VERBS = [
  "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr",
  "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTlsa", "resolveTxt", "reverse",
] as const;
const callbackQuery = (verb: string) => function trapped(this: unknown, name: unknown, ...rest: unknown[]): void {
  const cb = rest.find((a) => typeof a === "function") as ((e: Error) => void) | undefined;
  const err = blocked(`dns.${verb}`, String(name));
  if (!cb) throw err;
  queueMicrotask(() => cb(err));
};
const promiseQuery = (verb: string) => async function trapped(name: unknown): Promise<never> {
  throw blocked(`dns.promises.${verb}`, String(name));
};
for (const verb of RESOLVER_VERBS) {
  const trap = (o: object, make: (v: string) => unknown): void => {
    const bag = o as Record<string, unknown>;
    if (typeof bag[verb] === "function") bag[verb] = make(verb);
  };
  trap(dns, callbackQuery);
  trap(dns.Resolver.prototype, callbackQuery);
  trap(dns.promises, promiseQuery);
  trap(dns.promises.Resolver.prototype, promiseQuery);
}
// A reverse lookup asks the system resolver too. Nothing in the product uses it; refused outright.
dns.lookupService = function lookupService(address: unknown, _port: unknown, cb?: unknown): void {
  const err = blocked("dns.lookupService", String(address));
  if (typeof cb !== "function") throw err;
  queueMicrotask(() => (cb as (e: Error) => void)(err));
} as typeof dns.lookupService;
dns.promises.lookupService = async function lookupService(address: unknown): Promise<never> {
  throw blocked("dns.promises.lookupService", String(address));
} as typeof dns.promises.lookupService;

// `fetch` is undici's own stack and does not go through node:http, so it needs its own
// trap. A test that installs its OWN fetch double (several do) replaces this one for the
// duration of that file, which is fine — the socket-level guards above still hold.
const realFetch = globalThis.fetch;
if (typeof realFetch === "function") {
  globalThis.fetch = function fetch(input: unknown, init?: unknown) {
    const target = input instanceof Request ? input.url : String(input);
    let loopback = false;
    try { loopback = isLoopbackHost(new URL(target).hostname); } catch { loopback = false; }
    if (!loopback) return Promise.reject(blocked("fetch", target));
    return (realFetch as (...a: unknown[]) => Promise<Response>)(input, init);
  } as typeof fetch;
}

/**
 * A NAMED IMPORT IS A SNAPSHOT of a builtin's exports, taken when its module wrapper is first made,
 * and this file's own imports make the `dns`, `net`, `tls` and `http` wrappers before the traps
 * above exist: `import { resolve4 } from "node:dns"` reached a nameserver from a guarded run. Node's
 * own call writes the patched functions into every wrapper.
 */
syncBuiltinESMExports();

/**
 * AND THE DEPLOYMENT POLICY THAT FOLLOWS FROM IT. Every mail server this suite talks to is a
 * loopback GreenMail, which is a LAN mail server — the self-hosted deployment by construction, and
 * the one the organizer's dial guard admits. Declared HERE, beside the rule it follows from, rather
 * than in each of the thirty-eight files that stand a worker up: the alternative is a strict
 * default asking `dns.promises.lookup` about a fixture hostname, which the trap above blocks by
 * design. A test that MEASURES the managed policy injects its own guard and its own resolver, so
 * this line cannot hide a refusal that matters. Never overwritten: a run that set it meant it.
 */
process.env.TF_PROBE_ALLOW_PRIVATE ??= "1";
