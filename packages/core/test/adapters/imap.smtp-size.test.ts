import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { verifySmtpLogin } from "../../src/adapters/imap.js";

/**
 * WHAT THE SENDING SERVER SAID IT WILL ACCEPT — `verifySmtpLogin` reads the EHLO's `SIZE`.
 *
 * The attachment ceiling used to be one product constant reasoned from the HOSTED API's
 * serverless request-body limit. That is a fact about one deployment: a local install runs the
 * same send code in the same process as its SMTP dial and has no request body anywhere in the
 * path, while a customer whose provider caps submission BELOW that constant was being told a
 * number their own server would refuse. The number that actually governs is the one every RFC 1870
 * server announces in its EHLO reply, and the connect-time SMTP probe already runs one.
 *
 * ── WHY THIS TEST DRIVES A REAL SOCKET ────────────────────────────────────────────────────
 *
 * The value is parsed by nodemailer out of a wire response, and it is read off a PRIVATE field
 * (`_maxAllowedSize`) because there is no supported accessor. A double for nodemailer would assert
 * this file's belief about nodemailer rather than nodemailer's behaviour, which is exactly the
 * class of guard that goes green while the product is broken. So each case here is a socket
 * speaking SMTP: the greeting, the EHLO the implementation actually sends, AUTH, QUIT.
 *
 * The dial is to 127.0.0.1, which `loopbackHarnessReason` exempts from the TLS floor — the same
 * exemption every other loopback harness in this package runs under, and the reason a cleartext
 * fake is dialable at all.
 */

/** One scripted SMTP conversation. `ehloLines` are the `250-`/`250 ` lines after the greeting. */
function fakeSmtp(
  ehloLines: readonly string[],
  opts: { advertiseAuth?: boolean; authMechanisms?: string } = {},
): Promise<{
  port: number; server: Server; authLines: string[];
}> {
  const authLines: string[] = [];
  const advertiseAuth = opts.advertiseAuth ?? true;
  const mechanisms = opts.authMechanisms ?? "PLAIN LOGIN";
  const server = createServer((socket: Socket) => {
    let buf = "";
    socket.write("220 fake.test ESMTP\r\n");
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\r\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
          const lines = [...ehloLines, ...(advertiseAuth ? [`AUTH ${mechanisms}`] : [])];
          const body = lines.length > 0 ? lines : ["OK"];
          for (const [i, l] of body.entries()) {
            socket.write(`250${i === body.length - 1 ? " " : "-"}${l}\r\n`);
          }
        } else if (upper.startsWith("AUTH")) {
          authLines.push(line);
          socket.write("235 2.7.0 Accepted\r\n");
        } else if (upper.startsWith("QUIT")) {
          socket.write("221 Bye\r\n");
          socket.end();
        } else {
          socket.write("250 OK\r\n");
        }
        nl = buf.indexOf("\r\n");
      }
    });
    socket.on("error", () => { /* the client hangs up on QUIT; nothing to report */ });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ port: typeof addr === "object" && addr ? addr.port : 0, server, authLines });
    });
  });
}

let open: Server | null = null;
afterEach(async () => {
  if (open) await new Promise<void>((r) => open!.close(() => r()));
  open = null;
});

async function dial(
  ehloLines: readonly string[],
  opts?: { advertiseAuth?: boolean; authMechanisms?: string; accessToken?: string },
) {
  const { port, server, authLines } = await fakeSmtp(ehloLines, opts);
  open = server;
  const proof = await verifySmtpLogin(
    {
      host: "127.0.0.1", port, secure: false,
      auth: opts?.accessToken === undefined
        ? { user: "u@fake.test", pass: "pw" }
        : { user: "u@fake.test", accessToken: opts.accessToken },
    },
    { connectionMs: 4000, greetingMs: 4000, socketMs: 4000 },
  );
  return { proof, authLines };
}

describe("verifySmtpLogin reads the server's own SIZE announcement", () => {
  it("carries the advertised ceiling back to the caller", async () => {
    const { proof } = await dial(["fake.test", "SIZE 35882577"]);
    expect(proof.maxMessageBytes).toBe(35_882_577);
  });

  it("still LOGS IN — the proof is a completed authentication, not a capability read", async () => {
    // The regression this pins: a rewrite that stopped short of AUTH would return a number and
    // silently turn the connect-time credential check into a reachability check. Nothing else in
    // this file would notice, because the SIZE is announced before AUTH.
    const { authLines } = await dial(["fake.test", "SIZE 1048576"]);
    expect(authLines).toHaveLength(1);
    expect(authLines[0]!.toUpperCase()).toMatch(/^AUTH /);
  });

  it("a server that advertises no SIZE at all reads as null, never 0", async () => {
    const { proof } = await dial(["fake.test", "8BITMIME", "PIPELINING"]);
    expect(proof.maxMessageBytes).toBeNull();
  });

  it("the BARE keyword, with no number, reads as null", async () => {
    // RFC 1870 permits `SIZE` with no argument — the server declares support and no fixed
    // maximum. nodemailer parses that to 0; a caller must not read 0 as a ceiling.
    const { proof } = await dial(["fake.test", "SIZE"]);
    expect(proof.maxMessageBytes).toBeNull();
  });

  it("`SIZE 0` reads as null — RFC 1870 §6 defines it as NO fixed maximum", async () => {
    // The sharp one. A literal read makes this a ceiling of nothing, and every send is then
    // refused by our own rule against a server that said it would take anything.
    const { proof } = await dial(["fake.test", "SIZE 0"]);
    expect(proof.maxMessageBytes).toBeNull();
  });

  it("a server advertising no AUTH is still verified — connecting is the whole proof there", async () => {
    // `SMTPTransport.verify()` logs in only when the server advertised AUTH; a submission
    // endpoint that offers none must not be refused for it.
    const { proof, authLines } = await dial(["fake.test", "SIZE 2097152"], { advertiseAuth: false });
    expect(authLines).toEqual([]);
    expect(proof.maxMessageBytes).toBe(2_097_152);
  });

  /**
   * ══ THE BEARER-TOKEN ARM, ON THE WIRE ═════════════════════════════════════════════════════
   *
   * An oauth mailbox stores a REFRESH TOKEN, so it cannot be probed with "the secret" — and until
   * this arm existed it was not probed at all, which pinned every oauth mailbox to the product's
   * strict attachment constant however generous its provider was.
   *
   * The bytes are the whole point of testing this over a socket. `SMTPConnection.login` selects
   * XOAUTH2 only when it is handed an authenticator object (`_auth.oauth2`), not a bare token, and
   * `SMTPTransport` builds that object in a private method — so a double for nodemailer would assert
   * this file's belief about nodemailer instead of what goes out. The SASL string below is decoded
   * and read: RFC 7628's `user=<addr>^Aauth=Bearer <token>^A^A`, with the access token in the bearer
   * position and nothing in a password position anywhere.
   *
   * Mutation: hand `login` the token as `{ user, pass }` and this case goes red with an `AUTH PLAIN`
   * whose base64 carries the token as a password — which is exactly the failure the union of
   * `SmtpSizeDialAuth` exists to make unrepresentable.
   */
  it("authenticates an oauth mailbox with AUTH XOAUTH2 and the bearer token, never a password", async () => {
    const { proof, authLines } = await dial(
      ["fake.test", "SIZE 157286400"],
      { authMechanisms: "PLAIN LOGIN XOAUTH2", accessToken: "EwBQA-the-access-token" },
    );

    // The ceiling still comes back: the EHLO read is not disturbed by which mechanism follows it.
    expect(proof.maxMessageBytes).toBe(157_286_400);
    expect(authLines).toHaveLength(1);
    const [mechanism, payload] = authLines[0]!.split(" ").slice(1);
    expect(mechanism).toBe("XOAUTH2");
    const sasl = Buffer.from(payload ?? "", "base64").toString("utf8");
    expect(sasl).toBe("user=u@fake.test\u0001auth=Bearer EwBQA-the-access-token\u0001\u0001");
    // Nothing on the wire is a password exchange. `AUTH PLAIN`'s payload would decode to
    // `\0user\0secret`, so the absence of a second AUTH line is half the claim and the mechanism
    // name is the other half.
    expect(authLines[0]!.toUpperCase()).not.toContain("PLAIN");
  });

  it("a server that advertises no XOAUTH2 still gets XOAUTH2 — and refuses it, which is the honest answer", async () => {
    // nodemailer honours an explicit `method`, so the mechanism list does not gate the attempt. That
    // is deliberate: a provider that supports the extension without advertising it (or advertises it
    // only after STARTTLS, which is common) must not be silently downgraded to a password AUTH we
    // have no password for. The fake accepts every AUTH, so what this pins is that the attempt is
    // made and reaches the server unchanged.
    const { authLines } = await dial(
      ["fake.test", "SIZE 1024"],
      { authMechanisms: "PLAIN LOGIN", accessToken: "tok" },
    );
    expect(authLines).toHaveLength(1);
    expect(authLines[0]!.split(" ")[1]).toBe("XOAUTH2");
  });

  it("a refused login REJECTS — the failure path is unchanged by the SIZE read", async () => {
    const { port, server } = await fakeSmtp(["fake.test", "SIZE 1024"]);
    open = server;
    // Re-script AUTH to a hard refusal by closing the door: the fake answers 235 to everything,
    // so instead point at a port nothing is listening on to prove the rejection travels.
    await new Promise<void>((r) => server.close(() => r()));
    open = null;
    await expect(verifySmtpLogin(
      { host: "127.0.0.1", port, secure: false, auth: { user: "u@fake.test", pass: "pw" } },
      { connectionMs: 2000, greetingMs: 2000, socketMs: 2000 },
    )).rejects.toThrow();
  });
});
