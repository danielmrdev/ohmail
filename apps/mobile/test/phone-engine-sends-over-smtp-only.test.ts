/**
 * nodemailer requires its pool, sendmail, stream, JSON and SES transports and its DKIM signer at
 * load; the phone's engine builds one SMTP transport and never signs, so the alias table swaps the
 * six for refusal shims (`PACKAGE_MODULE_SUBSTITUTES`). This reads them out of the artifact's
 * graph, holds the table's rows to the package's own files, and drives a probe bundle under the
 * same table: each shim refuses by its sentence, and a transport built from the engine's own
 * `smtpTransportOptions` still delivers a message.
 */
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type AddressInfo, type Server } from "node:net";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import aliases from "../../sidecar/src/phone/aliases.js";
import { REPO, buildPhoneEngine, bundleProbe } from "../scripts/bundle-engine.mjs";

const require_ = createRequire(import.meta.url);
const LEFT_OUT = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?nodemailer\/lib\/(smtp-pool|sendmail-transport|stream-transport|json-transport|ses-transport|dkim)\//;
const SHIM = /shims\/nodemailer-[a-z-]+\.js$/;
const SHIMS = [
  "dkim", "json-transport", "refused", "sendmail-transport", "ses-transport", "smtp-pool", "stream-transport",
].map((n) => `apps/mobile/src/engine/shims/nodemailer-${n}.js`);
/** The nodemailer the engine sends with: the one the IMAP adapter's package resolves. */
const NODEMAILER_ENTRY = createRequire(join(REPO, "packages", "core", "package.json")).resolve("nodemailer");
const NODEMAILER_ROOT = dirname(dirname(NODEMAILER_ENTRY));
/** The adapter whose option builder the phone's one transport is made from. */
const IMAP = join(REPO, "packages", "core", "src", "adapters", "imap.ts");

describe("the artifact carries none of the six", () => {
  it("no unused transport or DKIM module is an input of the phone engine, every shim is, and their importers stay", async () => {
    const { inputs } = await buildPhoneEngine({ write: false });
    expect(inputs.filter((p: string) => LEFT_OUT.test(p))).toEqual([]);
    expect(inputs.filter((p: string) => SHIM.test(p)).sort()).toEqual(SHIMS);
    expect(inputs.some((p: string) => /nodemailer\/lib\/nodemailer\.js$/.test(p))).toBe(true);
    expect(inputs.some((p: string) => /nodemailer\/lib\/smtp-transport\/index\.js$/.test(p))).toBe(true);
  });

  it("every nodemailer row names a require the package's own file makes, and a shim that exists", () => {
    // Rows of other packages are held to their own files by their own tests.
    const rows = Object.entries(aliases.PACKAGE_MODULE_SUBSTITUTES).filter(([importer]) => importer.startsWith("nodemailer/"));
    expect(rows.length).toBeGreaterThan(0);
    for (const [importer, table] of rows) {
      const source = readFileSync(join(NODEMAILER_ROOT, importer.replace(/^nodemailer\//, "")), "utf8");
      for (const [specifier, target] of Object.entries(table)) {
        expect(source, `${importer} requires ${specifier}`).toContain(`require('${specifier}')`);
        expect(() => readFileSync(target), target).not.toThrow();
      }
    }
  });
});

type Transport = { sendMail(mail: Record<string, unknown>): Promise<{ accepted: string[] }>; close(): void; transporter: { name: string } };
type Probe = {
  createTransport: (options: Record<string, unknown>) => Transport;
  smtpTransportOptions: (config: Record<string, unknown>) => Record<string, unknown>;
};

describe("on a bundle built under the same table", () => {
  let dir = "";
  let phone: Probe;
  let probeInputs: string[] = [];
  beforeAll(async () => {
    const probe = await bundleProbe(
      `import nodemailer from ${JSON.stringify(NODEMAILER_ENTRY)};\n`
      + `export { smtpTransportOptions } from ${JSON.stringify(IMAP)};\n`
      + "export const createTransport = (o: object) => nodemailer.createTransport(o);\n",
    );
    dir = probe.dir;
    probeInputs = Object.keys((probe.metafile as { inputs: Record<string, unknown> }).inputs);
    // The platform's socket module is native; Node's sockets answer for it, as in the dial tests.
    const Module = require_("node:module") as { _load(req: string, parent: unknown, isMain: boolean): unknown };
    const original = Module._load;
    Module._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
      if (request === "react-native-tcp-socket") {
        const net = require_("node:net") as Record<string, unknown>;
        const tls = require_("node:tls") as Record<string, unknown>;
        return { createConnection: net.createConnection, connectTLS: tls.connect, TLSSocket: tls.TLSSocket,
                 isIP: net.isIP, isIPv4: net.isIPv4, isIPv6: net.isIPv6 };
      }
      return request === "react-native-quick-crypto" ? require_("node:crypto") : original.call(this, request, parent, isMain);
    };
    try {
      phone = require_(probe.bundlePath) as Probe;
    } finally { Module._load = original; }
  }, 120_000);
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("the probe is built under the same table", () => {
    expect(probeInputs.filter((p) => LEFT_OUT.test(p))).toEqual([]);
    expect(probeInputs.filter((p) => SHIM.test(p)).sort()).toEqual(SHIMS);
  });

  it("each transport nothing here asks for, and a DKIM option, refuses with its own sentence", () => {
    const host = { host: "127.0.0.1", port: 2525 };
    expect(() => phone.createTransport({ ...host, pool: true })).toThrow(/^Pooled SMTP connections are not available in this app/);
    expect(() => phone.createTransport({ sendmail: true })).toThrow(/^Sending through a sendmail program is not available/);
    expect(() => phone.createTransport({ streamTransport: true })).toThrow(/^The stream transport is not available/);
    expect(() => phone.createTransport({ jsonTransport: true })).toThrow(/^The JSON transport is not available/);
    expect(() => phone.createTransport({ SES: {} })).toThrow(/^Sending through Amazon SES is not available/);
    expect(() => phone.createTransport({ ...host, dkim: { domainName: "example.test", keySelector: "s", privateKey: "k" } }))
      .toThrow(/^DKIM signing is not available in this app\.$/);
  });

  it("the SMTP transport built from the engine's own options still delivers a message", async () => {
    const received: string[] = [];
    const server: Server = createServer((socket) => {
      let data = false;
      let buf = "";
      socket.write("220 probe ESMTP\r\n");
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let at: number;
        while ((at = buf.indexOf("\r\n")) !== -1) {
          const line = buf.slice(0, at);
          buf = buf.slice(at + 2);
          if (data) {
            if (line === ".") { data = false; socket.write("250 queued\r\n"); } else received.push(line);
          } else if (/^EHLO/i.test(line)) socket.write("250-probe\r\n250 8BITMIME\r\n");
          else if (/^DATA/i.test(line)) { data = true; socket.write("354 go\r\n"); }
          else if (/^QUIT/i.test(line)) { socket.end("221 bye\r\n"); }
          else socket.write("250 ok\r\n");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      // The engine's own builder, so an option it gains (a pool, a DKIM key) reaches this transport.
      const options = phone.smtpTransportOptions({
        host: "127.0.0.1", port: 993, secure: true, auth: { user: "u", pass: "p" },
        smtp: { host: "127.0.0.1", port: (server.address() as AddressInfo).port, secure: false },
      });
      const transport = phone.createTransport(options);
      expect(transport.transporter.name).toBe("SMTP");
      const info = await transport.sendMail({ from: "a@example.test", to: "b@example.test", subject: "probe", text: "the body line" });
      transport.close();
      expect(info.accepted).toEqual(["b@example.test"]);
      expect(received).toContain("the body line");
      expect(received).toContain("Subject: probe");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
