import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:net";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const SMTPConnection = require_("nodemailer/lib/smtp-connection") as new (o: object) => {
  connect(cb: () => void): void;
  on(e: string, cb: (err: Error) => void): void;
  close(): void;
};

/**
 * WHAT THE SERVER SENDS ALONGSIDE ITS STARTTLS GO-AHEAD MUST NOT CROSS INTO THE ENCRYPTED SESSION.
 *
 * A server has nothing to say between "go ahead" and the client's ClientHello, so anything else
 * arriving in that breath was written by somebody able to append to the cleartext stream.
 *
 * The mail-sending client parses in two stages, and the two stages carry such bytes differently:
 *
 *   - A COMPLETE extra response is left in `_responseQueue`. It is dispatched after the upgrade
 *     begins, finds no command waiting for it, and raises "Unexpected Response" — noisy, but the
 *     session does end. This half is about failing at the boundary instead of confusingly later.
 *
 *   - A PARTIAL line is kept in `_remainder`, and `_onData` prepends the remainder to the next
 *     chunk it parses — which, after the handshake, is the first response of the ENCRYPTED
 *     session. Nothing errors. The attacker's cleartext prefix is silently spliced onto the real
 *     server's reply, so the capability list the client believes (which AUTH mechanism to use,
 *     whether the peer claims to support what) is partly chosen by whoever wrote those bytes.
 *     This half is a real compromise and had no check at all.
 *
 * The IMAP client in this program already refuses on this condition. This is the same refusal for
 * the half that had none.
 */
type Mode = "partial-line" | "extra-response" | "clean";

function fakeServer(mode: Mode): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.write("220 fake ESMTP\r\n");
      socket.on("data", (chunk: string) => {
        if (chunk.startsWith("EHLO") || chunk.startsWith("HELO")) {
          socket.write("250-fake\r\n250 STARTTLS\r\n");
        } else if (chunk.startsWith("STARTTLS")) {
          // The go-ahead and the injected bytes in ONE write, which is what appending to the
          // cleartext stream produces on the wire.
          if (mode === "partial-line") socket.write("220 go ahead\r\n250-injected capabil");
          else if (mode === "extra-response") socket.write("220 go ahead\r\n250 injected\r\n");
          else socket.write("220 go ahead\r\n");
        } else if (chunk.startsWith("QUIT")) {
          socket.end("221 bye\r\n");
        }
      });
      socket.on("error", () => { /* the client closes abruptly on refusal */ });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

async function upgrade(mode: Mode): Promise<string> {
  const { server, port } = await fakeServer(mode);
  try {
    return await new Promise<string>((resolve) => {
      const c = new SMTPConnection({
        host: "127.0.0.1", port, secure: false, requireTLS: true,
        tls: { rejectUnauthorized: false }, connectionTimeout: 5000, greetingTimeout: 5000,
        socketTimeout: 5000, logger: false,
      });
      const done = (v: string) => { try { c.close(); } catch { /* already gone */ } resolve(v); };
      c.on("error", (err: Error) => done(`REFUSED ${err.message}`));
      c.connect(() => done("UPGRADED"));
      setTimeout(() => done("TIMED OUT"), 8000);
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const ON_THIS_GROUND = /more data after its STARTTLS response/;

describe("the STARTTLS boundary on the mail-sending path", () => {
  it("refuses when a partial line is left to be glued onto the encrypted session", async () => {
    // The exploitable shape. Without the refusal this run does not fail at all — the fragment is
    // simply carried across and prepended to whatever is read next.
    expect(await upgrade("partial-line")).toMatch(ON_THIS_GROUND);
  }, 20_000);

  it("refuses at the boundary when a whole extra response arrives with the go-ahead", async () => {
    expect(await upgrade("extra-response")).toMatch(ON_THIS_GROUND);
  }, 20_000);

  it("does not refuse on that ground when the server sends only the go-ahead", async () => {
    // The control that makes the two cases above mean something. The fake speaks no TLS, so this
    // run ends in a handshake failure either way — which is the point: all three runs reach the
    // same code, and only the injected ones must stop before the handshake. A refusal that fired
    // unconditionally, or one keyed on something other than the injected bytes, fails here.
    const verdict = await upgrade("clean");
    expect(verdict).not.toMatch(ON_THIS_GROUND);
  }, 20_000);
});
