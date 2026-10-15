/**
 * THE MAIL CLIENT RESOLVES BEFORE IT DIALS — measured on the REAL installed client, not read.
 * The shim refused every member on the premise that nothing on the send path asks for a name.
 * An Android emulator refuted it: Send and Reply both died with `dns.resolve4() is not
 * available in this app`, thrown out of `SMTPConnection.connect`. So the subject here is
 * nodemailer's own `shared/index.js` and `smtp-connection/index.js` from `packages/core`, driven
 * with `dns`, `os`, `net` and `tls` replaced exactly where the bundle replaces them. The last
 * arm is the defect itself, throwing SYNCHRONOUSLY, which is why a phone died rather than
 * showing a failed send.
 */
import { createRequire } from "node:module";
import Module from "node:module";
import { createServer, isIP, type Server } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CORE = join(REPO, "packages", "core");

/** The bundle's own alias targets, loaded as the bundle loads them (CommonJS). */
const SHIM_DNS = join(REPO, "apps", "mobile", "src", "engine", "shims", "dns.js");
const SHIM_OS = join(REPO, "apps", "mobile", "src", "engine", "shims", "node-os.js");

/** `dns.js` as it stood when a phone died on Send — the message is quoted from the device log. */
const PRE_FIX_DNS = {
  resolve4: () => {
    throw new Error("dns.resolve4() is not available in this app.");
  },
  resolve6: () => {
    throw new Error("dns.resolve6() is not available in this app.");
  },
  lookup: () => {
    throw new Error("dns.lookup() is not available in this app.");
  },
};

interface Dialled { host: unknown; servername: unknown; port: unknown }

/**
 * Load nodemailer's SMTP client with the phone's module table in front of it. Scoped to
 * nodemailer's own files by the requiring parent, so the test's own `node:net` server is real.
 */
function loadClient(dnsModule: unknown): {
  SMTPConnection: new (o: unknown) => {
    connect: (cb: () => void) => void; close: () => void;
    once: (e: string, h: (x?: unknown) => void) => void;
  };
  shared: { dnsCache: Map<string, unknown> };
  dialled: Dialled[];
  tlsDialled: Dialled[];
  restore: () => void;
} {
  const realNet = require_("node:net") as Record<string, unknown>;
  const realTls = require_("node:tls") as Record<string, unknown>;
  const dialled: Dialled[] = [];
  const tlsDialled: Dialled[] = [];

  const netStub = {
    ...realNet,
    connect: (opts: Dialled, cb: () => void) => {
      dialled.push({ host: opts.host, servername: opts.servername, port: opts.port });
      return (realNet.connect as (o: unknown, c: () => void) => unknown)(opts, cb);
    },
  };
  /* The TLS arm records and REFUSES rather than dialling: `connect()` wraps `tls.connect` in a
     try/catch, so the throw is the client's own error path and the recorded options are the
     question — is the dial by name, and does SNI still carry it. */
  const tlsStub = {
    ...realTls,
    connect: (opts: Dialled) => {
      tlsDialled.push({ host: opts.host, servername: opts.servername, port: opts.port });
      throw new Error("the TLS arm is recorded, not dialled");
    },
  };

  const table: Record<string, unknown> = {
    dns: dnsModule, "node:dns": dnsModule, "dns/promises": dnsModule,
    os: require_(SHIM_OS), "node:os": require_(SHIM_OS),
    net: netStub, "node:net": netStub,
    tls: tlsStub, "node:tls": tlsStub,
  };

  for (const key of Object.keys(require_.cache)) {
    if (key.includes(`${"nodemailer"}/lib/`)) delete require_.cache[key];
  }

  const loader = Module as unknown as {
    _load: (r: string, p: { filename?: string } | undefined, m: boolean) => unknown;
  };
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    const from = parent?.filename ?? "";
    if (from.includes(`${"nodemailer"}/lib/`) && Object.hasOwn(table, request)) {
      return table[request];
    }
    return original.call(this, request, parent, isMain);
  };

  const paths = [CORE];
  const SMTPConnection = require_(
    require_.resolve("nodemailer/lib/smtp-connection/index.js", { paths }),
  ) as never;
  const shared = require_(
    require_.resolve("nodemailer/lib/shared/index.js", { paths }),
  ) as { dnsCache: Map<string, unknown> };

  return {
    SMTPConnection, shared, dialled, tlsDialled,
    restore: () => { loader._load = original; },
  };
}

/** A listener that answers a greeting and an EHLO — enough for `connect()` to finish. */
function smtpListener(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    socket.write("220 fixture ESMTP\r\n");
    socket.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8");
      if (/^(EHLO|HELO)/i.test(line)) socket.write("250-fixture\r\n250 8BITMIME\r\n");
      else if (/^QUIT/i.test(line)) { socket.write("221 Bye\r\n"); socket.end(); }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

let live: { restore: () => void } | null = null;
let listening: Server | null = null;
afterEach(() => {
  live?.restore();
  live = null;
  listening?.close();
  listening = null;
});

describe("the phone's dns shim and the mail client's pre-dial lookup", () => {
  it("connects by NAME through the shipped shim, and the socket layer is handed the hostname", async () => {
    const shim = require_(SHIM_DNS) as Record<string, unknown>;
    let asked = 0;
    const counted = {
      ...shim,
      resolve4: (...args: unknown[]) => {
        asked += 1;
        return (shim.resolve4 as (...a: unknown[]) => unknown)(...args);
      },
    };
    const client = loadClient(counted);
    live = client;
    client.shared.dnsCache.clear();

    const { server, port } = await smtpListener();
    listening = server;

    const connection = new client.SMTPConnection({
      host: "localhost", port, secure: false, ignoreTLS: true, logger: false,
    });
    await new Promise<void>((resolve, reject) => {
      connection.once("error", (e) => reject(e as Error));
      connection.connect(() => resolve());
    });
    connection.close();

    // The shim was the resolver — not the family short-circuit, not a cache entry.
    expect(asked).toBe(1);
    expect(client.dialled).toHaveLength(1);
    // A NAME reached the socket layer: `isIP` reads 0 for anything that is not an address.
    expect(client.dialled[0]!.host).toBe("localhost");
    expect(isIP(String(client.dialled[0]!.host))).toBe(0);
    expect(client.dialled[0]!.servername).toBe("localhost");
  });

  it("keeps SNI on the hostname when the dial is TLS", async () => {
    const client = loadClient(require_(SHIM_DNS));
    live = client;
    client.shared.dnsCache.clear();

    const connection = new client.SMTPConnection({
      host: "mail.fixture.test", port: 465, secure: true, logger: false,
    });
    await new Promise<void>((resolve) => {
      connection.once("error", () => resolve());
      connection.connect(() => resolve());
    });

    expect(client.tlsDialled).toHaveLength(1);
    expect(client.tlsDialled[0]!.host).toBe("mail.fixture.test");
    expect(client.tlsDialled[0]!.servername).toBe("mail.fixture.test");
  });

  it("leaves an address alone — the shim is never consulted for an IP", async () => {
    const shim = require_(SHIM_DNS) as Record<string, unknown>;
    let asked = 0;
    const counted = { ...shim, resolve4: () => { asked += 1; throw new Error("asked for an IP"); } };
    const client = loadClient(counted);
    live = client;
    client.shared.dnsCache.clear();

    const { server, port } = await smtpListener();
    listening = server;

    const connection = new client.SMTPConnection({
      host: "127.0.0.1", port, secure: false, ignoreTLS: true, logger: false,
    });
    await new Promise<void>((resolve, reject) => {
      connection.once("error", (e) => reject(e as Error));
      connection.connect(() => resolve());
    });
    connection.close();

    expect(asked).toBe(0);
    expect(client.dialled[0]!.host).toBe("127.0.0.1");
  });

  it("THE DEFECT: a refusing resolve4 throws out of connect() synchronously, before any socket", () => {
    const client = loadClient(PRE_FIX_DNS);
    live = client;
    // Without this the green arm's entry answers and the refusal is never reached.
    client.shared.dnsCache.clear();
    expect(client.shared.dnsCache.size).toBe(0);

    const connection = new client.SMTPConnection({
      host: "localhost", port: 2525, secure: false, ignoreTLS: true, logger: false,
    });
    expect(() => connection.connect(() => undefined)).toThrow(
      /dns\.resolve4\(\) is not available in this app/,
    );
    expect(client.dialled).toHaveLength(0);
  });
});
